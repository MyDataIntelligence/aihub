import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { AdoClient } from "./ado.js";
import { aihubDir, ensureDir } from "./aihubDir.js";
import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { detectClient, eventUrl, storeEvent } from "./open.js";
import { parseDuration } from "./pipeline.js";
import { loadTeam } from "./team.js";
import { isAlive, logEvent, osNotify, readSpecs, removeSpec, spawnDetached, writeSpec, type Notifier, type Spawner, type WatchSpec } from "./watch.js";

/**
 * `aihub watch --mine`: one poller over every active pull request where the signed-in user is author or reviewer,
 * plus work-item comments that mention them. It raises an event (log line, stored event, optional toast) for
 * everything that needs a reaction, once per event id.
 */
export const MINE_ID = "mine";

export type MineKind = "thread" | "mention" | "workitem-mention" | "review" | "vote" | "policy" | "pr";

export interface MineEvent {
  /** Stable id: the same thing is never reported twice. */
  id: string;
  kind: MineKind;
  message: string;
}

export interface MineState {
  version: 1;
  /** event id -> epoch ms when it was reported (or silently recorded by the first look) */
  seen: Record<string, number>;
  /** my active PRs, "<repoId>/<prId>" -> status, to notice completed/abandoned */
  prs: Record<string, string>;
  started: number;
}

export interface Me {
  id: string;
  name: string;
}

const VOTE_NAME: Record<number, string> = { 10: "approved", 5: "approved with suggestions", [-5]: "is waiting for you (waiting for the author)", [-10]: "rejected" };
const PREVIEW = { "api-version": "7.1-preview.1" };
const KEEP_MS = 30 * 24 * 3_600_000;
const MAX_WORK_ITEMS = 25;

// ---- state -------------------------------------------------------------------------------------

export const stateFile = (root: string) => join(aihubDir(root, "watch-state"), `${MINE_ID}.json`);

export function readState(root: string): MineState | undefined {
  const f = stateFile(root);
  if (!existsSync(f)) return undefined;
  try {
    const s = JSON.parse(readFileSync(f, "utf8")) as MineState;
    return s.version === 1 ? s : undefined;
  } catch {
    return undefined;
  }
}

export function writeState(root: string, s: MineState): void {
  ensureDir(aihubDir(root, "watch-state"));
  writeFileSync(stateFile(root), JSON.stringify(s), "utf8");
}

// ---- Azure DevOps shapes (only what is used) ---------------------------------------------------------

interface Identity {
  id?: string;
  displayName?: string;
}
interface RawPr {
  pullRequestId: number;
  title: string;
  status: string;
  isDraft?: boolean;
  createdBy?: Identity;
  reviewers?: (Identity & { vote?: number })[];
  repository?: { id: string; name: string; project?: { id: string } };
}
interface RawComment {
  id: number;
  content?: string;
  commentType?: string;
  isDeleted?: boolean;
  author?: Identity;
}
interface RawThread {
  id: number;
  status?: string;
  isDeleted?: boolean;
  comments?: RawComment[];
}
interface RawEvaluation {
  evaluationId: string;
  status: string;
  completedDate?: string;
  configuration?: { isEnabled?: boolean; isBlocking?: boolean; type?: { displayName?: string }; settings?: { displayName?: string } };
}

const same = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const clip = (t: string | undefined, n = 80) => {
  const s = (t ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

export async function whoAmI(client: AdoClient): Promise<Me> {
  const r = await client.getOrg<{ authenticatedUser?: { id?: string; providerDisplayName?: string; customDisplayName?: string } }>("connectionData");
  const u = r.authenticatedUser;
  if (!u?.id) throw new AihubError("could not find who you are in Azure DevOps (sign in with 'az login' or set AIHUB_ADO_PAT)");
  return { id: u.id, name: u.customDisplayName || u.providerDisplayName || "" };
}

/** Does this text (PR comment `@<guid>`, work item HTML mention, or `@Name`) mention me? */
export function mentionsMe(text: string | undefined, me: Me): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  if (t.includes(me.id.toLowerCase())) return true;
  return !!me.name && t.includes(`@${me.name.toLowerCase()}`);
}

// ---- one poll ----------------------------------------------------------------------------------------

export interface PollOpts {
  /** Only these repositories (names, from team.yaml); empty = every repository of the project. */
  repos?: string[];
}

interface Found {
  pr: RawPr;
  mine: boolean;
  reviewer: boolean;
}

async function myPrs(client: AdoClient, me: Me, repos: string[]): Promise<Found[]> {
  const q = { "searchCriteria.status": "active" };
  const [created, reviewing] = await Promise.all([
    client.list<RawPr>("git/pullrequests", { ...q, "searchCriteria.creatorId": me.id }),
    client.list<RawPr>("git/pullrequests", { ...q, "searchCriteria.reviewerId": me.id }),
  ]);
  const byKey = new Map<string, Found>();
  const add = (pr: RawPr, mine: boolean, reviewer: boolean) => {
    if (repos.length && !repos.some((r) => same(r, pr.repository?.name))) return;
    const key = `${pr.repository?.id}/${pr.pullRequestId}`;
    const cur = byKey.get(key);
    byKey.set(key, { pr, mine: (cur?.mine ?? false) || mine, reviewer: (cur?.reviewer ?? false) || reviewer });
  };
  for (const pr of created) add(pr, true, false);
  for (const pr of reviewing) add(pr, same(pr.createdBy?.id, me.id), true);
  return [...byKey.values()];
}

const prLabel = (pr: RawPr) => `!${pr.pullRequestId} "${clip(pr.title, 50)}" (${pr.repository?.name ?? "?"})`;

async function threadEvents(client: AdoClient, me: Me, f: Found): Promise<MineEvent[]> {
  const { pr } = f;
  const repo = pr.repository!.id;
  const threads = await client.list<RawThread>(`git/repositories/${repo}/pullRequests/${pr.pullRequestId}/threads`);
  const out: MineEvent[] = [];
  for (const t of threads) {
    if (t.isDeleted) continue;
    const comments = (t.comments ?? []).filter((c) => !c.isDeleted && (c.commentType ?? "text") !== "system");
    if (!comments.length) continue;
    const base = `${repo}:${pr.pullRequestId}:${t.id}`;
    let mentioned = false;
    for (const c of comments) {
      if (same(c.author?.id, me.id) || !mentionsMe(c.content, me)) continue;
      mentioned = mentioned || c.id === comments[comments.length - 1].id;
      out.push({ id: `mention:${base}:${c.id}`, kind: "mention", message: `${c.author?.displayName ?? "Someone"} mentioned you on PR ${prLabel(pr)}: ${clip(c.content)}` });
    }
    const last = comments[comments.length - 1];
    if (same(last.author?.id, me.id) || mentioned) continue;
    const open = !t.status || t.status === "active" || t.status === "pending";
    const iTookPart = comments.some((c) => same(c.author?.id, me.id));
    if (!open || !(f.mine || iTookPart)) continue;
    const verb = iTookPart && comments.length > 1 ? "replied to your comment" : "commented";
    out.push({ id: `thread:${base}:${last.id}`, kind: "thread", message: `${last.author?.displayName ?? "Someone"} ${verb} on PR ${prLabel(pr)}: ${clip(last.content)}` });
  }
  return out;
}

async function policyEvents(client: AdoClient, f: Found): Promise<MineEvent[]> {
  const { pr } = f;
  const project = pr.repository?.project?.id;
  if (!project) return [];
  const raw = await client.list<RawEvaluation>("policy/evaluations", { artifactId: `vstfs:///CodeReview/CodeReviewId/${project}/${pr.pullRequestId}`, ...PREVIEW });
  const out: MineEvent[] = [];
  for (const e of raw) {
    if (e.configuration?.isEnabled === false || (e.status !== "rejected" && e.status !== "broken")) continue;
    const type = e.configuration?.type?.displayName ?? "Policy";
    const extra = e.configuration?.settings?.displayName;
    const name = extra && extra !== type ? `${type} (${extra})` : type;
    out.push({ id: `policy:${pr.repository!.id}:${pr.pullRequestId}:${e.evaluationId}:${e.completedDate ?? e.status}`, kind: "policy", message: `${name} ${e.status === "broken" ? "is broken" : "failed"} on your PR ${prLabel(pr)}` });
  }
  return out;
}

function prLevelEvents(me: Me, f: Found): MineEvent[] {
  const { pr } = f;
  const out: MineEvent[] = [];
  const repo = pr.repository!.id;
  const mineReviewer = (pr.reviewers ?? []).find((r) => same(r.id, me.id));
  if (!f.mine && mineReviewer && (mineReviewer.vote ?? 0) === 0) {
    out.push({ id: `review:${repo}:${pr.pullRequestId}`, kind: "review", message: `${pr.createdBy?.displayName ?? "Someone"} requested your review on PR ${prLabel(pr)}` });
  }
  if (f.mine) {
    for (const r of pr.reviewers ?? []) {
      const v = r.vote ?? 0;
      if (!v || same(r.id, me.id)) continue;
      out.push({ id: `vote:${repo}:${pr.pullRequestId}:${r.id}:${v}`, kind: "vote", message: `${r.displayName ?? "A reviewer"} ${VOTE_NAME[v] ?? `voted ${v}`} on your PR ${prLabel(pr)}` });
    }
  }
  return out;
}

async function workItemEvents(client: AdoClient, me: Me): Promise<MineEvent[]> {
  const wiql = await client.post<{ workItems?: { id: number }[] }>("wit/wiql", {
    query:
      "SELECT [System.Id] FROM WorkItems WHERE ([System.AssignedTo] = @Me OR [System.CreatedBy] = @Me) AND [System.ChangedDate] >= @Today - 14 ORDER BY [System.ChangedDate] DESC",
  });
  const out: MineEvent[] = [];
  for (const w of (wiql.workItems ?? []).slice(0, MAX_WORK_ITEMS)) {
    const r = await client.get<{ comments?: { id: number; text?: string; createdBy?: Identity }[] }>(`wit/workItems/${w.id}/comments`, { "api-version": "7.1-preview.4", $top: 50 });
    for (const c of r.comments ?? []) {
      if (same(c.createdBy?.id, me.id) || !mentionsMe(c.text, me)) continue;
      out.push({ id: `wimention:${w.id}:${c.id}`, kind: "workitem-mention", message: `${c.createdBy?.displayName ?? "Someone"} mentioned you on work item ${w.id}: ${clip(c.text)}` });
    }
  }
  return out;
}

/**
 * One look at everything. Returns every event currently true (not yet filtered by what was seen) and the new map of
 * my active PRs. Events about PRs that are no longer active come from `state.prs`.
 */
export async function pollMine(client: AdoClient, me: Me, state: MineState, o: PollOpts = {}): Promise<{ events: MineEvent[]; prs: Record<string, string> }> {
  const found = await myPrs(client, me, o.repos ?? []);
  const events: MineEvent[] = [];
  const prs: Record<string, string> = {};
  for (const f of found) {
    const key = `${f.pr.repository!.id}/${f.pr.pullRequestId}`;
    if (f.mine) prs[key] = "active";
    events.push(...prLevelEvents(me, f));
    events.push(...(await threadEvents(client, me, f)));
    if (f.mine) events.push(...(await policyEvents(client, f)));
  }
  // my PRs that were active last time and are not any more: completed or abandoned
  for (const key of Object.keys(state.prs)) {
    if (prs[key]) continue;
    const [repo, id] = key.split("/");
    try {
      const pr = await client.get<RawPr>(`git/repositories/${repo}/pullrequests/${id}`);
      if (pr.status && pr.status !== "active") events.push({ id: `pr:${key}:${pr.status}`, kind: "pr", message: `Your PR ${prLabel(pr)} is now ${pr.status}` });
      else prs[key] = "active";
    } catch {
      prs[key] = "active"; // cannot tell now: ask again next time
    }
  }
  events.push(...(await workItemEvents(client, me)));
  return { events, prs };
}

/** Marks `events` as seen and returns the ones not seen before. `first` records without reporting (the backlog). */
export function newEvents(state: MineState, events: MineEvent[], now: number, first: boolean): MineEvent[] {
  const fresh: MineEvent[] = [];
  for (const e of events) {
    if (state.seen[e.id] !== undefined) continue;
    state.seen[e.id] = now;
    if (!first) fresh.push(e);
  }
  for (const [id, at] of Object.entries(state.seen)) if (now - at > KEEP_MS) delete state.seen[id];
  return fresh;
}

// ---- the poller --------------------------------------------------------------------------------------

export interface MineDeps {
  notifier?: Notifier;
  /** Stop after this many polls (tests); undefined = run until the process is stopped. */
  maxPolls?: number;
  includeExisting?: boolean;
}

export async function runMine(ctx: Ctx, spec: WatchSpec, deps: MineDeps = {}): Promise<{ polls: number; reported: MineEvent[] }> {
  const { root, client } = repoClient(ctx);
  const now = ctx.now ?? Date.now;
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const notifier = deps.notifier ?? osNotify;
  const repos = ((loadTeam(root).repositories ?? []) as { name?: string }[]).map((r) => r.name).filter((n): n is string => !!n);
  const me = await whoAmI(client);
  let state = readState(root);
  const first = !state;
  state ??= { version: 1, seen: {}, prs: {}, started: now() };
  const reported: MineEvent[] = [];
  let failures = 0;
  let polls = 0;
  let seq = 0;
  for (;;) {
    try {
      const { events, prs } = await pollMine(client, me, state, { repos });
      const fresh = newEvents(state, events, now(), first && polls === 0 && !(deps.includeExisting ?? spec.includeExisting));
      state.prs = prs;
      writeState(root, state);
      failures = 0;
      for (const e of fresh) {
        reported.push(e);
        logEvent(root, now(), `mine/${e.kind}`, e.message);
        const id = `${spec.id}-${now().toString(36)}-${++seq}`;
        storeEvent(ctx.env, { id, repo: spec.repo ?? root, client: spec.client, session: spec.session, message: e.message, prompt: `${e.message} — ga verder`, at: now() });
        if (spec.notify && !(await notifier("aihub", e.message, { label: "Open", url: eventUrl(id) }))) ctx.out(`${e.message}\n  open it with: aihub open --event ${id}`);
      }
    } catch (e) {
      if (++failures >= 5) {
        logEvent(root, now(), "mine/stopped", `watch --mine stopped: ${(e as Error).message}`);
        throw e;
      }
    }
    polls++;
    if (deps.maxPolls !== undefined && polls >= deps.maxPolls) return { polls, reported };
    await sleep(spec.intervalMs);
  }
}

// ---- start / stop -------------------------------------------------------------------------------------

export interface StartMineOpts {
  notify?: boolean;
  interval?: string;
  client?: string;
  session?: string;
  includeExisting?: boolean;
  json?: boolean;
}

export function startMine(
  ctx: Ctx,
  o: StartMineOpts,
  spawner: Spawner = spawnDetached,
  alive: (pid?: number) => boolean = isAlive,
  register: () => boolean = () => false,
): string {
  const { root } = repoClient(ctx);
  const dup = readSpecs(root).find((s) => s.id === MINE_ID);
  if (dup && alive(dup.pid)) {
    return o.json ? JSON.stringify({ id: MINE_ID, existing: true }) : `already watching everything that needs you (watch ${MINE_ID}); stop it with: aihub watch stop --id ${MINE_ID}`;
  }
  const now = (ctx.now ?? Date.now)();
  const spec: WatchSpec = {
    id: MINE_ID,
    mine: true,
    includeExisting: !!o.includeExisting,
    until: "done",
    notify: !!o.notify,
    timeoutMs: Number.MAX_SAFE_INTEGER,
    intervalMs: parseDuration(o.interval ?? "2m", 120_000, { flag: "--interval", unitRequired: true }),
    started: now,
    repo: root,
    client: detectClient(ctx.env, o.client),
    session: o.session ?? ctx.env.AIHUB_SESSION_ID,
  };
  if (spec.notify) register();
  writeSpec(root, spec);
  spec.pid = spawner(root, spec.id);
  writeSpec(root, spec);
  const how = `every ${Math.round(spec.intervalMs / 1000)} s${spec.notify ? ", with notification" : ""}; events go to .git/aihub/events.log`;
  return o.json ? JSON.stringify({ id: MINE_ID, pid: spec.pid }) : `watching your pull requests and mentions in the background (${how}). List: aihub watch list. Stop: aihub watch stop --id ${MINE_ID}`;
}

/** The detached process: aihub watch _run --id mine. */
export async function runDetachedMine(ctx: Ctx): Promise<void> {
  const { root } = repoClient(ctx);
  const spec = readSpecs(root).find((s) => s.id === MINE_ID);
  if (!spec) throw new AihubError("watch 'mine' not found (start it with 'aihub watch --mine')");
  try {
    await runMine(ctx, spec);
  } finally {
    removeSpec(root, MINE_ID);
  }
}

// ---- start at logon (Windows, per user, no admin) --------------------------------------------------------

export const LOGON_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
export const LOGON_NAME = "aihub-watch-mine";
export type RegRunner = (args: string[]) => { status: number | null };

const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function logonCommand(root: string, node: string, cli: string, interval: string): string {
  return `powershell.exe -NoProfile -WindowStyle Hidden -Command "Set-Location -LiteralPath ${psq(root)}; & ${psq(node)} ${psq(cli)} watch --mine --notify --interval ${interval}"`;
}

const defaultReg: RegRunner = (args) => spawnSync("reg", args, { stdio: "ignore" });

export function registerAtLogon(ctx: Ctx, interval = "2m", platform: NodeJS.Platform = process.platform, node = process.execPath, cli = process.argv[1], reg: RegRunner = defaultReg): string {
  if (platform !== "win32") throw new AihubError("--at-logon registers a Windows Run entry; on macOS/Linux start 'aihub watch --mine --notify' from a login item, cron @reboot or a systemd user unit");
  const { root } = repoClient(ctx);
  parseDuration(interval, 0, { flag: "--interval", unitRequired: true });
  const r = reg(["add", LOGON_KEY, "/v", LOGON_NAME, "/t", "REG_SZ", "/d", logonCommand(root, node, cli, interval), "/f"]);
  if (r.status !== 0) throw new AihubError("could not write the Run entry (HKCU\\...\\Run)");
  return `will start at logon (Run entry ${LOGON_NAME}); remove it with: aihub watch --remove-at-logon`;
}

export function removeAtLogon(platform: NodeJS.Platform = process.platform, reg: RegRunner = defaultReg): string {
  if (platform !== "win32") throw new AihubError("--remove-at-logon only applies to the Windows Run entry");
  const r = reg(["delete", LOGON_KEY, "/v", LOGON_NAME, "/f"]);
  return r.status === 0 ? `removed the Run entry ${LOGON_NAME}` : `no Run entry ${LOGON_NAME} to remove`;
}
