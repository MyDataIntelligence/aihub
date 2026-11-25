import type { GitRun } from "./ownWindow";

/**
 * Update all, Push all, Commit all: one action over every (ticked) repository of the set. A failure in one repository
 * never stops the others; the answer is one line per repository. No vscode here.
 */
export interface RepoRef {
  name: string;
  path: string;
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

/** Runs `one` for each repository, two at a time at most, and keeps going when one fails (it becomes that repository's line). */
export async function eachRepo(repos: RepoRef[], one: (r: RepoRef) => Promise<RepoResult>, limit = 2): Promise<RepoResult[]> {
  const out: RepoResult[] = new Array(repos.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < repos.length; i = next++) {
      try {
        out[i] = await one(repos[i]);
      } catch (e) {
        out[i] = { repo: repos[i].name, ok: false, line: `${repos[i].name}: ${first(errText(e), 1)}`, detail: errText(e) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, repos.length) }, worker));
  return out;
}

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
    const why = /diverg|not possible to fast-forward|Not possible/i.test(t) ? "has commits of its own and the remote has others: update from the target or rebase it yourself" : /no tracking|no upstream/i.test(t) ? "has no remote branch yet" : first(t, 1);
    return { repo: r.name, ok: false, line: `${r.name}: not updated, ${why}`, detail: t };
  }
}

/** `git push` in one repository; a branch without a remote branch gets one (`--set-upstream origin HEAD`). */
export async function pushOne(git: GitRun, r: RepoRef): Promise<RepoResult> {
  try {
    const hasUpstream = await git(r.path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).then(() => true, () => false);
    const ahead = hasUpstream ? Number((await git(r.path, ["rev-list", "--count", "@{u}..HEAD"])).trim()) : 1;
    if (hasUpstream && ahead === 0) return { repo: r.name, ok: true, line: `${r.name}: nothing to push` };
    const out = await git(r.path, hasUpstream ? ["push"] : ["push", "--set-upstream", "origin", "HEAD"]);
    return { repo: r.name, ok: true, line: hasUpstream ? `${r.name}: pushed ${ahead} commit${ahead === 1 ? "" : "s"}` : `${r.name}: pushed, new remote branch`, detail: first(out) };
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
export async function commitOne(cli: (args: string[], cwd: string) => Promise<string>, r: RepoRef, message: string, push: boolean): Promise<RepoResult> {
  const m = parseMessage(message);
  const args = ["commit", ...(m.type ? ["--type", m.type] : []), ...(m.scope ? ["--scope", m.scope] : []), "--subject", m.subject, ...(push ? ["--push"] : []), "--json"];
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

/** One message for the user: how many went well, and the lines of those that did not. */
export function summarize(what: string, results: RepoResult[]): string {
  const bad = results.filter((r) => !r.ok);
  const head = bad.length ? `${what}: ${results.length - bad.length} of ${results.length} repositories done` : `${what}: ${results.length} ${results.length === 1 ? "repository" : "repositories"} done`;
  return [head, ...results.map((r) => r.line)].join("\n");
}
