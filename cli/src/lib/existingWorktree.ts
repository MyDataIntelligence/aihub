import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { AihubError } from "./errors.js";
import { listWorktrees, samePath, tryGit, unpushedCount, type Worktree } from "./gitx.js";
import { spawnSync } from "./proc.js";
import { configHome } from "./notifyPolicy.js";
import { findDirLinks, moveWorktreeSafely, removeDirLink, restoreDirLinks } from "./safeWorktree.js";
import { gitCommonDir } from "./storyWorktrees.js";
import { MISSING_SETTING_EXIT } from "./team-guide.js";

/**
 * A branch that already has a worktree somewhere else than where a set wants it. aihub never reuses it silently and
 * never fails with git's bare error: it stops BEFORE anything changes and names three choices (exit code 3, as for a
 * missing team setting: the agent asks the user one question and runs the chosen command):
 * - move: `git worktree move` into the set (work and branch go along) — the recommended one;
 * - reuse: leave it where it is and put that folder in the set;
 * - recreate: remove it and make a new worktree from the branch (uncommitted work only with --discard-local-work, after a backup).
 * A worktree already inside the set folder, or the main clone (which cannot be moved or removed), is reused without a question.
 * The answer can be a personal preference (`aihub worktree when-exists move`), never a team setting: it is a habit.
 */
export type WhenExists = "ask" | "move" | "reuse" | "recreate";
export const WHEN_EXISTS: WhenExists[] = ["ask", "move", "reuse", "recreate"];

const prefFile = (env: NodeJS.ProcessEnv) => join(configHome(env), "worktrees.json");

export function readWhenExists(env: NodeJS.ProcessEnv): WhenExists {
  try {
    const v = (JSON.parse(readFileSync(prefFile(env), "utf8")) as { whenExists?: string }).whenExists;
    return WHEN_EXISTS.includes(v as WhenExists) ? (v as WhenExists) : "ask";
  } catch {
    return "ask";
  }
}

export function writeWhenExists(env: NodeJS.ProcessEnv, v: string): WhenExists {
  if (!WHEN_EXISTS.includes(v as WhenExists)) throw new AihubError(`when-exists must be one of ${WHEN_EXISTS.join(", ")}`);
  mkdirSync(configHome(env), { recursive: true });
  writeFileSync(prefFile(env), JSON.stringify({ whenExists: v }, null, 2), "utf8");
  return v as WhenExists;
}

/** The value of --existing, checked. */
export function existingFlag(v: unknown): Exclude<WhenExists, "ask"> | undefined {
  if (v === undefined) return undefined;
  if (v !== "move" && v !== "reuse" && v !== "recreate") throw new AihubError("--existing must be move, reuse or recreate");
  return v;
}

/**
 * Runs a command that may stop on an existing worktree. With --json the question is the output (`needsChoice`: the
 * existing worktrees and the three ready commands) and the exit code stays 0, as for the other rows of --json; else
 * the error goes up (exit code 3: ask the user one question).
 */
export function orChoice<T>(json: boolean, out: (line: string) => void, run: () => T): T | undefined {
  try {
    return run();
  } catch (e) {
    if (!json || !(e instanceof WorktreeExists)) throw e;
    out(JSON.stringify({ needsChoice: e.needsChoice }));
    return undefined;
  }
}

export async function orChoiceAsync<T>(json: boolean, out: (line: string) => void, run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch (e) {
    if (!json || !(e instanceof WorktreeExists)) throw e;
    out(JSON.stringify({ needsChoice: e.needsChoice }));
    return undefined;
  }
}

export interface ExistingWorktree {
  repo: string;
  branch: string;
  /** where the worktree is now */
  path: string;
  /** where the set wants it (the folder `move` and `recreate` use) */
  target: string;
  /** uncommitted files (folder links not counted) */
  dirty: number;
  /** commits not on the remote; they stay on the branch whatever is chosen */
  unpushed: number;
  /** "clean" | "2 uncommitted files" | "1 commit not pushed" */
  state: string;
}

export interface WorktreeChoice {
  choice: Exclude<WhenExists, "ask">;
  label: string;
  command: string;
}

/** Stops a command before anything changed; `--json` callers get `needsChoice` instead of the exit code. */
export class WorktreeExists extends AihubError {
  readonly exitCode = MISSING_SETTING_EXIT;
  constructor(
    readonly existing: ExistingWorktree[],
    readonly choices: WorktreeChoice[],
    message: string,
  ) {
    super(message);
    this.name = "WorktreeExists";
  }
  get needsChoice() {
    return { question: this.message, existing: this.existing, choices: this.choices };
  }
}

const isInside = (folder: string, p: string) => ((rel) => !!rel && !rel.startsWith("..") && !isAbsolute(rel))(relative(folder, p));

const dirtyFiles = (path: string): number => {
  const links = new Set(findDirLinks(path).map((l) => l.rel.replace(/\\/g, "/")));
  return tryGit(path, ["status", "--porcelain"]).out.split("\n").filter(Boolean).filter((l) => !links.has(l.slice(3).replace(/\/$/, ""))).length;
};

export function describeExisting(repo: string, branch: string, path: string, target: string): ExistingWorktree {
  const dirty = dirtyFiles(path);
  let unpushed = 0;
  try {
    unpushed = unpushedCount(path);
  } catch {
    /* no upstream information: nothing to say */
  }
  const parts = [dirty ? `${dirty} uncommitted file${dirty > 1 ? "s" : ""}` : "", unpushed ? `${unpushed} commit${unpushed > 1 ? "s" : ""} not pushed` : ""].filter(Boolean);
  return { repo, branch, path, target, dirty, unpushed, state: parts.join(", ") || "clean" };
}

export interface PlannedWorktree {
  repo: string;
  /** the clone the worktree belongs to */
  source: string;
  branch: string;
  /** where the set wants the worktree */
  target: string;
}

/**
 * Before anything changes: the planned worktrees whose branch is checked out elsewhere. With `ask` they stop the
 * command (WorktreeExists); else nothing is thrown. Returns each source's worktree list, so the caller does not run
 * `git worktree list` twice. A registration whose folder is gone is pruned on the way (nothing to ask about).
 */
export function checkExisting(plan: PlannedWorktree[], o: { folder: string; policy: WhenExists; again: string }): Map<string, Worktree[]> {
  const lists = new Map<string, Worktree[]>();
  const found: ExistingWorktree[] = [];
  for (const p of plan) {
    let list: Worktree[];
    try {
      list = lists.get(p.source) ?? listWorktrees(p.source);
    } catch {
      continue;
    }
    if (list.some((w) => !w.main && w.path && !existsSync(w.path))) {
      tryGit(p.source, ["worktree", "prune"]);
      list = list.filter((w) => w.main || existsSync(w.path));
    }
    lists.set(p.source, list);
    const w = list.find((x) => x.branch === p.branch);
    if (!w || w.main || samePath(w.path, p.target) || isInside(o.folder, w.path)) continue;
    if (o.policy === "ask") found.push(describeExisting(p.repo, p.branch, w.path, p.target));
  }
  if (found.length) throw askExisting(found, o.again);
  return lists;
}

/** The one question line, with the three ready commands (move first: it is the recommended one). */
export function askExisting(found: ExistingWorktree[], again: string): WorktreeExists {
  const dirty = found.some((f) => f.dirty);
  const choices: WorktreeChoice[] = [
    { choice: "move", label: `move it into this set (recommended; work and branch go along)`, command: `${again} --existing move` },
    { choice: "reuse", label: "reuse it where it is", command: `${again} --existing reuse` },
    { choice: "recreate", label: `recreate it (the old one is removed${dirty ? "; its uncommitted work is saved as a patch first" : ""})`, command: `${again} --existing recreate${dirty ? " --discard-local-work" : ""}` },
  ];
  const what = found.map((f) => `worktree for ${f.branch} already exists: ${f.path} (${f.state})`).join("; ");
  return new WorktreeExists(found, choices, `${what}. choose: ${choices.map((c) => `${c.label}: ${c.command}`).join(" | ")}`);
}

export interface Placed {
  ok: boolean;
  state: "moved" | "recreated" | "failed";
  note: string;
  /** the patch file with the uncommitted work of a recreated worktree */
  backup?: string;
}

/** `move`: `git worktree move` with folder links taken out and put back; checked afterwards and put back when it went half. */
export function moveExisting(source: string, branch: string, from: string, to: string, again: string): Placed {
  const alt = `nothing was moved. choose: reuse it: ${again} --existing reuse | recreate it: ${again} --existing recreate`;
  if (existsSync(to)) return { ok: false, state: "failed", note: `cannot move ${from}: ${to} already exists; ${alt}` };
  const r = moveWorktreeSafely(source, from, to);
  const there = () => listWorktrees(source).some((w) => samePath(w.path, to) && w.branch === branch);
  if (r.ok && there() && !existsSync(from)) return { ok: true, state: "moved", note: `moved here from ${from} (${r.note})` };
  // half done (a process held a file on Windows): put it back where it was
  if (existsSync(to) && !existsSync(from)) tryGit(source, ["worktree", "move", to, from]);
  return { ok: false, state: "failed", note: `cannot move ${from} (${r.ok ? "the move did not complete" : r.note}; is it open in VS Code or another program?); ${alt}` };
}

/**
 * `recreate`: the old worktree removed (folder links first; uncommitted work only with `discard`, after a patch backup
 * under `<git dir>/aihub/backup/`), then a new worktree at `to` from the branch. Local and remote branch stay.
 */
export function recreateExisting(source: string, branch: string, from: string, to: string, o: { discard?: boolean; again: string; now?: number }): Placed {
  const dirty = dirtyFiles(from);
  if (dirty && !o.discard)
    return { ok: false, state: "failed", note: `${dirty} uncommitted file(s) in ${from}; nothing was removed. Commit them, choose move (${o.again} --existing move), or add --discard-local-work (a patch backup is kept)` };
  let backup: string | undefined;
  if (dirty) {
    const common = gitCommonDir(source);
    if (!common) return { ok: false, state: "failed", note: `no git folder for ${source}; nothing was removed` };
    tryGit(from, ["add", "-A"]);
    // the bytes as git wrote them: tryGit turns CRLF into LF and trims the end, and such a patch no longer applies
    const diff = spawnSync("git", ["diff", "--cached", "--binary", "HEAD"], { cwd: from, maxBuffer: 1024 * 1024 * 1024 });
    if (diff.error || diff.status !== 0) return { ok: false, state: "failed", note: `the backup of ${from} failed (${(diff.error?.message ?? String(diff.stderr ?? "")).split("\n")[0]}); nothing was removed` };
    backup = join(common, "aihub", "backup", `${branch.replace(/[\\/:*?"<>|\s]+/g, "-")}-${stamp(o.now)}.patch`);
    mkdirSync(dirname(backup), { recursive: true });
    writeFileSync(backup, diff.stdout);
  }
  // folder links (a linked node_modules) go first: --force would follow them and empty what they point to
  const links = findDirLinks(from);
  for (const l of links) removeDirLink(join(from, l.rel));
  const rm = tryGit(source, ["worktree", "remove", ...(dirty ? ["--force"] : []), from]);
  if (!rm.ok) {
    restoreDirLinks(from, links);
    return { ok: false, state: "failed", note: `cannot remove ${from} (${rm.err.split("\n")[0]}; is it open in VS Code?); nothing was changed`, backup };
  }
  const aside = existsSync(to) ? moveAside(to, o.now) : "";
  mkdirSync(dirname(to), { recursive: true });
  const add = tryGit(source, ["worktree", "add", to, branch]);
  if (!add.ok) return { ok: false, state: "failed", note: `old worktree removed, but the new one could not be made: ${add.err.split("\n")[0]}; run again with --existing reuse after fixing it`, backup };
  const extra = [backup ? `uncommitted work saved in ${backup}` : "", aside ? `the folder that was there is now ${aside}` : ""].filter(Boolean);
  return { ok: true, state: "recreated", note: `recreated from ${branch} (old worktree ${from} removed${extra.length ? `; ${extra.join("; ")}` : ""})`, backup };
}

/** A leftover folder (not a worktree) where the new worktree goes: renamed, never deleted. */
export function moveAside(path: string, now?: number): string {
  const to = `${path}.old-${stamp(now)}`;
  renameSync(path, to);
  return to;
}

const stamp = (now = Date.now()) => new Date(now).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
