import { spawnSync } from "./proc.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AihubError } from "./errors.js";
import { gitGate } from "./trace.js";

/**
 * Read-only commands that `aihub bar` repeats in each of its parts (root, branch, remote, common dir): with the memo on,
 * each runs once per process. Only for commands that change nothing (bar); a command that switches branches keeps it off.
 */
let readMemo: Map<string, string> | undefined;
const MEMO = /^(rev-parse|config)$/;
export function memoGitReads(on: boolean): void {
  readMemo = on ? new Map() : undefined;
}

export function git(cwd: string, args: string[], opts: { allowFail?: boolean } = {}): string {
  const key = readMemo && MEMO.test(args[0] ?? "") && (args[0] !== "config" || args[1] === "--get") ? `${cwd}\0${opts.allowFail ? 1 : 0}\0${args.join("\0")}` : undefined;
  if (key && readMemo!.has(key)) return readMemo!.get(key)!;
  const out = gitUncached(cwd, args, opts);
  if (key) readMemo!.set(key, out);
  return out;
}

function gitUncached(cwd: string, args: string[], opts: { allowFail?: boolean }): string {
  if (gitGate(cwd, args)) return "";
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new AihubError(`git is not available: ${r.error.message}`);
  if (r.status !== 0) {
    if (opts.allowFail) return "";
    throw new AihubError(`git ${args.join(" ")} failed: ${(r.stderr || "").trim().split("\n")[0]}`);
  }
  return r.stdout.replace(/\r\n/g, "\n").trimEnd();
}

export function remoteUrl(cwd: string, remote = "origin"): string {
  // raw config value: `git remote get-url` would expand insteadOf rewrites
  const url = git(cwd, ["config", "--get", `remote.${remote}.url`], { allowFail: true }).trim();
  if (!url) throw new AihubError(`no git remote '${remote}' here; run inside a clone of the Azure DevOps repository`);
  return url;
}

export function currentBranch(cwd: string): string {
  const b = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (b === "HEAD") throw new AihubError("detached HEAD; check out a branch first");
  return b;
}

export function repoRoot(cwd: string): string {
  return git(cwd, ["rev-parse", "--show-toplevel"]).trim();
}

/** origin's default branch name from origin/HEAD, or "" when unknown. */
export function originDefaultBranch(cwd: string): string {
  const ref = git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { allowFail: true }).trim();
  return ref.replace(/^origin\//, "");
}

export function hasRef(cwd: string, ref: string): boolean {
  return git(cwd, ["rev-parse", "--verify", "--quiet", ref], { allowFail: true }).trim() !== "";
}

export function mergeBase(cwd: string, target: string): string {
  const ref = hasRef(cwd, `origin/${target}`) ? `origin/${target}` : target;
  return git(cwd, ["merge-base", "HEAD", ref], { allowFail: true }).trim();
}

export interface CommitInfo {
  sha: string;
  subject: string;
}

/** Commits on HEAD since the merge-base with the target, oldest first. */
export function commitsSince(cwd: string, base: string): CommitInfo[] {
  if (!base) return [];
  const out = git(cwd, ["log", "--reverse", "--format=%h%x09%s", `${base}..HEAD`], { allowFail: true });
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, ...rest] = l.split("\t");
      return { sha, subject: rest.join("\t") };
    });
}

/** "5 files changed, +71 -0" for the changes since `base`; undefined when there are none. */
export function diffSummary(cwd: string, base: string): string | undefined {
  if (!base) return undefined;
  const out = git(cwd, ["diff", "--numstat", base, "HEAD"], { allowFail: true }).split("\n").filter(Boolean);
  if (!out.length) return undefined;
  let add = 0;
  let del = 0;
  for (const l of out) {
    const [a, d] = l.split("\t");
    add += Number(a) || 0;
    del += Number(d) || 0;
  }
  return `${out.length} file${out.length === 1 ? "" : "s"} changed, +${add} -${del}`;
}

/** File content at origin/<branch> (falls back to local branch), or undefined. */
export function showFile(cwd: string, branch: string, path: string): string | undefined {
  for (const ref of [`origin/${branch}`, branch]) {
    if (!hasRef(cwd, ref)) continue;
    const r = spawnSync("git", ["show", `${ref}:${path}`], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (r.status === 0) return r.stdout.replace(/^﻿/, "");
  }
  return undefined;
}

/** All file paths at origin/<branch> (falls back to the local branch), or undefined when neither exists. One git process. */
export function listRefFiles(cwd: string, branch: string): string[] | undefined {
  for (const ref of [`origin/${branch}`, branch]) {
    if (!hasRef(cwd, ref)) continue;
    const r = spawnSync("git", ["ls-tree", "-r", "--name-only", ref], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0) return r.stdout.split("\n").filter(Boolean);
  }
  return undefined;
}

/** Push the branch when origin does not have it or is behind. Returns true if a push happened. */
export function pushIfNeeded(cwd: string, branch: string, noVerify = false): boolean {
  const remoteSha = git(cwd, ["ls-remote", "--heads", "origin", branch], { allowFail: true }).split(/\s+/)[0];
  const local = git(cwd, ["rev-parse", "HEAD"]).trim();
  if (remoteSha === local) return false;
  git(cwd, ["push", ...(noVerify ? ["--no-verify"] : []), "--set-upstream", "origin", `HEAD:refs/heads/${branch}`]);
  return true;
}

/** Work item id from branch names like feature/1234-slug, bugfix/1234_x, 1234-x. */
export function workItemFromBranch(branch: string): number | undefined {
  const m = /(?:^|\/)(\d{1,9})(?=[-_/]|$)/.exec(branch);
  return m ? Number(m[1]) : undefined;
}

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run git and return the exit status instead of throwing. */
export function gitRaw(cwd: string, args: string[], env?: Record<string, string>): GitResult {
  if (gitGate(cwd, args)) return { status: 0, stdout: "", stderr: "" };
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: env ? { ...process.env, ...env } : undefined });
  if (r.error) throw new AihubError(`git is not available: ${r.error.message}`);
  return { status: r.status ?? 1, stdout: r.stdout.split("\r\n").join("\n").trimEnd(), stderr: (r.stderr || "").trim() };
}

/** Run `fn` inside a throw-away detached worktree at `ref`; the user's checkout is never touched. */
export async function withTempWorktree<T>(root: string, ref: string, fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = join(mkdtempSync(join(tmpdir(), "aihub-wt-")), "wt");
  git(root, ["worktree", "add", "--detach", dir, ref]);
  try {
    return await fn(dir);
  } finally {
    gitRaw(root, ["worktree", "remove", "--force", dir]);
    try {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    gitRaw(root, ["worktree", "prune"]);
  }
}

/** Fetch one branch of origin into refs/remotes/origin/<branch>. Returns false when origin has no such branch. */
export function fetchBranch(root: string, branch: string): boolean {
  return gitRaw(root, ["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]).status === 0;
}
