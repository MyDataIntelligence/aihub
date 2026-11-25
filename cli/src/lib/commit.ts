import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { currentBranch, git, gitRaw, repoRoot, workItemFromBranch } from "./git.js";
import { digestHookOutput, formatHookFailure } from "./hookDigest.js";
import { ARTIFACT_EXCLUDES } from "./gitx.js";
import { isProtected, loadTeam } from "./team.js";

export interface CommitOpts {
  type?: string;
  scope?: string;
  subject?: string;
  story?: number;
  push?: boolean;
  noAdd?: boolean;
  /** Skip the repository's git hooks. Only when the user explicitly asked for it; the CLI never decides this. */
  noVerify?: boolean;
  /** Skip only these hook ids (the pre-commit framework reads them from SKIP). Only at the user's request. */
  skipHooks?: string[];
  json?: boolean;
}

/** Names of the git hooks that exist for these stages (respects core.hooksPath); `.sample` files do not count. */
export function activeHooks(root: string, stages: string[]): string[] {
  const dir = resolve(root, git(root, ["rev-parse", "--git-path", "hooks"], { allowFail: true }).trim() || ".git/hooks");
  if (!existsSync(dir)) return [];
  const have = new Set(readdirSync(dir).filter((f) => !f.endsWith(".sample")));
  return stages.filter((s) => have.has(s));
}

export const COMMIT_HOOKS = ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"];
export const PUSH_HOOKS = ["pre-push"];
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

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

/** The command to run again after a hook failure: the same call, without hook flags. */
function againCommand(o: CommitOpts): string {
  const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
  return ["aihub commit", o.type ? `--type ${o.type}` : "", o.scope ? `--scope ${o.scope}` : "", `--subject ${q((o.subject ?? "").trim())}`, o.story ? `--story ${o.story}` : "", o.push ? "--push" : "", o.noAdd ? "--no-add" : ""]
    .filter(Boolean)
    .join(" ");
}

/** Keeps the whole hook output next to the journal (never committed) and returns the path, or "" when it cannot be written. */
function saveHookOutput(root: string, text: string): string {
  try {
    const dir = resolve(root, git(root, ["rev-parse", "--git-common-dir"], { allowFail: true }).trim() || ".git", "aihub");
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, "last-hook-output.txt");
    writeFileSync(file, text, "utf8");
    return file;
  } catch {
    return "";
  }
}

const firstLines = (text: string, n = 3) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, n)
    .join(" | ");
/** A push the remote refused (not a hook): behind, no rights, no network. */
const REMOTE_REFUSAL = /\[rejected\]|\[remote rejected\]|non-fast-forward|fetch first|Authentication failed|could not read from remote|Could not resolve host|TF\d{6}/i;

/**
 * One call: stage everything (unless --no-add), build the commit message from the team's `commits.format` (story id from the branch name,
 * scope from the changed folder), commit, optionally push. The team decides the format in team.yaml; this code knows no team.
 * A hook that stops the commit or the push is reported in plain words (which check, its first lines, what the hook changed itself)
 * with the choices: fix and run again, skip that check, or skip all hooks. Hooks that only reformatted files get one second try.
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
  // pre-commit (the framework) skips the hook ids in SKIP; other hook runners ignore it
  const skip = (o.skipHooks ?? []).filter(Boolean);
  const env = skip.length ? { SKIP: skip.join(",") } : undefined;
  const skipNote = o.noVerify ? " (hooks skipped at the user's request)" : skip.length ? ` (skipped at the user's request: ${skip.join(", ")})` : "";

  if (!o.noAdd) git(root, ["add", "-A", "--", ".", ...ARTIFACT_EXCLUDES]);
  const staged = git(root, ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
  const pushHooks = o.push && !o.noVerify ? activeHooks(root, PUSH_HOOKS) : [];

  /** Push when the remote branch is not at HEAD yet; a hook that stops it is reported with the choices. */
  const push = (lead: string): { pushed: boolean; ms: number } => {
    const remoteSha = git(root, ["ls-remote", "--heads", "origin", branch], { allowFail: true }).split(/\s+/)[0];
    if (remoteSha === git(root, ["rev-parse", "HEAD"]).trim()) return { pushed: false, ms: 0 };
    if (pushHooks.length && !o.json) ctx.out(`git hooks running on push: ${pushHooks.join(", ")}`);
    const t1 = Date.now();
    const r = gitRaw(root, ["push", ...(o.noVerify ? ["--no-verify"] : []), "--set-upstream", "origin", `HEAD:refs/heads/${branch}`], env);
    const ms = Date.now() - t1;
    if (r.status === 0) return { pushed: true, ms };
    const output = [r.stdout, r.stderr].filter(Boolean).join("\n");
    if (!pushHooks.length || REMOTE_REFUSAL.test(output)) throw new AihubError(`${lead}; not pushed: ${firstLines(output) || "git push failed"}`);
    throw new AihubError(
      formatHookFailure({ what: "push", stages: pushHooks, digest: digestHookOutput(output), changedByHooks: [], seconds: secs(ms), again: againCommand({ ...o, push: true }), fullOutputFile: saveHookOutput(root, output), lead }),
    );
  };

  if (staged.length === 0) {
    // the commit is already there and only the push is left (a pre-push hook stopped it last time)
    if (o.push) {
      const sha = git(root, ["rev-parse", "--short", "HEAD"]);
      const p = push(`nothing new to commit, ${sha} on ${branch}`);
      if (p.pushed) {
        return o.json
          ? JSON.stringify({ sha, branch, pushed: true, files: 0, pushHooks, pushMs: p.ms, noVerify: !!o.noVerify })
          : `pushed ${sha} on ${branch} (nothing new to commit)${skipNote}${pushHooks.length ? ` (push hooks took ${secs(p.ms)})` : ""}`;
      }
    }
    throw new AihubError("nothing to commit: no staged or changed files");
  }

  const storyId = o.story ?? workItemFromBranch(branch);
  const scope = o.scope ?? team.commits?.scope ?? inferScope(staged);
  const message = formatCommit(format, { type: o.type, scope, subject: o.subject.trim(), storyId });
  // The repository's hooks may run a long test suite: say so before, and how long it took after, instead of leaving a silent wait.
  const hooks = o.noVerify ? [] : activeHooks(root, COMMIT_HOOKS);
  if (hooks.length && !o.json) ctx.out(`git hooks running: ${hooks.join(", ")} (this repository's own hooks; if they run the full test suite it can take minutes)`);
  const commitArgs = ["commit", "-q", ...(o.noVerify ? ["--no-verify"] : []), "-m", message];
  const t0 = Date.now();
  let r = gitRaw(root, commitArgs, env);
  let secondTry = 0;
  if (r.status !== 0) {
    let output = [r.stdout, r.stderr].filter(Boolean).join("\n");
    if (!hooks.length) throw new AihubError(`git commit failed: ${firstLines(output) || "no message from git"}`);
    // what the hooks changed in the files that were being committed (a formatter rewrote them)
    const changedByHooks = () => {
      const dirty = new Set(git(root, ["diff", "--name-only"], { allowFail: true }).split("\n").filter(Boolean));
      return staged.filter((f) => dirty.has(f));
    };
    let changed = changedByHooks();
    let digest = digestHookOutput(output);
    if (changed.length && digest.onlyFixers) {
      // the hooks only reformatted: take their version and try once more
      git(root, ["add", "--", ...changed]);
      secondTry = changed.length;
      r = gitRaw(root, commitArgs, env);
      if (r.status !== 0) {
        output = [r.stdout, r.stderr].filter(Boolean).join("\n");
        digest = digestHookOutput(output);
        changed = changedByHooks();
      }
    }
    if (r.status !== 0) {
      // keep what the hooks fixed, so the next attempt starts from it
      if (changed.length) git(root, ["add", "--", ...changed], { allowFail: true });
      throw new AihubError(formatHookFailure({ what: "commit", stages: hooks, digest, changedByHooks: changed, seconds: secs(Date.now() - t0), again: againCommand(o), fullOutputFile: saveHookOutput(root, output) }));
    }
  }
  const commitMs = Date.now() - t0;
  const sha = git(root, ["rev-parse", "--short", "HEAD"]);
  let pushed = false;
  let pushMs = 0;
  if (o.push) {
    const p = push(`committed ${sha} on ${branch}`);
    pushed = p.pushed;
    pushMs = p.ms;
  }
  const timing = [hooks.length ? `commit hooks took ${secs(commitMs)}` : "", pushHooks.length ? `push hooks took ${secs(pushMs)}` : ""].filter(Boolean).join(", ");
  const retried = secondTry ? ` (the hooks reformatted ${secondTry} file(s); committed on the second try)` : "";
  return o.json
    ? JSON.stringify({ sha, message, branch, pushed, files: staged.length, hooks, pushHooks, commitMs, pushMs, noVerify: !!o.noVerify, skippedHooks: skip, reformattedByHooks: secondTry })
    : `committed ${sha} on ${branch}${pushed ? " and pushed" : ""}: ${message}${skipNote}${retried}${timing ? ` (${timing})` : ""}`;
}
