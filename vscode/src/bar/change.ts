import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configHome } from "../../../cli/src/lib/configHome";
import { pathKey } from "../../../cli/src/lib/recentUse";

/**
 * Change with Agent, the pure part (no vscode): the argument, the `aihub browse change` calls, the task of a working copy, the
 * commands that start opencode (a terminal in this window, Windows Terminal, or a new window that starts it when it opens).
 */

export type ChangeMode = "remote" | "workingCopy";
export type ChangeWhere = "panel" | "newWindow" | "terminal";

export interface Selection {
  path: string;
  startLine: number;
  endLine: number;
}

export interface ChangeStartArg {
  org?: string;
  project: string;
  repo: string;
  /** the base branch; default: the default branch */
  branch?: string;
  paths?: string[];
  selection?: Selection;
  prompt: string;
  mode: ChangeMode;
  where: ChangeWhere;
  /** the feature branch; default: the team template */
  newBranch?: string;
  story?: number;
  /** workingCopy: to clone the repository when it is not on this PC */
  remoteUrl?: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const posInt = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined;
};

export function parseChangeStart(a: unknown): ChangeStartArg | { problem: string } {
  const o = (a ?? {}) as Record<string, unknown>;
  const project = str(o.project);
  const repo = str(o.repo);
  const prompt = str(o.prompt);
  if (!project || !repo) return { problem: "which repository? ({ project, repo })" };
  if (!prompt) return { problem: "what should change? ({ prompt })" };
  const mode = o.mode === "workingCopy" ? "workingCopy" : o.mode === undefined || o.mode === "remote" ? "remote" : undefined;
  if (!mode) return { problem: "mode is remote or workingCopy" };
  const where = o.where === "newWindow" || o.where === "terminal" ? o.where : o.where === undefined || o.where === "panel" ? "panel" : undefined;
  if (!where) return { problem: "where is panel, newWindow or terminal" };
  const s = (o.selection ?? undefined) as Record<string, unknown> | undefined;
  const selection = s && str(s.path) && posInt(s.startLine) ? { path: str(s.path)!, startLine: posInt(s.startLine)!, endLine: posInt(s.endLine) ?? posInt(s.startLine)! } : undefined;
  const paths = Array.isArray(o.paths) ? (o.paths as unknown[]).map(str).filter((p): p is string => !!p) : undefined;
  return { org: str(o.org), project, repo, branch: str(o.branch), paths, selection, prompt, mode, where, newBranch: str(o.newBranch), story: posInt(o.story), remoteUrl: str(o.remoteUrl) };
}

/** `aihub browse change start` for a remote change; the prompt goes in a file. */
export function startArgs(a: ChangeStartArg, promptFile: string): string[] {
  return [
    "browse",
    "change",
    "start",
    "--project",
    a.project,
    "--repo",
    a.repo,
    ...(a.org ? ["--org", a.org] : []),
    ...(a.branch ? ["--ref", a.branch] : []),
    ...(a.newBranch ? ["--branch", a.newBranch] : []),
    ...(a.story ? ["--story", String(a.story)] : []),
    ...(a.paths?.length ? ["--paths", a.paths.join(",")] : []),
    ...(a.selection ? ["--selection", `${a.selection.path}:${a.selection.startLine}-${a.selection.endLine}`] : []),
    "--prompt-file",
    promptFile,
  ];
}

/** The task of a change in a working copy: the agent works in git there, can run tests, never pushes. */
export function workingCopyTask(a: ChangeStartArg, branch: string, base: string): string {
  return [
    `# Change in ${a.repo}`,
    "",
    "## What should change",
    "",
    a.prompt,
    "",
    "## Where",
    "",
    `This folder is a working copy of ${a.repo} (project ${a.project}) on the new branch ${branch}, made from ${base}.`,
    ...(a.paths?.length ? [`The user pointed at: ${a.paths.join(", ")}.`] : []),
    ...(a.selection ? [`The user selected ${a.selection.path} lines ${a.selection.startLine}-${a.selection.endLine}.`] : []),
    "",
    "## Fixed limits",
    "",
    "- Do not push, and do not merge into another branch: the user reviews and pushes.",
    "- Never main, master, staging or develop; only this repository; at most 20 files.",
    "- No secrets, no pipeline definitions, variable groups or .env files.",
    "- Run the tests that cover the change and say which ran.",
    "",
  ].join("\n");
}

/** The line that starts opencode with a prompt (no path in the prompt, double quotes made single: safe in pwsh and cmd). */
export const opencodeLine = (prompt: string, agent?: string): string => `opencode${agent ? ` --agent ${agent}` : ""} --prompt "${prompt.replace(/"/g, "'").replace(/[\r\n]+/g, " ")}"`;

/** An opencode window outside VS Code: Windows Terminal when it is there, else a console window (cmd). */
export function externalTerminal(cwd: string, prompt: string, o: { hasWt: boolean; platform?: NodeJS.Platform; agent?: string }): { command: string; args: string[] } | undefined {
  const platform = o.platform ?? process.platform;
  const line = opencodeLine(prompt, o.agent);
  if (platform !== "win32") return undefined;
  if (o.hasWt) return { command: "wt.exe", args: ["-d", cwd, "cmd", "/k", line] };
  return { command: "cmd.exe", args: ["/c", "start", "opencode", "/D", cwd, "cmd", "/k", line] };
}

// ---- a new window that starts opencode when it opens ------------------------------------------------------------------

export interface PendingAgent {
  folder: string;
  line: string;
  at: number;
}

const pendingFile = (env: NodeJS.ProcessEnv) => join(configHome(env), "changes", "pending-agent.json");
export const PENDING_TTL_MS = 10 * 60_000;

function readPending(env: NodeJS.ProcessEnv): PendingAgent[] {
  try {
    return JSON.parse(readFileSync(pendingFile(env), "utf8")) as PendingAgent[];
  } catch {
    return [];
  }
}

/** Remembers that the window opening `folder` starts opencode with `line` (read once by that window). */
export function addPending(env: NodeJS.ProcessEnv, p: PendingAgent): void {
  const now = p.at;
  const list = [...readPending(env).filter((x) => now - x.at < PENDING_TTL_MS && pathKey(x.folder) !== pathKey(p.folder)), p];
  mkdirSync(join(configHome(env), "changes"), { recursive: true });
  writeFileSync(pendingFile(env), JSON.stringify(list), "utf8");
}

/** The start for this window's folder, taken out of the list (so only one window starts it). No file: nothing to do. */
export function takePending(env: NodeJS.ProcessEnv, folder: string | undefined, now: number): PendingAgent | undefined {
  if (!folder || !existsSync(pendingFile(env))) return undefined;
  const list = readPending(env);
  const mine = list.find((x) => pathKey(x.folder) === pathKey(folder) && now - x.at < PENDING_TTL_MS);
  const rest = list.filter((x) => x !== mine && now - x.at < PENDING_TTL_MS);
  if (mine || rest.length !== list.length) writeFileSync(pendingFile(env), JSON.stringify(rest), "utf8");
  return mine;
}

// ---- Run Checks (temporary copy): aihub browse change verify --------------------------------------------------------

export interface VerifyProgress {
  id: string;
  step: "clone" | "checkout" | "apply" | "lint" | "test" | "cleanup";
  n: number;
  total: number;
  message: string;
}

/** `aihub browse change verify` for `{ id, lint? (default true), tests? (default false) }`, with progress lines on stderr. */
export function verifyArgs(a: { id?: string; lint?: boolean; tests?: boolean }): string[] {
  if (!a?.id) throw new Error("which change? ({ id })");
  const lint = a.lint !== false;
  if (!lint && !a.tests) throw new Error("nothing to check: lint and/or tests");
  return ["browse", "change", "verify", "--id", a.id, ...(lint ? (a.tests ? ["--tests"] : []) : ["--tests-only"]), "--progress"];
}

/** The progress events in a piece of stderr (one JSON line each: {"progress":{...}}); other lines are skipped. */
export function progressLines(text: string): VerifyProgress[] {
  const out: VerifyProgress[] = [];
  for (const l of text.split(/\r?\n/)) {
    if (!l.startsWith('{"progress"')) continue;
    try {
      out.push((JSON.parse(l) as { progress: VerifyProgress }).progress);
    } catch {
      /* a line cut in two by the pipe: the next chunk has the rest */
    }
  }
  return out;
}
