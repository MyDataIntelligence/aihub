import { plainError } from "./plainError";
import { existsSync } from "node:fs";
import { headBranchOf } from "../../../cli/src/lib/machineScan";
import { isOffline, operationInProgress } from "./behind";
import type { GitRun } from "./ownWindow";

/**
 * Update all, Push all, Commit all: one action over every (ticked) repository of the set. A failure in one repository
 * never stops the others; the answer is one line per repository. No vscode here.
 */
export interface RepoRef {
  name: string;
  path: string;
  /** commit exactly these files (relative paths); absent: every change of this repository */
  files?: string[];
}

export interface RepoResult {
  repo: string;
  ok: boolean;
  /** one short line for the user */
  line: string;
  /** the first lines of what went wrong or was said, for the log */
  detail?: string;
}

const first = (t: string, n = 3) => t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, n).join(" | ");
const errText = (e: unknown) => (e as Error).message ?? String(e);

/** Why nothing should be done to this repository now: its folder is gone, or a merge, rebase, cherry-pick or revert is in the middle. */
export function unfit(path: string): string | undefined {
  if (!existsSync(path)) return "its folder is missing (aihub worktree repair makes it again)";
  const busy = operationInProgress(path);
  return busy ? `${busy} is in progress; finish or abort it first` : undefined;
}

/** Runs `one` for each repository, two at a time at most, and keeps going when one fails (it becomes that repository's line). */
export async function eachRepo(repos: RepoRef[], one: (r: RepoRef) => Promise<RepoResult>, limit = 2): Promise<RepoResult[]> {
  const out: RepoResult[] = new Array(repos.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < repos.length; i = next++) {
      try {
        const why = unfit(repos[i].path);
        if (why) {
          out[i] = { repo: repos[i].name, ok: false, line: `${repos[i].name}: ${why}` };
          continue;
        }
        out[i] = await one(repos[i]);
      } catch (e) {
        out[i] = { repo: repos[i].name, ok: false, line: `${repos[i].name}: ${first(errText(e), 1)}`, detail: errText(e) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, repos.length) }, worker));
  return out;
}

/** The reason Update All gives for a branch that has commits of its own while its remote has others; the message offers "Update from Target" for it. */
export const DIVERGED = "has commits of its own and the remote has others: use Update from Target";

/** The repositories Update All could not fast-forward because they have commits of their own. */
export const divergedRepos = (repos: RepoRef[], results: RepoResult[]): RepoRef[] => repos.filter((r) => results.some((x) => x.repo === r.name && !x.ok && x.line.includes(DIVERGED)));

/** `git pull --ff-only` in one repository: what came in, "already up to date", or why it did not (diverged, no upstream, uncommitted work in the way). */
export async function updateOne(git: GitRun, r: RepoRef): Promise<RepoResult> {
  try {
    const before = (await git(r.path, ["rev-parse", "HEAD"])).trim();
    const out = await git(r.path, ["pull", "--ff-only"]);
    const after = (await git(r.path, ["rev-parse", "HEAD"])).trim();
    if (before === after) return { repo: r.name, ok: true, line: `${r.name}: already up to date` };
    const n = (await git(r.path, ["rev-list", "--count", `${before}..${after}`])).trim();
    return { repo: r.name, ok: true, line: `${r.name}: ${n} new commit${n === "1" ? "" : "s"}`, detail: first(out) };
  } catch (e) {
    const t = errText(e);
    const why = /diverg|not possible to fast-forward|Not possible/i.test(t) ? DIVERGED : /no tracking|no upstream/i.test(t) ? "has no remote branch yet" : plainError(t).text;
    return { repo: r.name, ok: false, line: `${r.name}: not updated, ${why}`, detail: t };
  }
}

/** `git push` in one repository; a branch without a remote branch gets one (`--set-upstream origin HEAD`). */
export async function pushOne(git: GitRun, r: RepoRef, o: { protect?: string[] } = {}): Promise<RepoResult> {
  const branch = headBranchOf(r.path);
  if (!branch) return { repo: r.name, ok: false, line: `${r.name}: detached HEAD, nothing was pushed (check out a branch first)` };
  // the target and the protected branches (main, master, staging, team.yaml) are never pushed from here: they go through a pull request
  if ((o.protect ?? []).some((p) => p.toLowerCase() === branch.toLowerCase())) return { repo: r.name, ok: true, line: `${r.name}: on ${branch}, a protected or target branch: left alone` };
  try {
    // the branch itself, spelled out: never what push.default would pick (upstream, matching), never another branch
    const remote = await git(r.path, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]).then((o) => o.trim(), () => "");
    const ahead = remote ? Number((await git(r.path, ["rev-list", "--count", `origin/${branch}..HEAD`])).trim()) : 1;
    if (remote && ahead === 0) return { repo: r.name, ok: true, line: `${r.name}: nothing to push` };
    const tracked = await git(r.path, ["config", "--get", `branch.${branch}.merge`]).then(() => true, () => false);
    const out = await git(r.path, ["push", ...(tracked ? [] : ["--set-upstream"]), "origin", `HEAD:refs/heads/${branch}`]);
    return { repo: r.name, ok: true, line: remote ? `${r.name}: pushed ${ahead} commit${ahead === 1 ? "" : "s"}` : `${r.name}: pushed, new remote branch`, detail: first(out) };
  } catch (e) {
    const t = errText(e);
    return { repo: r.name, ok: false, line: `${r.name}: not pushed, ${first(t, 1)}`, detail: t };
  }
}

/** "feat(scope): subject" is type, scope and subject for `aihub commit`; any other text is the subject. */
export function parseMessage(message: string): { type?: string; scope?: string; subject: string } {
  const m = /^(\w+)(?:\(([^)]+)\))?!?:\s+(.+)$/s.exec(message.trim());
  return m ? { type: m[1], ...(m[2] ? { scope: m[2] } : {}), subject: m[3].trim() } : { subject: message.trim() };
}

/**
 * One commit with `aihub commit` in one repository: the CLI stages, builds the message from the team's format, runs the
 * hooks and explains a failing hook with its choices; that explanation is this repository's line. `cli` runs in the repository.
 */
export async function commitOne(cli: (args: string[], cwd: string) => Promise<string>, r: RepoRef, message: string, push: boolean, git?: GitRun): Promise<RepoResult> {
  const m = parseMessage(message);
  // exactly the listed files: they are added by name, nothing else is added, and files that are staged already but not listed stop it
  const only = r.files?.length && git ? r.files : undefined;
  if (only && git) {
    try {
      await git(r.path, ["add", "--", ...only]);
      const staged = (await git(r.path, ["diff", "--cached", "--name-only", "-z"])).split(String.fromCharCode(0)).filter(Boolean);
      const extra = staged.filter((f) => !only.includes(f));
      if (extra.length) return { repo: r.name, ok: false, line: `${r.name}: ${extra.length} other file${extra.length === 1 ? " is" : "s are"} staged already (${extra.slice(0, 3).join(", ")}); unstage ${extra.length === 1 ? "it" : "them"} or leave the file list out`, detail: extra.join("\n") };
    } catch (e) {
      return { repo: r.name, ok: false, line: `${r.name}: ${first(errText(e), 1)}`, detail: errText(e) };
    }
  }
  const args = ["commit", ...(m.type ? ["--type", m.type] : []), ...(m.scope ? ["--scope", m.scope] : []), "--subject", m.subject, ...(only ? ["--no-add"] : []), ...(push ? ["--push"] : []), "--json"];
  try {
    const out = await cli(args, r.path);
    const j = JSON.parse(out.slice(out.indexOf("{"))) as { sha?: string; files?: number; pushed?: boolean };
    return { repo: r.name, ok: true, line: `${r.name}: committed ${j.sha ?? ""}${j.files ? ` (${j.files} file${j.files === 1 ? "" : "s"})` : ""}${j.pushed ? ", pushed" : ""}`.trim(), detail: out };
  } catch (e) {
    const t = errText(e);
    // a repository with nothing to commit is fine, not a failure
    if (/nothing to commit/i.test(t)) return { repo: r.name, ok: true, line: `${r.name}: nothing to commit` };
    return { repo: r.name, ok: false, line: `${r.name}: ${first(t, 1)}`, detail: t };
  }
}

/** Every repository that failed failed for lack of a network: one quiet sentence instead of one error per repository. */
export function offlineSummary(what: string, results: RepoResult[]): string | undefined {
  const bad = results.filter((r) => !r.ok);
  return bad.length > 0 && bad.every((r) => isOffline(`${r.detail ?? ""} ${r.line}`)) ? `${what}: no network right now, nothing was changed on the remote; try again when you are online` : undefined;
}

/** One message for the user: how many went well, and the lines of those that did not. */
export function summarize(what: string, results: RepoResult[]): string {
  const bad = results.filter((r) => !r.ok);
  const head = bad.length ? `${what}: ${results.length - bad.length} of ${results.length} repositories done` : `${what}: ${results.length} ${results.length === 1 ? "repository" : "repositories"} done`;
  return [head, ...results.map((r) => r.line)].join("\n");
}
