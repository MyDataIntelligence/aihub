import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { git, gitRaw, hasRef, originDefaultBranch, repoRoot, showFile } from "./git.js";
import { createPr } from "./pr.js";
import { loadTeam } from "./team.js";

/**
 * Team knowledge (known fixes, rules) is never written silently: every change is a pull request that a person merges.
 * The change is made in a throw-away git worktree on a new branch from the default branch, so the user's checkout and
 * branch are not touched.
 */
export interface Proposal {
  /** Path in the repository. */
  file: string;
  /** New content from the current content on the target branch (undefined: the file does not exist there). Return the same text for "nothing to do". */
  change: (current: string | undefined) => string;
  branch: string;
  title: string;
  /** First section of the PR description. */
  summary: string;
  commitMessage?: string;
}

export interface ProposalResult {
  changed: boolean;
  branch?: string;
  pr?: string;
}

export function targetOf(root: string): string {
  const team = loadTeam(root);
  const first = ((team.repositories ?? []) as { defaultTarget?: string }[])[0]?.defaultTarget;
  return first || originDefaultBranch(root) || "main";
}

/** The file as it is on the target branch (what a PR would change), else in the working tree. */
export function currentTeamFile(root: string, file: string): string | undefined {
  const target = targetOf(root);
  const ref = hasRef(root, `origin/${target}`) ? `origin/${target}` : hasRef(root, target) ? target : undefined;
  const there = ref ? showFile(root, ref, file) : undefined;
  if (there !== undefined) return there;
  const local = join(root, file);
  return existsSync(local) ? readFileSync(local, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n") : undefined;
}

export async function proposeTeamChange(ctx: Ctx, p: Proposal): Promise<ProposalResult> {
  const root = repoRoot(ctx.cwd);
  const target = targetOf(root);
  const base = hasRef(root, `origin/${target}`) ? `origin/${target}` : "HEAD";
  const before = showFile(root, base === "HEAD" ? "HEAD" : base, p.file);
  const after = p.change(before);
  if (before !== undefined && after === before) return { changed: false };
  if (hasRef(root, `refs/heads/${p.branch}`) || git(root, ["ls-remote", "--heads", "origin", p.branch], { allowFail: true }).trim()) {
    throw new AihubError(`branch '${p.branch}' already exists (an earlier proposal is still open); merge or delete it first`);
  }
  const tmp = mkdtempSync(join(tmpdir(), "aihub-team-"));
  const wt = join(tmp, "wt");
  git(root, ["worktree", "add", "-q", "-b", p.branch, wt, base]);
  try {
    const out = join(wt, p.file);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, after, "utf8");
    git(wt, ["add", "--", p.file]);
    git(wt, ["commit", "-q", "-m", p.commitMessage ?? p.title, "--", p.file]);
    const bodyFile = join(tmp, "body.md");
    writeFileSync(bodyFile, "", "utf8");
    const pr = await createPr({ ...ctx, cwd: wt }, { title: p.title, bodyFile, summaryText: p.summary, target });
    return { changed: true, branch: p.branch, pr };
  } finally {
    gitRaw(root, ["worktree", "remove", "--force", wt]);
    gitRaw(root, ["branch", "-D", p.branch]);
    rmSync(tmp, { recursive: true, force: true });
  }
}
