import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findActivePr, getPr, type AdoClient, type PullRequest } from "./ado.js";
import { aihubDir, ensureDir } from "./aihubDir.js";
import { getThreads } from "./comments.js";
import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { currentBranch } from "./git.js";
import { latestPerDefinition, parseDuration, selectBuilds, type Build } from "./pipeline.js";
import { parsePrRef } from "./pr.js";

export type Until = "done" | "comment" | "vote";
export const UNTILS: Until[] = ["done", "comment", "vote"];

export interface WatchSpec {
  id: string;
  pr?: number;
  branch?: string;
  until: Until;
  notify: boolean;
  timeoutMs: number;
  intervalMs: number;
  started: number;
  pid?: number;
}

export interface Snapshot {
  prId?: number;
  prStatus?: string;
  builds: { id: number; name: string; number: string; state: string; done: boolean; bad: boolean }[];
  comments: number;
  votes: Record<string, number>;
}

export interface WatchEvent {
  kind: "build" | "comment" | "vote" | "pr" | "timeout";
  message: string;
}

const VOTE_NAME: Record<number, string> = { 10: "approved", 5: "approved with suggestions", 0: "no vote", [-5]: "waiting for the author", [-10]: "rejected" };

// ---- storage ------------------------------------------------------------------

export const watchDir = (root: string) => aihubDir(root, "watches");
export const eventsLog = (root: string) => aihubDir(root, "events.log");

export function writeSpec(root: string, spec: WatchSpec): void {
  ensureDir(watchDir(root));
  writeFileSync(join(watchDir(root), `${spec.id}.json`), JSON.stringify(spec), "utf8");
}

export function readSpecs(root: string): WatchSpec[] {
  const d = watchDir(root);
  if (!existsSync(d)) return [];
  const out: WatchSpec[] = [];
  for (const f of readdirSync(d).filter((x) => x.endsWith(".json"))) {
    try {
      out.push(JSON.parse(readFileSync(join(d, f), "utf8")) as WatchSpec);
    } catch {
      /* ignore a half written file */
    }
  }
  return out.sort((a, b) => a.started - b.started);
}

export const removeSpec = (root: string, id: string) => rmSync(join(watchDir(root), `${id}.json`), { force: true });

export function logEvent(root: string, at: number, label: string, message: string): void {
  ensureDir(aihubDir(root));
  appendFileSync(eventsLog(root), `${new Date(at).toISOString()}\t${label}\t${message}\n`, "utf8");
}

// ---- notification ---------------------------------------------------------------

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The OS command that shows a notification, or undefined when the platform has none. Exported for tests. */
export function notifyCommand(platform: NodeJS.Platform, title: string, message: string): { cmd: string; args: string[] } | undefined {
  if (platform === "win32") {
    const script =
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null;" +
      "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null;" +
      "$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);" +
      `$n = $x.GetElementsByTagName('text'); $n.Item(0).AppendChild($x.CreateTextNode(${psQuote(title)})) > $null; $n.Item(1).AppendChild($x.CreateTextNode(${psQuote(message)})) > $null;` +
      "$t = [Windows.UI.Notifications.ToastNotification]::new($x);" +
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('aihub').Show($t)";
    return { cmd: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script] };
  }
  if (platform === "darwin") {
    const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    return { cmd: "osascript", args: ["-e", `display notification ${q(message)} with title ${q(title)}`] };
  }
  if (platform === "linux") return { cmd: "notify-send", args: [title, message] };
  return undefined;
}

export type Notifier = (title: string, message: string) => boolean | Promise<boolean>;

/** Shows an OS notification; false when it could not be shown (the caller then prints the line). */
export const osNotify: Notifier = (title, message) => {
  const c = notifyCommand(process.platform, title, message);
  if (!c) return false;
  const r = spawnSync(c.cmd, c.args, { stdio: "ignore", timeout: 15_000 });
  return !r.error && r.status === 0;
};

// ---- snapshot and events --------------------------------------------------------

const stateOf = (b: Build) => (b.status === "completed" ? (b.result ?? "completed") : (b.status ?? "unknown"));

export async function takeSnapshot(client: AdoClient, root: string, spec: Pick<WatchSpec, "pr" | "branch">): Promise<Snapshot> {
  let prId = spec.pr;
  const branch = spec.branch ?? (prId ? undefined : currentBranch(root));
  let pr: (PullRequest & { reviewers?: { displayName?: string; vote?: number }[] }) | undefined;
  if (prId) pr = await getPr(client, prId);
  else if (branch) {
    const a = await findActivePr(client, branch);
    if (a) {
      prId = a.pullRequestId;
      pr = await getPr(client, prId);
    }
  }
  const sel = await selectBuilds(client, root, prId ? { pr: String(prId) } : { branch });
  const builds = latestPerDefinition(sel.builds).map((b) => ({
    id: b.id,
    name: b.definition?.name ?? "pipeline",
    number: b.buildNumber ?? String(b.id),
    state: stateOf(b),
    done: b.status === "completed",
    bad: b.status === "completed" && b.result !== "succeeded" && b.result !== "partiallySucceeded",
  }));
  let comments = 0;
  if (prId) for (const t of await getThreads(client, prId, undefined, true)) comments += t.comments.length;
  const votes: Record<string, number> = {};
  for (const r of pr?.reviewers ?? []) votes[r.displayName ?? "?"] = r.vote ?? 0;
  return { prId, prStatus: pr?.status, builds, comments, votes };
}

/** What changed between two snapshots. On the first look only an already finished state counts (until done). */
export function diffSnapshots(prev: Snapshot | undefined, cur: Snapshot, until: Until = "done"): WatchEvent[] {
  const ev: WatchEvent[] = [];
  const label = cur.prId ? `PR !${cur.prId}` : "branch";
  if (!prev) {
    if (until === "done" && cur.builds.length && cur.builds.every((b) => b.done)) {
      ev.push({ kind: "build", message: `${label}: pipelines already finished: ${cur.builds.map((b) => `${b.name} ${b.state}`).join(", ")}` });
    }
    return ev;
  }
  for (const b of cur.builds) {
    const was = prev.builds.find((x) => x.id === b.id);
    if (b.done && !was?.done) ev.push({ kind: "build", message: `${label}: ${b.name} #${b.number} finished: ${b.state}` });
  }
  if (cur.comments > prev.comments) ev.push({ kind: "comment", message: `${label}: ${cur.comments - prev.comments} new comment(s)` });
  for (const [who, vote] of Object.entries(cur.votes)) {
    if ((prev.votes[who] ?? 0) !== vote) ev.push({ kind: "vote", message: `${label}: ${who} voted ${VOTE_NAME[vote] ?? vote}` });
  }
  if (prev.prStatus === "active" && cur.prStatus && cur.prStatus !== "active") ev.push({ kind: "pr", message: `${label} is now ${cur.prStatus}` });
  return ev;
}

export function reachedUntil(until: Until, events: WatchEvent[], cur: Snapshot): boolean {
  if (cur.prStatus && cur.prStatus !== "active") return true;
  if (until === "comment") return events.some((e) => e.kind === "comment");
  if (until === "vote") return events.some((e) => e.kind === "vote");
  return cur.builds.length > 0 && cur.builds.every((b) => b.done);
}

// ---- the poller -------------------------------------------------------------------

export interface RunDeps {
  notifier?: Notifier;
}

/** Polls until the condition, the PR is closed or the timeout. Logs every event; notifies when asked. */
export async function runWatch(ctx: Ctx, spec: WatchSpec, deps: RunDeps = {}): Promise<{ reason: string; events: WatchEvent[] }> {
  const { root, client } = repoClient(ctx);
  const now = ctx.now ?? Date.now;
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const notifier = deps.notifier ?? osNotify;
  const all: WatchEvent[] = [];
  const start = now();
  let prev: Snapshot | undefined;
  let failures = 0;
  const emit = async (e: WatchEvent, label: string) => {
    all.push(e);
    logEvent(root, now(), label, e.message);
    if (spec.notify && !(await notifier("aihub", e.message))) ctx.out(e.message);
  };
  const label = spec.pr ? `pr/${spec.pr}` : `branch/${spec.branch ?? "current"}`;
  for (;;) {
    try {
      const cur = await takeSnapshot(client, root, spec);
      failures = 0;
      const events = diffSnapshots(prev, cur, spec.until);
      for (const e of events) await emit(e, label);
      prev = cur;
      if (reachedUntil(spec.until, events, cur)) return { reason: events.length ? events[events.length - 1].message : "done", events: all };
    } catch (e) {
      if (++failures >= 5) {
        await emit({ kind: "timeout", message: `watch stopped: ${(e as Error).message}` }, label);
        return { reason: "error", events: all };
      }
    }
    if (now() - start >= spec.timeoutMs) {
      await emit({ kind: "timeout", message: `watch timed out after ${Math.round(spec.timeoutMs / 60000)} min without the expected event` }, label);
      return { reason: "timeout", events: all };
    }
    await sleep(spec.intervalMs);
  }
}

// ---- start, list, stop ----------------------------------------------------------------

export type Spawner = (root: string, id: string) => number | undefined;

/** Starts `aihub watch _run --id ID` detached; no daemon stays behind (the process ends with the watch). */
export const spawnDetached: Spawner = (root, id) => {
  const child = spawn(process.execPath, [process.argv[1], "watch", "_run", "--id", id], { cwd: root, detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  return child.pid;
};

export const isAlive = (pid: number | undefined): boolean => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

export interface StartOpts {
  pr?: string;
  branch?: string;
  until?: string;
  notify?: boolean;
  timeout?: string;
  interval?: string;
  json?: boolean;
}

export function startWatch(ctx: Ctx, o: StartOpts, spawner: Spawner = spawnDetached, alive: (pid?: number) => boolean = isAlive): string {
  const { root } = repoClient(ctx);
  const until = (o.until ?? "done") as Until;
  if (!UNTILS.includes(until)) throw new AihubError(`--until must be one of ${UNTILS.join(", ")}`);
  if (o.pr && o.branch) throw new AihubError("pass --pr or --branch, not both");
  const pr = o.pr ? parsePrRef(o.pr) : undefined;
  const branch = pr ? undefined : (o.branch ?? currentBranch(root));
  const dup = readSpecs(root).find((s) => alive(s.pid) && s.pr === pr && s.branch === branch && s.until === until);
  const target = pr ? `PR !${pr}` : `branch ${branch}`;
  if (dup) return o.json ? JSON.stringify({ id: dup.id, existing: true }) : `already watching ${target} (watch ${dup.id}); stop it with: aihub watch stop --id ${dup.id}`;
  const now = (ctx.now ?? Date.now)();
  const spec: WatchSpec = {
    id: `${now.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`,
    pr,
    branch,
    until,
    notify: !!o.notify,
    timeoutMs: parseDuration(o.timeout, 2 * 3_600_000),
    intervalMs: parseDuration(o.interval ?? "30s", 30_000),
    started: now,
  };
  writeSpec(root, spec);
  spec.pid = spawner(root, spec.id);
  writeSpec(root, spec);
  const how = `until ${until}${spec.notify ? ", with notification" : ""}; events go to .git/aihub/events.log`;
  return o.json ? JSON.stringify({ id: spec.id, pid: spec.pid, target, until }) : `watching ${target} in the background (${how}). List: aihub watch list. Stop: aihub watch stop --id ${spec.id}`;
}

export function listWatches(ctx: Ctx, o: { json?: boolean }, alive: (pid?: number) => boolean = isAlive): string {
  const { root } = repoClient(ctx);
  const rows: { spec: WatchSpec; alive: boolean }[] = [];
  for (const s of readSpecs(root)) {
    const a = alive(s.pid);
    if (!a) removeSpec(root, s.id); // the watch ended without cleaning up
    else rows.push({ spec: s, alive: a });
  }
  if (o.json) return JSON.stringify(rows.map((r) => r.spec));
  if (!rows.length) return "no running watches";
  return rows
    .map(({ spec: s }) => `${s.id}  ${s.pr ? `PR !${s.pr}` : `branch ${s.branch}`}  until ${s.until}${s.notify ? "  notify" : ""}  pid ${s.pid}  since ${new Date(s.started).toISOString().slice(0, 16).replace("T", " ")}`)
    .join("\n");
}

export function stopWatches(ctx: Ctx, o: { id?: string; json?: boolean }, kill: (pid: number) => void = (p) => process.kill(p)): string {
  const { root } = repoClient(ctx);
  const specs = readSpecs(root).filter((s) => !o.id || s.id === o.id);
  if (o.id && !specs.length) throw new AihubError(`no watch '${o.id}' (see aihub watch list)`);
  for (const s of specs) {
    try {
      if (s.pid) kill(s.pid);
    } catch {
      /* already gone */
    }
    removeSpec(root, s.id);
  }
  return o.json ? JSON.stringify({ stopped: specs.map((s) => s.id) }) : specs.length ? `stopped ${specs.length} watch(es): ${specs.map((s) => s.id).join(", ")}` : "no running watches";
}

/** The detached process: aihub watch _run --id ID. */
export async function runDetached(ctx: Ctx, id: string): Promise<void> {
  const { root } = repoClient(ctx);
  const spec = readSpecs(root).find((s) => s.id === id);
  if (!spec) throw new AihubError(`watch '${id}' not found`);
  try {
    await runWatch(ctx, spec);
  } finally {
    removeSpec(root, id);
  }
}
