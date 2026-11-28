import { branchRef, getPr, getWorkItemPrIds, getWorkItemTitle, shortBranch, type AdoClient, type PullRequest } from "./ado.js";
import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { fetchBranch, git, gitRaw, withTempWorktree } from "./git.js";
import { commitList, parsePrRef } from "./pr.js";
import { compose, DEFAULT_EMPTY, emptyFor, parseSections, resolveTemplate } from "./templates.js";
import { isProtected, loadTeam, readUtf8, type TeamConfig } from "./team.js";
import { showFile } from "./git.js";

export type Source = { kind: "pr"; id: number } | { kind: "story"; id: number } | { kind: "commit"; sha: string };

/**
 * `--from` items, comma separated: `42` / `pr:42` / a pullrequest URL = PR; `story:7` / `AB#7` / a _workitems URL = story;
 * a hex string with 7-40 characters = commit. Plain digits up to 6 characters are always a PR number.
 */
export function parseSources(from: string): Source[] {
  const out: Source[] = [];
  for (const raw of from.split(",").map((s) => s.trim()).filter(Boolean)) {
    let m: RegExpExecArray | null;
    if ((m = /pullrequest\/(\d+)/i.exec(raw)) || (m = /^(?:pr:|!)(\d+)$/i.exec(raw))) out.push({ kind: "pr", id: Number(m[1]) });
    else if ((m = /_workitems\/edit\/(\d+)/i.exec(raw)) || (m = /^(?:story:|AB#)(\d+)$/i.exec(raw))) out.push({ kind: "story", id: Number(m[1]) });
    else if (/^\d{1,6}$/.test(raw)) out.push({ kind: "pr", id: parsePrRef(raw) });
    else if (/^[0-9a-f]{7,40}$/i.test(raw)) out.push({ kind: "commit", sha: raw.toLowerCase() });
    else throw new AihubError(`--from '${raw}' is not a PR, story or commit (use 42, pr:42, story:7 or a commit sha)`);
  }
  if (!out.length) throw new AihubError("--from is empty");
  return out;
}

export interface PickCommit {
  sha: string;
  mainline: boolean;
  subject: string;
}
export interface Resolved {
  label: string;
  commits: PickCommit[];
  story?: number;
  note?: string;
}

function commitInfo(root: string, sha: string): PickCommit {
  const line = git(root, ["rev-list", "--parents", "--format=%s", "-n1", sha]).split("\n");
  const parents = (line[0] ?? "").trim().split(/\s+/).length - 2; // "commit <sha> <parents..>"
  return { sha, mainline: parents > 1, subject: line[1] ?? "" };
}

async function resolvePrCommits(client: AdoClient, root: string, id: number): Promise<PickCommit[]> {
  const pr = (await getPr(client, id)) as PullRequest & { lastMergeCommit?: { commitId: string } };
  const tgt = shortBranch(pr.targetRefName);
  const src = shortBranch(pr.sourceRefName);
  fetchBranch(root, tgt);
  if (pr.status === "completed" && pr.lastMergeCommit?.commitId) {
    if (gitRaw(root, ["cat-file", "-e", pr.lastMergeCommit.commitId]).status !== 0) gitRaw(root, ["fetch", "--quiet", "origin", pr.lastMergeCommit.commitId]);
    return [commitInfo(root, pr.lastMergeCommit.commitId)];
  }
  if (!fetchBranch(root, src)) throw new AihubError(`PR !${id} is not completed and its source branch '${src}' is gone`);
  const base = git(root, ["merge-base", `origin/${tgt}`, `origin/${src}`]);
  const shas = git(root, ["rev-list", "--reverse", "--no-merges", `${base}..origin/${src}`]).split("\n").filter(Boolean);
  return shas.map((s) => commitInfo(root, s));
}

/** The story a commit message names with AB#<id>. */
export function storyFromText(text: string): number | undefined {
  const m = /AB#(\d{1,9})/i.exec(text);
  return m ? Number(m[1]) : undefined;
}

export async function resolveSources(client: AdoClient, root: string, sources: Source[]): Promise<Resolved> {
  const commits: PickCommit[] = [];
  const labels: string[] = [];
  let story: number | undefined;
  for (const s of sources) {
    if (s.kind === "pr") {
      labels.push(`pr${s.id}`);
      commits.push(...(await resolvePrCommits(client, root, s.id)));
    } else if (s.kind === "story") {
      labels.push(`story${s.id}`);
      story = s.id;
      const ids = await getWorkItemPrIds(client, s.id);
      if (!ids.length) throw new AihubError(`story ${s.id} has no linked pull requests`);
      for (const id of ids) commits.push(...(await resolvePrCommits(client, root, id)));
    } else {
      labels.push(s.sha.slice(0, 7));
      gitRaw(root, ["fetch", "--quiet", "origin"]);
      if (gitRaw(root, ["cat-file", "-e", `${s.sha}^{commit}`]).status !== 0) throw new AihubError(`commit ${s.sha} not found; fetch it first`);
      const info = commitInfo(root, git(root, ["rev-parse", s.sha]));
      commits.push(info);
      story ??= storyFromText(git(root, ["log", "-1", "--format=%B", info.sha], { allowFail: true }));
    }
  }
  // de-duplicate, keep order
  const seen = new Set<string>();
  const uniq = commits.filter((c) => !seen.has(c.sha) && !!seen.add(c.sha));
  return { label: labels.join("+").slice(0, 40), commits: uniq, story };
}

export interface TargetResult {
  target: string;
  result: "ok" | "conflict" | "already-applied" | "failed" | "refused";
  detail: string;
  branch?: string;
  pr?: { id: number; url: string };
}

export const pickBranchName = (label: string, target: string) => `cherry-pick/${label}-to-${target.replace(/[^A-Za-z0-9._-]+/g, "-")}`;

export interface CherryOpts {
  from: string;
  to: string[];
  toGroup?: string;
  /** Open a PR per target (the default); false = only push the cherry-pick branch (--no-pr). */
  pr?: boolean;
  direct?: boolean;
  bodyFile?: string;
  summaryText?: string;
  json?: boolean;
}

export async function cherryPick(ctx: Ctx, o: CherryOpts): Promise<void> {
  const { root, client } = repoClient(ctx);
  const team = loadTeam(root);
  const targets = [...o.to];
  if (o.toGroup) {
    const g = team.cherryPick?.groups?.[o.toGroup];
    if (!g?.length) throw new AihubError(`cherry-pick group '${o.toGroup}' is not in team.yaml (cherryPick.groups)`);
    targets.push(...g);
  }
  const uniqTargets = [...new Set(targets)];
  if (!uniqTargets.length) throw new AihubError("pass --to <branch> (repeatable) or --to-group <name>");
  if (o.direct && o.pr) throw new AihubError("--direct and --pr exclude each other");
  if (o.direct && o.summaryText) throw new AihubError("--summary-text belongs to the PR; --direct opens none");

  const src = await resolveSources(client, root, parseSources(o.from));
  if (!src.commits.length) throw new AihubError("nothing to cherry-pick: the source has no commits");

  const results: TargetResult[] = [];
  for (const t of uniqTargets) results.push(await pickOne(client, root, team, src, t, o));

  const failed = results.filter((r) => r.result === "conflict" || r.result === "failed" || r.result === "refused");
  if (o.json) {
    ctx.out(JSON.stringify({ source: src.label, commits: src.commits.map((c) => c.sha), results }));
  } else {
    ctx.out(`cherry-pick ${src.label} (${src.commits.length} commit${src.commits.length === 1 ? "" : "s"}) -> ${uniqTargets.length} target(s)`);
    const w = Math.max(...results.map((r) => r.target.length));
    for (const r of results) ctx.out(`${r.target.padEnd(w)}  ${r.result.padEnd(15)}  ${r.detail}${r.pr ? `  PR !${r.pr.id} ${r.pr.url}` : ""}`);
  }
  if (failed.length) throw new AihubError(`${failed.length} of ${results.length} target(s) need attention (${failed.map((f) => f.target).join(", ")})`);
}

async function pickOne(client: AdoClient, root: string, team: TeamConfig, src: Resolved, target: string, o: CherryOpts): Promise<TargetResult> {
  try {
    if (o.direct && isProtected(team, target)) return { target, result: "refused", detail: `'${target}' is protected; use --pr` };
    if (!fetchBranch(root, target)) return { target, result: "failed", detail: `branch '${target}' not found on origin` };
    const branch = pickBranchName(src.label, target);
    return await withTempWorktree(root, `origin/${target}`, async (wt) => {
      const start = git(wt, ["rev-parse", "HEAD"]);
      git(wt, ["checkout", "-q", "-b", branch]);
      for (const c of src.commits) {
        const r = gitRaw(wt, ["cherry-pick", ...(c.mainline ? ["-m", "1"] : []), c.sha]);
        if (r.status === 0) continue;
        const files = gitRaw(wt, ["diff", "--name-only", "--diff-filter=U"]).stdout.split("\n").filter(Boolean);
        if (files.length) {
          gitRaw(wt, ["cherry-pick", "--abort"]);
          return { target, result: "conflict", detail: `conflict in ${files.join(", ")} (${c.sha.slice(0, 7)}); nothing pushed` } as TargetResult;
        }
        if (/empty|nothing to commit/i.test(r.stdout + r.stderr)) {
          gitRaw(wt, ["cherry-pick", "--skip"]);
          continue;
        }
        gitRaw(wt, ["cherry-pick", "--abort"]);
        return { target, result: "failed", detail: r.stderr.split("\n")[0] || "cherry-pick failed" } as TargetResult;
      }
      if (git(wt, ["rev-parse", "HEAD"]) === start) return { target, result: "already-applied", detail: "target already contains these changes" } as TargetResult;
      const dest = o.direct ? target : branch;
      const push = gitRaw(wt, ["push", "--quiet", "origin", `HEAD:refs/heads/${dest}`]);
      if (push.status !== 0) return { target, result: "failed", detail: `push of '${dest}' rejected: ${push.stderr.split("\n").pop()}` } as TargetResult;
      const res: TargetResult = { target, result: "ok", branch: dest, detail: o.direct ? `pushed to ${dest}` : `pushed ${dest}` };
      if (!o.direct && o.pr !== false) res.pr = await createPickPr(client, root, team, src, target, branch, o.bodyFile, o.summaryText);
      return res;
    });
  } catch (e) {
    return { target, result: "failed", detail: (e as Error).message };
  }
}

async function createPickPr(client: AdoClient, root: string, team: TeamConfig, src: Resolved, target: string, branch: string, bodyFile?: string, summaryText?: string) {
  const commits = src.commits.map((c) => ({ sha: c.sha.slice(0, 7), subject: c.subject }));
  const wi = src.story;
  const wiTitle = wi ? await getWorkItemTitle(client, wi) : undefined;
  const title = `Cherry-pick ${src.label} to ${target}: ${commits[0].subject}`.slice(0, 200);
  const tpl = resolveTemplate(target, { readRef: (b, p) => showFile(root, b, p), localRoot: root });
  let body = bodyFile ? readUtf8(bodyFile) : "";
  if (summaryText?.trim()) {
    const first = tpl ? parseSections(tpl.content).sections[0]?.heading : undefined;
    body = first ? `## ${first}\n${summaryText.trim()}\n\n${body}` : `${summaryText.trim()}\n\n${body}`;
  }
  const code = { story: wi ? `AB#${wi}${wiTitle ? ` ${wiTitle}` : ""}` : undefined, commits: commitList(commits) };
  let description: string;
  if (tpl) description = compose({ template: tpl.content, body, code, emptyText: emptyFor(team) }).text;
  else description = [body.trim(), `## Commits\n\n${code.commits}`].filter(Boolean).join("\n\n") + "\n";
  const created = await client.post<PullRequest>(`${client.repoPath()}/pullrequests`, {
    sourceRefName: branchRef(branch),
    targetRefName: branchRef(target),
    title,
    description,
    ...(wi ? { workItemRefs: [{ id: String(wi) }] } : {}),
  });
  return { id: created.pullRequestId, url: client.prUrl(created.pullRequestId) };
}
