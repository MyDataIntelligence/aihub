import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findActivePr, getPr, type AdoClient, type PullRequest } from "./ado.js";
import { aihubDir, ensureDir } from "./aihubDir.js";
import { getThreads } from "./comments.js";
import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { currentBranch } from "./git.js";
import { detectClient, eventUrl, storeEvent, type Client } from "./open.js";
import { failedSteps, latestPerDefinition, parseDuration, selectBuilds, type Build } from "./pipeline.js";
import { parsePrRef } from "./pr.js";

export type Until = "done" | "comment" | "vote";
export const UNTILS: Until[] = ["done", "comment", "vote"];

import { parseFabricJob, sameTarget, targetLabel, type RunTarget } from "./watchRun.js";
import { parseRunRef } from "./pipeline.js";

export interface WatchSpec {
  /** `watch --run|--robot|--fabric-job`: one long run to follow, not a PR or branch. */
  target?: RunTarget;
  id: string;
  pr?: number;
  branch?: string;
  until: Until;
  /** `aihub watch --mine`: everything that needs me, not one PR or branch. */
  mine?: boolean;
  /** `--mine` only: report what already exists on the first look instead of just recording it. */
  includeExisting?: boolean;
  notify: boolean;
  timeoutMs: number;
  intervalMs: number;
  started: number;
  pid?: number;
  /** Where to come back to: the repository, the agent client and (when known) its session id. */
  repo?: string;
  client?: Client;
  session?: string;
}

export interface Snapshot {
  prId?: number;
  prStatus?: string;
  builds: { id: number; name: string; number: string; state: string; done: boolean; bad: boolean; failed?: string }[];
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
export function notifyCommand(platform: NodeJS.Platform, title: string, message: string, action?: NotifyAction): { cmd: string; args: string[] } | undefined {
  if (platform === "win32" && action) {
    const xe = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const xml =
      `<toast launch="${xe(action.url)}" activationType="protocol"><visual><binding template="ToastGeneric"><text>${xe(title)}</text><text>${xe(message)}</text></binding></visual>` +
      `<actions><action content="${xe(action.label)}" arguments="${xe(action.url)}" activationType="protocol"/></actions></toast>`;
    const script =
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null;" +
      "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null;" +
      `$x = [Windows.Data.Xml.Dom.XmlDocument]::new(); $x.LoadXml(${psQuote(xml)});` +
      "$t = [Windows.UI.Notifications.ToastNotification]::new($x);" +
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('aihub').Show($t)";
    return { cmd: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script] };
  }
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

/** The "Open" button of a notification: clicking it runs `aihub open` through the aihub:// link. */
export interface NotifyAction {
  label: string;
  url: string;
}

export type Notifier = (title: string, message: string, action?: NotifyAction) => boolean | Promise<boolean>;

/** Shows an OS notification; false when it could not be shown (the caller then prints the line). */
export const osNotify: Notifier = (title, message, action) => {
  const c = notifyCommand(process.platform, title, message, action);
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
  const builds = [];
  for (const b of latestPerDefinition(sel.builds)) {
    const bad = b.status === "completed" && b.result !== "succeeded" && b.result !== "partiallySucceeded";
    let failed: string | undefined;
    if (bad) {
      try {
        const s = (await failedSteps(client, b.id))[0];
        if (s) failed = s.stage ? `${s.stage} / ${s.step}` : s.step;
      } catch {
        /* the message just has no stage */
      }
    }
    builds.push({
      id: b.id,
      name: b.definition?.name ?? "pipeline",
      number: b.buildNumber ?? String(b.id),
      state: stateOf(b),
      done: b.status === "completed",
      bad,
      failed,
    });
  }
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
      ev.push({ kind: "build", message: `${label}: pipelines already finished: ${cur.builds.map((b) => `${b.name} ${b.state}${b.failed ? ` in ${b.failed}` : ""}`).join(", ")}` });
    }
    return ev;
  }
  for (const b of cur.builds) {
    const was = prev.builds.find((x) => x.id === b.id);
    if (b.done && !was?.done) ev.push({ kind: "build", message: `${label}: ${b.name} #${b.number} finished: ${b.state}${b.failed ? ` in ${b.failed}` : ""}` });
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
  let seq = 0;
  const emit = async (e: WatchEvent, label: string) => {
    all.push(e);
    logEvent(root, now(), label, e.message);
    // every event can be reopened: aihub open --event <id> (also from the notification button)
    const id = `${spec.id}-${++seq}`;
    storeEvent(ctx.env, { id, repo: spec.repo ?? root, client: spec.client, session: spec.session, message: e.message, prompt: `${e.message} — ga verder`, at: now() });
    if (spec.notify && !(await notifier("aihub", e.message, { label: "Open", url: eventUrl(id) }))) ctx.out(`${e.message}\n  open it with: aihub open --event ${id}`);
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
  client?: string;
  session?: string;
  json?: boolean;
  /** A pipeline run id (or build link), a Robot build id, or `<workspace>/<item>/<job id>`. */
  run?: string;
  robot?: string;
  fabricJob?: string;
}

export function startWatch(
  ctx: Ctx,
  o: StartOpts,
  spawner: Spawner = spawnDetached,
  alive: (pid?: number) => boolean = isAlive,
  register: () => boolean = () => false,
): string {
  if (o.run || o.robot || o.fabricJob) return startRunWatch(ctx, o, spawner, alive, register);
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
    timeoutMs: parseDuration(o.timeout, 2 * 3_600_000, { flag: "--timeout", unitRequired: true }),
    intervalMs: parseDuration(o.interval ?? "30s", 30_000, { flag: "--interval", unitRequired: true }),
    started: now,
    repo: root,
    client: detectClient(ctx.env, o.client),
    session: o.session ?? ctx.env.AIHUB_SESSION_ID,
  };
  if (spec.notify) register(); // aihub:// link for the notification's Open button (per user, no admin)
  writeSpec(root, spec);
  spec.pid = spawner(root, spec.id);
  writeSpec(root, spec);
  const how = `until ${until}${spec.notify ? ", with notification" : ""}; events go to .git/aihub/events.log`;
  return o.json ? JSON.stringify({ id: spec.id, pid: spec.pid, target, until }) : `watching ${target} in the background (${how}). List: aihub watch list. Stop: aihub watch stop --id ${spec.id}`;
}

function startRunWatch(ctx: Ctx, o: StartOpts, spawner: Spawner, alive: (pid?: number) => boolean, register: () => boolean): string {
  const { root } = repoClient(ctx);
  if ([o.run, o.robot, o.fabricJob].filter(Boolean).length > 1) throw new AihubError("pass one of --run, --robot or --fabric-job");
  if (o.pr || o.branch) throw new AihubError("--run, --robot and --fabric-job follow one run; do not combine them with --pr or --branch");
  const target: RunTarget = o.fabricJob ? parseFabricJob(o.fabricJob) : { kind: o.robot ? "robot" : "run", build: parseRunRef((o.robot ?? o.run)!) };
  const label = targetLabel(target);
  const dup = readSpecs(root).find((s) => alive(s.pid) && sameTarget(s.target, target));
  if (dup) return o.json ? JSON.stringify({ id: dup.id, existing: true }) : `already following ${label} (watch ${dup.id}); stop it with: aihub watch stop --id ${dup.id}`;
  const now = (ctx.now ?? Date.now)();
  const spec: WatchSpec = {
    id: `${now.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`,
    until: "done",
    target,
    notify: !!o.notify,
    timeoutMs: parseDuration(o.timeout, 4 * 3_600_000, { flag: "--timeout", unitRequired: true }),
    intervalMs: parseDuration(o.interval ?? "30s", 30_000, { flag: "--interval", unitRequired: true }),
    started: now,
    repo: root,
    client: detectClient(ctx.env, o.client),
    session: o.session ?? ctx.env.AIHUB_SESSION_ID,
  };
  if (spec.notify) register();
  writeSpec(root, spec);
  spec.pid = spawner(root, spec.id);
  writeSpec(root, spec);
  const how = `${spec.notify ? "toast when it ends, with a Fix button on failure" : "no toast"}; events go to .git/aihub/events.log`;
  return o.json ? JSON.stringify({ id: spec.id, pid: spec.pid, target: label }) : `following ${label} in the background (${how}). List: aihub watch list. Stop: aihub watch stop --id ${spec.id}`;
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
    .map(({ spec: s }) => {
      const what = s.target ? targetLabel(s.target) : s.mine ? `all my PRs, mentions and reviews, every ${Math.round(s.intervalMs / 1000)} s` : `${s.pr ? `PR !${s.pr}` : `branch ${s.branch}`}  until ${s.until}`;
      return `${s.id}  ${what}${s.notify ? "  notify" : ""}  pid ${s.pid}  since ${new Date(s.started).toISOString().slice(0, 16).replace("T", " ")}`;
    })
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
    if (spec.target) await (await import("./watchRun.js")).runTargetWatch(ctx, spec);
    else await runWatch(ctx, spec);
  } finally {
    removeSpec(root, id);
  }
}
