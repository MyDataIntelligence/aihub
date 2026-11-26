import { spawn } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { BACKGROUND_ENV, type GitRun } from "./ownWindow";

/**
 * Cloning a repository from the search of the left menu: where it goes, the clone itself with progress and Cancel, and
 * Undo. One `git clone` per clone; never a sign-in window (BACKGROUND_ENV), a folder that exists is never touched. No vscode.
 */

/** When a clone was last used: the newest of .git/index and .git/HEAD. */
function usedAt(dir: string): number {
  let t = 0;
  for (const f of ["index", "HEAD"]) {
    try {
      t = Math.max(t, statSync(join(dir, ".git", f)).mtimeMs);
    } catch {
      /* missing */
    }
  }
  return t;
}

/** The folder a new clone goes into: the first of Folders to Look In, else the folder holding the most recently used clone. */
export function cloneParent(lookIn: string[], clones: string[], used: (dir: string) => number = usedAt): string | undefined {
  if (lookIn[0]) return lookIn[0];
  const best = [...clones].sort((a, b) => used(b) - used(a))[0];
  return best ? dirname(best) : undefined;
}

/** A folder name for the repository (Azure DevOps allows characters Windows does not). */
export const folderName = (repo: string): string => repo.replace(/[<>:"/\\|?*]/g, "-").replace(/[. ]+$/, "") || "repository";

/** git's progress line as one percentage: counting and compressing 0-5, receiving 5-90, resolving deltas 90-100. */
export function progressOf(line: string): number | undefined {
  const m = /(Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files):\s+(\d+)%/.exec(line);
  if (!m) return undefined;
  const p = Number(m[2]);
  if (m[1] === "Receiving objects") return Math.round(5 + p * 0.85);
  if (m[1] === "Resolving deltas") return Math.round(90 + p * 0.08);
  if (m[1] === "Updating files") return Math.round(98 + p * 0.02);
  return Math.round(p * 0.05);
}

/** The sentence to show when git could not sign in from the background. */
export const SIGN_IN_HINT = "git could not sign in without a window: run 'git clone' of this repository once in a terminal (or sign in with Git Credential Manager), then clone again";

export type CloneOutcome = { ok: true } | { ok: false; cancelled: boolean; error: string };

/**
 * `git clone --progress <url> <dir>`: reports percentages, stops on `cancel` and then removes the half clone. `dir` must
 * not exist (the caller checked; checked again here). Never prompts for a login.
 */
export function cloneWithProgress(o: { url: string; dir: string; onProgress?: (pct: number) => void; onCancel?: (stop: () => void) => void; git?: string }): Promise<CloneOutcome> {
  if (existsSync(o.dir)) return Promise.resolve({ ok: false, cancelled: false, error: `${o.dir} exists already; nothing was overwritten` });
  return new Promise((resolve) => {
    const p = spawn(o.git ?? "git", ["clone", "--progress", o.url, o.dir], { env: BACKGROUND_ENV, windowsHide: true });
    let cancelled = false;
    let err = "";
    let last = -1;
    o.onCancel?.(() => {
      cancelled = true;
      p.kill();
    });
    p.stderr.on("data", (b: Buffer) => {
      const text = b.toString();
      err = (err + text).slice(-4000);
      for (const l of text.split(/[\r\n]+/)) {
        const pct = progressOf(l);
        if (pct !== undefined && pct > last) o.onProgress?.((last = pct));
      }
    });
    p.on("error", (e) => finish(e.message));
    p.on("close", (code) => finish(code === 0 && !cancelled ? undefined : err));
    let done = false;
    function finish(error: string | undefined) {
      if (done) return;
      done = true;
      if (error === undefined) return resolve({ ok: true });
      removeFolder(o.dir);
      const line = error.split(/\r?\n/).map((l) => l.trim()).find((l) => /^(fatal|error):/i.test(l)) ?? "";
      const login = /terminal prompts disabled|could not read Username|Authentication failed|credential/i.test(error);
      resolve({ ok: false, cancelled, error: cancelled ? "cancelled" : login ? SIGN_IN_HINT : line.replace(/^fatal:\s*/i, "") || "git clone failed" });
    }
  });
}

/** Removes a folder git made (read-only pack files included); quiet when it is gone already. */
export function removeFolder(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* a file in use: what is left can be removed by hand */
  }
}

/**
 * Nothing was changed or made in a fresh clone: no changed, new or ignored file, one local branch, and it is where origin's
 * branch of that name is. Only then may Undo remove it.
 */
export async function untouched(git: GitRun, dir: string): Promise<{ ok: boolean; why?: string }> {
  const status = (await git(dir, ["status", "--porcelain", "--ignored", "--untracked-files=all"])).trim();
  if (status) return { ok: false, why: "files in it were changed or added" };
  const heads = (await git(dir, ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"])).trim().split(/\r?\n/).filter(Boolean);
  if (heads.length !== 1) return { ok: false, why: "a branch was made in it" };
  const [name, sha] = heads[0].split(" ");
  const remote = (await git(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`]).catch(() => "")).trim();
  if (remote !== sha) return { ok: false, why: "a commit was made in it" };
  const worktrees = (await git(dir, ["worktree", "list", "--porcelain"])).split(/\r?\n/).filter((l) => l.startsWith("worktree ")).length;
  if (worktrees > 1) return { ok: false, why: "a worktree of it is still in use" };
  return { ok: true };
}
