import { spawnSync } from "./proc.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AihubError } from "./errors.js";
import { git, pushIfNeeded } from "./git.js";
import { gitGate } from "./trace.js";

export interface IntegrateResult {
  integration: string;
  /** Branches merged in, in order. */
  merged: string[];
  /** Commits that were not on the integration branch before (merge commits left out). */
  commits: { sha: string; subject: string }[];
  pushed: boolean;
}

function tryGit(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  if (gitGate(cwd, args)) return { ok: true, out: "", err: "" };
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? "").replace(/\r\n/g, "\n").trim(), err: (r.stderr ?? "").trim() };
}

/**
 * Merge the feature branch (and `requires` branches that are behind) into the integration branch inside a
 * temporary worktree, then push the integration branch. The user's checkout is never touched. On a conflict
 * nothing is pushed.
 */
export function integrate(root: string, opts: { feature: string; integration: string; requires?: string[] }): IntegrateResult {
  const { feature, integration } = opts;
  const requires = (opts.requires ?? []).filter((b) => b !== integration && b !== feature);
  pushIfNeeded(root, feature); // the integration branch must only contain commits that exist on the remote
  git(root, ["fetch", "--prune", "origin"]);
  const base = tryGit(root, ["rev-parse", "--verify", "--quiet", `origin/${integration}`]);
  if (!base.ok) throw new AihubError(`integration branch '${integration}' does not exist on origin; check robot.integrationBranch in team.yaml`);
  for (const b of [feature, ...requires]) {
    if (!tryGit(root, ["rev-parse", "--verify", "--quiet", `origin/${b}`]).ok) throw new AihubError(`branch '${b}' does not exist on origin`);
  }

  const dir = mkdtempSync(join(tmpdir(), "aihub-integrate-"));
  const wt = join(dir, "wt");
  try {
    git(root, ["worktree", "add", "--detach", wt, `origin/${integration}`]);
    const merged: string[] = [];
    // requires first so the feature lands on top of them
    for (const b of [...requires, feature]) {
      if (tryGit(wt, ["merge-base", "--is-ancestor", `origin/${b}`, "HEAD"]).ok) continue;
      const m = tryGit(wt, ["merge", "--no-edit", "--no-ff", "-m", `Merge ${b} into ${integration}`, `origin/${b}`]);
      if (!m.ok) {
        const files = tryGit(wt, ["diff", "--name-only", "--diff-filter=U"]).out.split("\n").filter(Boolean);
        tryGit(wt, ["merge", "--abort"]);
        if (!files.length) throw new AihubError(`merging ${b} into ${integration} failed: ${(m.err || m.out).split("\n")[0]}; nothing was pushed`);
        throw new AihubError(`merge conflict merging ${b} into ${integration} in: ${files.join(", ")}; nothing was pushed. Resolve it on your branch first (merge ${integration} into it).`);
      }
      merged.push(b);
    }
    const log = tryGit(wt, ["log", "--no-merges", "--reverse", "--format=%h%x09%s", `origin/${integration}..HEAD`]).out;
    const commits = log
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha, ...rest] = l.split("\t");
        return { sha, subject: rest.join("\t") };
      });
    const changed = tryGit(wt, ["rev-parse", "HEAD"]).out !== tryGit(wt, ["rev-parse", `origin/${integration}`]).out;
    if (changed) {
      const p = tryGit(wt, ["push", "origin", `HEAD:refs/heads/${integration}`]);
      if (!p.ok) throw new AihubError(`pushing ${integration} failed: ${p.err.split("\n")[0]}`);
    }
    return { integration, merged, commits, pushed: changed };
  } finally {
    tryGit(root, ["worktree", "remove", "--force", wt]);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* temp cleanup is best effort */
    }
  }
}

export function formatIntegrate(feature: string, r: IntegrateResult): string {
  if (!r.pushed) return `${r.integration} already contains ${feature}: nothing to merge`;
  const lines = [`merged ${r.merged.join(", ")} into ${r.integration} and pushed it; ${r.commits.length} commit${r.commits.length === 1 ? "" : "s"} went in:`];
  for (const c of r.commits) lines.push(`  ${c.sha} ${c.subject}`);
  return lines.join("\n");
}
