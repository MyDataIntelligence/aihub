import { AihubError } from "./errors.js";
import { mustGit, refSha, tryGit } from "./gitx.js";
import { workItemFromBranch } from "./git.js";

/** An existing local or origin branch that belongs to the story (prefers `preferred`). */
export function findStoryBranchName(dir: string, id: number, preferred?: string): string | undefined {
  return findStoryBranchNames(dir, id, preferred)[0];
}

export function findStoryBranchNames(dir: string, id: number, preferred?: string): string[] {
  const refs = tryGit(dir, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin"]).out.split("\n").filter(Boolean);
  const names = new Set<string>();
  for (const r of refs) {
    const n = r.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/origin\//, "");
    if (n === "HEAD") continue;
    if (workItemFromBranch(n) === id) names.add(n);
  }
  const all = [...names];
  return preferred && names.has(preferred) ? [preferred, ...all.filter((n) => n !== preferred)] : all;
}

export interface EnsureResult {
  created: boolean;
  pushed: boolean;
  from: string;
}

/** Creates `branch` from origin/<base> when it does not exist yet, and pushes it. Never touches the working tree. */
export function ensureBranch(dir: string, branch: string, base: string, push = true): EnsureResult {
  const hasLocal = refSha(dir, `refs/heads/${branch}`) !== "";
  const hasRemote = refSha(dir, `refs/remotes/origin/${branch}`) !== "";
  let created = false;
  let from = "";
  if (!hasLocal) {
    if (hasRemote) {
      mustGit(dir, ["branch", "--track", branch, `origin/${branch}`]);
      from = `origin/${branch}`;
    } else {
      from = refSha(dir, `refs/remotes/origin/${base}`) ? `origin/${base}` : base;
      if (!refSha(dir, from)) throw new AihubError(`base branch '${base}' not found in ${dir}; pass --base <branch>`);
      mustGit(dir, ["branch", branch, from]);
      created = true;
    }
  }
  let pushed = false;
  if (push && !hasRemote) {
    mustGit(dir, ["push", "--set-upstream", "origin", `refs/heads/${branch}:refs/heads/${branch}`]);
    pushed = true;
  }
  return { created, pushed, from };
}
