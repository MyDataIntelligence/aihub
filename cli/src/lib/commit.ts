import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { currentBranch, git, pushIfNeeded, repoRoot, workItemFromBranch } from "./git.js";
import { isProtected, loadTeam } from "./team.js";

export interface CommitOpts {
  type?: string;
  scope?: string;
  subject?: string;
  story?: number;
  push?: boolean;
  noAdd?: boolean;
  json?: boolean;
}

export const DEFAULT_COMMIT_FORMAT = "{type}({scope}): {subject} (AB#{storyId})";

/** Fill a commit format; optional parts vanish cleanly when their value is unknown ("(scope)" and " (AB#id)"). */
export function formatCommit(format: string, v: { type?: string; scope?: string; subject: string; storyId?: number }): string {
  let out = format;
  out = v.scope ? out.replace(/\{scope\}/g, v.scope) : out.replace(/\(\{scope\}\)/g, "").replace(/\{scope\}/g, "");
  out = v.storyId ? out.replace(/\{storyId\}/g, String(v.storyId)) : out.replace(/\s*\(AB#\{storyId\}\)/g, "").replace(/\s*AB#\{storyId\}/g, "").replace(/\{storyId\}/g, "");
  out = out.replace(/\{type\}/g, v.type ?? "").replace(/\{subject\}/g, v.subject);
  return out.replace(/^:\s*/, "").replace(/\s+/g, " ").trim();
}

/** The most common top-level folder of the staged files (the scope), or undefined for root files. */
export function inferScope(files: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const f of files) {
    const i = f.indexOf("/");
    if (i > 0) counts.set(f.slice(0, i), (counts.get(f.slice(0, i)) ?? 0) + 1);
  }
  let best: string | undefined;
  let n = 0;
  for (const [k, c] of counts) if (c > n) (best = k), (n = c);
  return best?.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

/**
 * One call: stage everything (unless --no-add), build the commit message from the team's `commits.format` (story id from the branch name,
 * scope from the changed folder), commit, optionally push. The team decides the format in team.yaml; this code knows no team.
 */
export async function commitChanges(ctx: Ctx, o: CommitOpts): Promise<string> {
  const root = repoRoot(ctx.cwd);
  const branch = currentBranch(root);
  const team = loadTeam(root);
  if (isProtected(team, branch)) throw new AihubError(`'${branch}' is a protected branch; commit on a feature branch`);
  if (!o.subject?.trim()) throw new AihubError('--subject "<what changed>" is required');
  const format = team.commits?.format || (o.type ? DEFAULT_COMMIT_FORMAT : "{subject} (AB#{storyId})");
  const types = team.commits?.types ?? [];
  if (o.type && types.length && !types.includes(o.type)) throw new AihubError(`--type must be one of: ${types.join(", ")}`);
  if (/\{type\}/.test(format) && !o.type) throw new AihubError(`--type is required (${types.length ? types.join(", ") : "for example feat, fix"})`);

  if (!o.noAdd) git(root, ["add", "-A"]);
  const staged = git(root, ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
  if (staged.length === 0) throw new AihubError("nothing to commit: no staged or changed files");

  const storyId = o.story ?? workItemFromBranch(branch);
  const scope = o.scope ?? team.commits?.scope ?? inferScope(staged);
  const message = formatCommit(format, { type: o.type, scope, subject: o.subject.trim(), storyId });
  git(root, ["commit", "-q", "-m", message]);
  const sha = git(root, ["rev-parse", "--short", "HEAD"]);
  let pushed = false;
  if (o.push) {
    pushIfNeeded(root, branch);
    pushed = true;
  }
  return o.json ? JSON.stringify({ sha, message, branch, pushed, files: staged.length }) : `committed ${sha} on ${branch}${pushed ? " and pushed" : ""}: ${message}`;
}
