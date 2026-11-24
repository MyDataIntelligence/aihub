import { spawnSync } from "./proc.js";
import { AihubError } from "./errors.js";
import { gitGate } from "./trace.js";
import { isAbsolute, resolve } from "node:path";

export interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

/** Runs git and reports success instead of throwing (the exit code matters for merge checks). */
export function tryGit(cwd: string, args: string[]): GitResult {
  if (gitGate(cwd, args)) return { ok: true, out: "", err: "" };
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new AihubError(`git is not available: ${r.error.message}`);
  return { ok: r.status === 0, out: r.stdout.replace(/\r\n/g, "\n").trimEnd(), err: (r.stderr || "").trim() };
}

export function mustGit(cwd: string, args: string[]): string {
  const r = tryGit(cwd, args);
  if (!r.ok) throw new AihubError(`git ${args.join(" ")} failed: ${r.err.split("\n")[0]}`);
  return r.out;
}

export const isDirty = (dir: string): boolean => mustGit(dir, ["status", "--porcelain"]) !== "";

/** Build output that is never work to commit, even in a repository without a .gitignore (pathspecs for `git add` and `git status`). */
export const ARTIFACT_EXCLUDES = [
  ":(exclude,glob)**/__pycache__/**",
  ":(exclude,glob)**/*.pyc",
  ":(exclude,glob)**/.pytest_cache/**",
  ":(exclude,glob)**/node_modules/**",
  ":(exclude,glob)**/.venv/**",
  ":(exclude,glob)**/.DS_Store",
];

/** Is there anything to commit? Like isDirty, but ignores untracked build output (__pycache__, node_modules, ...). */
export const hasWorkToCommit = (dir: string): boolean => mustGit(dir, ["status", "--porcelain", "--", ".", ...ARTIFACT_EXCLUDES]) !== "";

export interface RepoState {
  root: string;
  /** The common .git folder (shared by all worktrees). */
  commonDir: string;
  branch: string;
  /** Work to commit, like hasWorkToCommit. */
  dirty: boolean;
  /** Commits not on the remote: ahead of the upstream, or (no upstream yet) not on any remote branch, like unpushedCount. */
  unpushed: number;
}

/**
 * What `aihub status` needs from git in two calls instead of six: `rev-parse --show-toplevel --git-common-dir` and one
 * `status --porcelain=v2 --branch` (branch, upstream, ahead, changes). Only a branch without an upstream needs a third
 * call (`rev-list`) for its unpushed commits.
 */
export function repoState(cwd: string): RepoState {
  const [root, common] = mustGit(cwd, ["rev-parse", "--show-toplevel", "--git-common-dir"]).split(/\r?\n/).map((s) => s.trim());
  const out = mustGit(root, ["status", "--porcelain=v2", "--branch", "--", ".", ...ARTIFACT_EXCLUDES]);
  let branch = "";
  let upstream = "";
  let ahead: number | undefined;
  let dirty = false;
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) branch = line.slice(14).trim();
    else if (line.startsWith("# branch.upstream ")) upstream = line.slice(18).trim();
    else if (line.startsWith("# branch.ab ")) ahead = Number(/\+(\d+)/.exec(line)?.[1] ?? 0);
    else if (!line.startsWith("#")) dirty = true;
  }
  if (!branch || branch === "(detached)") throw new AihubError("detached HEAD; check out a branch first");
  const unpushed = upstream && ahead !== undefined ? ahead : unpushedCount(root);
  return { root, commonDir: isAbsolute(common) ? common : resolve(cwd, common), branch, dirty, unpushed };
}

/** Changes to tracked files only: untracked files (build output, scratch files) never stop `git switch`, which refuses by itself when one would be overwritten. */
export const hasTrackedChanges = (dir: string): boolean => mustGit(dir, ["status", "--porcelain", "--untracked-files=no"]) !== "";

export const refSha = (dir: string, ref: string): string => {
  const r = tryGit(dir, ["rev-parse", "--verify", "--quiet", ref]);
  return r.ok ? r.out.trim() : "";
};

export const isAncestor = (dir: string, a: string, b: string): boolean => tryGit(dir, ["merge-base", "--is-ancestor", a, b]).ok;

export interface Worktree {
  path: string;
  head: string;
  branch?: string;
  main: boolean;
}

export function listWorktrees(dir: string): Worktree[] {
  const out = mustGit(dir, ["worktree", "list", "--porcelain"]);
  const res: Worktree[] = [];
  for (const block of out.split(/\n\n+/)) {
    const w: Worktree = { path: "", head: "", main: res.length === 0 };
    for (const l of block.split("\n")) {
      if (l.startsWith("worktree ")) w.path = l.slice(9);
      else if (l.startsWith("HEAD ")) w.head = l.slice(5);
      else if (l.startsWith("branch ")) w.branch = l.slice(7).replace(/^refs\/heads\//, "");
    }
    if (w.path) res.push(w);
  }
  return res;
}

/** Commits of HEAD that no remote-tracking branch has (would be lost with the worktree). */
export const unpushedCount = (dir: string): number => {
  const r = tryGit(dir, ["rev-list", "--count", "HEAD", "--not", "--remotes"]);
  return r.ok ? Number(r.out) || 0 : 0;
};

export const samePath = (a: string, b: string): boolean =>
  a.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === b.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
