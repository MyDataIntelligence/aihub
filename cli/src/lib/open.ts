import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";

export const CLIENTS = ["opencode", "codex", "claude", "copilot"] as const;
export type Client = (typeof CLIENTS)[number];

export interface OpenEvent {
  id: string;
  repo: string;
  client?: Client;
  session?: string;
  message: string;
  /** First message for the resumed session. */
  prompt: string;
  at: number;
}

export function parseClient(v: string | undefined): Client | undefined {
  if (!v) return undefined;
  const c = v.toLowerCase() as Client;
  if (!CLIENTS.includes(c)) throw new AihubError(`--client must be one of ${CLIENTS.join(", ")}`);
  return c;
}

/** The agent client this process runs in, from its environment; undefined when unknown. */
export function detectClient(env: NodeJS.ProcessEnv, flag?: string): Client | undefined {
  const given = parseClient(flag);
  if (given) return given;
  if (env.OPENCODE || env.OPENCODE_SESSION_ID || env.OPENCODE_CLIENT) return "opencode";
  if (env.CODEX_SESSION_ID || env.CODEX_HOME || env.CODEX_SANDBOX) return "codex";
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return "claude";
  if (env.COPILOT_AGENT || env.GITHUB_COPILOT_CLI || env.TERM_PROGRAM === "vscode") return "copilot";
  return undefined;
}

// ---- event store (per user, so the aihub:// handler finds it from anywhere) ----------------

export const openHome = (env: NodeJS.ProcessEnv) => join(env.AIHUB_HOME || join(homedir(), ".aihub"), "events");

export function storeEvent(env: NodeJS.ProcessEnv, ev: OpenEvent): void {
  const d = openHome(env);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${ev.id}.json`), JSON.stringify(ev), "utf8");
}

export function readEvent(env: NodeJS.ProcessEnv, id: string): OpenEvent {
  const f = join(openHome(env), `${id.replace(/[^A-Za-z0-9_-]/g, "")}.json`);
  if (!existsSync(f)) throw new AihubError(`no event '${id}' (it may be older than this machine's records; try 'aihub open --last')`);
  return JSON.parse(readFileSync(f, "utf8")) as OpenEvent;
}

export function lastEvent(env: NodeJS.ProcessEnv): OpenEvent {
  const d = openHome(env);
  const files = existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".json")) : [];
  if (!files.length) throw new AihubError("no watch events recorded yet (start one with 'aihub watch --pr N --notify')");
  const newest = files.map((f) => ({ f, t: statSync(join(d, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0].f;
  return JSON.parse(readFileSync(join(d, newest), "utf8")) as OpenEvent;
}

export interface EventRow {
  id: string;
  /** ISO time of the event */
  at: string;
  epoch: number;
  message: string;
  repo: string;
  client?: Client;
  session?: string;
  /** aihub://open?event=<id>: what the notification's Open button runs */
  url: string;
}

/** The recorded watch events (`watch --pr` and `watch --mine`), newest first. */
export function listEvents(env: NodeJS.ProcessEnv, o: { limit?: number; sinceMs?: number; now?: number } = {}): EventRow[] {
  const d = openHome(env);
  if (!existsSync(d)) return [];
  const cutoff = o.sinceMs !== undefined ? (o.now ?? Date.now()) - o.sinceMs : undefined;
  const rows: EventRow[] = [];
  for (const f of readdirSync(d).filter((x) => x.endsWith(".json"))) {
    try {
      const ev = JSON.parse(readFileSync(join(d, f), "utf8")) as OpenEvent;
      if (!ev?.id || typeof ev.at !== "number") continue;
      if (cutoff !== undefined && ev.at < cutoff) continue;
      rows.push({ id: ev.id, at: new Date(ev.at).toISOString(), epoch: ev.at, message: ev.message, repo: ev.repo, client: ev.client, session: ev.session, url: eventUrl(ev.id) });
    } catch {
      /* a half written file */
    }
  }
  rows.sort((a, b) => b.epoch - a.epoch);
  return o.limit !== undefined ? rows.slice(0, o.limit) : rows;
}

export const eventUrl = (id: string) => `aihub://open?event=${encodeURIComponent(id)}`;

export function eventFromUrl(url: string): string {
  let id: string | null = null;
  try {
    id = new URL(url).searchParams.get("event");
  } catch {
    /* handled below */
  }
  if (!id) throw new AihubError(`'${url}' is not an aihub://open?event=<id> link`);
  return id;
}

// ---- launch plan -----------------------------------------------------------------------------

const posix = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The client's own "continue this session" command with the first message. */
export function resumeArgs(ev: OpenEvent): string[] | undefined {
  switch (ev.client) {
    case "opencode":
      return ["opencode", ...(ev.session ? ["--session", ev.session] : ["--continue"]), "--prompt", ev.prompt];
    case "codex":
      return ev.session ? ["codex", "resume", ev.session, ev.prompt] : ["codex", "resume", "--last", ev.prompt];
    case "claude":
      return ev.session ? ["claude", "--resume", ev.session, ev.prompt] : ["claude", "--continue", ev.prompt];
    default:
      return undefined;
  }
}

export interface LaunchPlan {
  cmd: string;
  args: string[];
  /** The same thing as one line a person can paste, used when nothing can be launched. */
  text: string;
  shell?: boolean;
}

export function planOpen(ev: OpenEvent, platform: NodeJS.Platform, hasWindowsTerminal = false): LaunchPlan {
  const resume = resumeArgs(ev);
  if (!resume) {
    // Copilot (or an unknown client): the editor in the repository; the chat is there.
    return { cmd: "code", args: [ev.repo], text: `code ${posix(ev.repo)}`, shell: platform === "win32" };
  }
  if (platform === "win32") {
    const line = `& ${resume.map(ps).join(" ")}`;
    const text = `cd ${ps(ev.repo)}; ${resume.map(ps).join(" ")}`;
    if (hasWindowsTerminal) return { cmd: "wt.exe", args: ["-d", ev.repo, "powershell.exe", "-NoExit", "-Command", line], text };
    return { cmd: "cmd.exe", args: ["/c", "start", "", "/D", ev.repo, "powershell.exe", "-NoExit", "-Command", line], text };
  }
  const line = resume.map(posix).join(" ");
  const text = `cd ${posix(ev.repo)} && ${line}`;
  if (platform === "darwin") {
    const script = `tell application "Terminal" to do script "${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    return { cmd: "osascript", args: ["-e", script, "-e", 'tell application "Terminal" to activate'], text };
  }
  return { cmd: "x-terminal-emulator", args: ["-e", "bash", "-lc", `${text}; exec bash`], text };
}

export type Launcher = (plan: LaunchPlan) => boolean;

/** Starts the plan detached; false when the program is not there (the caller prints plan.text instead). */
export const launch: Launcher = (plan) => {
  try {
    const child = spawn(plan.cmd, plan.args, { detached: true, stdio: "ignore", shell: plan.shell, windowsHide: false });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
};

export const hasWindowsTerminal = (): boolean => process.platform === "win32" && spawnSync("where", ["wt.exe"], { stdio: "ignore" }).status === 0;

export interface OpenOpts {
  event?: string;
  last?: boolean;
  url?: string;
  print?: boolean;
}

export function openEvent(ctx: Ctx, o: OpenOpts, launcher: Launcher = launch, platform: NodeJS.Platform = process.platform, wt: boolean = hasWindowsTerminal()): string {
  const ev = o.url ? readEvent(ctx.env, eventFromUrl(o.url)) : o.event ? readEvent(ctx.env, o.event) : o.last ? lastEvent(ctx.env) : undefined;
  if (!ev) throw new AihubError("usage: aihub open --event <id> | --last | --url aihub://open?event=<id> [--print]");
  const plan = planOpen(ev, platform, wt);
  if (o.print) return plan.text;
  if (launcher(plan)) return `opened ${ev.client ?? "VS Code"} in ${ev.repo}: ${ev.message}`;
  return `could not launch a terminal here; run: ${plan.text}`;
}

// ---- aihub:// protocol (Windows, per user, no admin) --------------------------------------------

export function protocolCommands(node: string, cli: string): string[][] {
  const k = "HKCU\\Software\\Classes\\aihub";
  return [
    ["add", k, "/ve", "/d", "URL:aihub", "/f"],
    ["add", k, "/v", "URL Protocol", "/d", "", "/f"],
    ["add", `${k}\\shell\\open\\command`, "/ve", "/d", `"${node}" "${cli}" open --url "%1"`, "/f"],
  ];
}

/** Registers aihub:// under HKCU on first use (Windows only; other systems print the command instead). */
export function ensureProtocol(platform: NodeJS.Platform = process.platform, node = process.execPath, cli = process.argv[1]): boolean {
  if (platform !== "win32") return false;
  const cur = spawnSync("reg", ["query", "HKCU\\Software\\Classes\\aihub\\shell\\open\\command", "/ve"], { encoding: "utf8" });
  if (cur.status === 0 && cur.stdout.includes(cli)) return true;
  return protocolCommands(node, cli).every((a) => spawnSync("reg", a, { stdio: "ignore" }).status === 0);
}
