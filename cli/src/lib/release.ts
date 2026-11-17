import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { branchRef, getPr, getWorkItemPrIds, shortBranch, type PullRequest } from "./ado.js";
import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { showFile } from "./git.js";
import { isAncestor, mustGit, refSha, tryGit } from "./gitx.js";
import { fetchOrigin } from "./repos.js";
import { baseFor } from "./story-flow.js";
import { compose, DEFAULT_EMPTY, resolveTemplate } from "./templates.js";
import { loadTeam, readUtf8 } from "./team.js";
import { slugify } from "./workitems.js";

export interface PlanItem {
  pr?: number;
  title: string;
  commit: string;
  story?: number;
}

export interface ReleasePlan {
  version: 1;
  repo: string;
  name: string;
  targets: string[];
  items: PlanItem[];
  notes?: string[];
}

interface DonePr extends PullRequest {
  closedDate?: string;
  lastMergeCommit?: { commitId: string };
  workItemRefs?: { id: string }[];
}

export interface PlanOpts {
  stories?: number[];
  commits?: string[];
  tags?: string[];
  version?: string;
  prs?: number[];
  target?: string;
  also?: string[];
  name?: string;
  out?: string;
  json?: boolean;
}

export async function releasePlan(ctx: Ctx, o: PlanOpts): Promise<string> {
  if (!o.stories?.length && !o.prs?.length && !o.commits?.length && !o.tags?.length) throw new AihubError("pass --prs a,b, --stories a,b, --commits sha,sha or --tags v1,v2");
  const { root, client } = repoClient(ctx);
  const team = loadTeam(root);
  const target = o.target ?? (await baseFor(root, client, team));
  const notes: string[] = [];
  const prIds = new Set<number>(o.prs ?? []);
  const storyOf = new Map<number, number>();
  for (const s of o.stories ?? []) {
    const ids = await getWorkItemPrIds(client, s);
    if (!ids.length) notes.push(`story ${s}: no linked pull request found`);
    for (const id of ids) {
      prIds.add(id);
      storyOf.set(id, s);
    }
  }
  const items: (PlanItem & { closed: string })[] = [];
  for (const id of prIds) {
    let pr: DonePr;
    try {
      pr = (await getPr(client, id)) as DonePr;
    } catch (e) {
      if (storyOf.has(id)) {
        notes.push(`!${id}: skipped, not a pull request of this repository`);
        continue;
      }
      throw e;
    }
    if (pr.status !== "completed" || !pr.lastMergeCommit?.commitId) {
      notes.push(`!${id}: skipped, it is ${pr.status} (only merged PRs can be released)`);
      continue;
    }
    const story = storyOf.get(id) ?? (pr.workItemRefs?.[0] ? Number(pr.workItemRefs[0].id) : undefined);
    items.push({ pr: id, title: pr.title, commit: pr.lastMergeCommit.commitId, story, closed: pr.closedDate ?? "" });
  }
  items.sort((a, b) => a.closed.localeCompare(b.closed) || (a.pr ?? 0) - (b.pr ?? 0));
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const plan: ReleasePlan = {
    version: 1,
    repo: client.remote.repo,
    name: o.name ?? `release/${o.version ?? date}`,
    targets: [target, ...(o.also ?? []).filter((t) => t !== target)],
    items: [...items.map(({ closed: _c, ...rest }) => rest), ...commitItems(root, o, notes).filter((ci) => !items.some((i) => i.commit === ci.commit))],
    ...(notes.length ? { notes } : {}),
  };
  const text = stringify(plan);
  if (o.out) writeFileSync(o.out, text, "utf8");
  if (o.json) return JSON.stringify(plan);
  return `${text}${o.out ? `\nplan written to ${o.out}` : ""}`;
}

function readPlan(file: string): ReleasePlan {
  const p = parse(readUtf8(file)) as Partial<ReleasePlan> | null;
  if (!p || !Array.isArray(p.items) || !Array.isArray(p.targets) || !p.name) throw new AihubError("plan file must have name, targets and items (create it with 'aihub release plan')");
  for (const [i, it] of p.items.entries()) if (!it.commit) throw new AihubError(`items[${i}] needs a commit`);
  return p as ReleasePlan;
}

const lab = (i: PlanItem): string => (i.pr ? `!${i.pr}` : i.commit.slice(0, 8));

/** Commits named directly (--commits) or through tags (--tags: one tag = that commit, two tags = the range between them). */
function commitItems(root: string, o: PlanOpts, notes: string[]): PlanItem[] {
  const out: PlanItem[] = [];
  const add = (sha: string) => {
    if (out.some((x) => x.commit === sha)) return;
    out.push({ commit: sha, title: tryGit(root, ["log", "-1", "--format=%s", sha]).out.trim() || sha.slice(0, 8) });
  };
  const resolve = (ref: string): string => {
    const r = tryGit(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (!r.ok || !r.out.trim()) throw new AihubError(`'${ref}' is not a commit or tag in this clone (fetch tags first)`);
    return r.out.trim();
  };
  for (const c of o.commits ?? []) add(resolve(c));
  const tags = o.tags ?? [];
  if (tags.length > 2) throw new AihubError("--tags takes one tag (that commit) or two tags (the commits between them)");
  if (tags.length === 1) add(resolve(tags[0]));
  if (tags.length === 2) {
    const range = tryGit(root, ["rev-list", "--reverse", "--first-parent", `${resolve(tags[0])}..${resolve(tags[1])}`]);
    const shas = range.out.split("\n").filter(Boolean);
    if (!shas.length) notes.push(`tags ${tags[0]}..${tags[1]}: no commits in between`);
    shas.forEach(add);
  }
  return out;
}

export const releaseBranch = (plan: ReleasePlan, index: number): string =>
  index === 0 ? plan.name : `${plan.name}-to-${slugify(plan.targets[index], 30)}`;

export async function releaseRun(ctx: Ctx, o: { planFile: string; json?: boolean }): Promise<string> {
  const plan = readPlan(o.planFile);
  const { root, client } = repoClient(ctx);
  const team = loadTeam(root);
  if (plan.repo && plan.repo.toLowerCase() !== client.remote.repo.toLowerCase()) {
    throw new AihubError(`the plan is for repository '${plan.repo}', you are in '${client.remote.repo}'`);
  }
  fetchOrigin(root);
  const steps: string[] = [];
  const failed: string[] = [];
  for (const [ti, target] of plan.targets.entries()) {
    const branch = releaseBranch(plan, ti);
    const tag = `${target}`;
    const targetRef = refSha(root, `refs/remotes/origin/${target}`) ? `origin/${target}` : "";
    if (!targetRef) {
      steps.push(`${tag}: FAILED, branch origin/${target} not found`);
      failed.push(tag);
      continue;
    }
    if (refSha(root, `refs/remotes/origin/${branch}`) || refSha(root, `refs/heads/${branch}`)) {
      steps.push(`${tag}: FAILED, branch '${branch}' already exists; choose another --name`);
      failed.push(tag);
      continue;
    }
    const tmp = mkdtempSync(join(tmpdir(), "aihub-release-"));
    const wt = join(tmp, "wt");
    try {
      mustGit(root, ["worktree", "add", "-b", branch, wt, targetRef]);
      const applied: PlanItem[] = [];
      let broke = false;
      for (const it of plan.items) {
        if (!refSha(wt, it.commit)) {
          steps.push(`${tag}: ${lab(it)} FAILED, commit ${it.commit.slice(0, 8)} is not in this clone (fetch it first)`);
          broke = true;
          break;
        }
        if (isAncestor(wt, it.commit, "HEAD")) {
          steps.push(`${tag}: ${lab(it)} already in ${target}, skipped`);
          continue;
        }
        const parents = mustGit(wt, ["rev-list", "--parents", "-n", "1", it.commit]).split(" ").length - 1;
        const r = tryGit(wt, ["-c", "user.name=aihub", "-c", "user.email=aihub@localhost", "cherry-pick", "-x", ...(parents > 1 ? ["-m", "1"] : []), it.commit]);
        if (!r.ok) {
          const files = tryGit(wt, ["diff", "--name-only", "--diff-filter=U"]).out.split("\n").filter(Boolean);
          tryGit(wt, ["cherry-pick", "--abort"]);
          steps.push(`${tag}: ${lab(it)} FAILED, conflict${files.length ? ` in ${files.join(", ")}` : ""}; resolve it by hand (git cherry-pick ${it.commit.slice(0, 8)}) and rerun`);
          broke = true;
          break;
        }
        applied.push(it);
        steps.push(`${tag}: ${lab(it)} cherry-picked`);
      }
      if (broke) {
        failed.push(tag);
        continue;
      }
      if (!applied.length) {
        steps.push(`${tag}: nothing to release, everything is already in ${target}`);
        continue;
      }
      mustGit(wt, ["push", "--set-upstream", "origin", `refs/heads/${branch}:refs/heads/${branch}`]);
      steps.push(`${tag}: branch '${branch}' pushed`);
      const stories = [...new Set(applied.map((a) => a.story).filter((s): s is number => !!s))];
      const commits = applied.map((a) => `- ${a.title} (${lab(a)})`).join("\n");
      const tpl = resolveTemplate(target, { readRef: (b, p) => showFile(root, b, p), localRoot: root });
      const emptyText = team.pullRequest?.emptySection || DEFAULT_EMPTY;
      const code = { story: stories.length ? stories.map((s) => `AB#${s}`).join(", ") : undefined, commits };
      const description = tpl ? compose({ template: tpl.content, body: "", code, emptyText }).text : `Release ${plan.name}\n\n## Commits\n\n${commits}\n`;
      const created = await client.post<PullRequest>(`${client.repoPath()}/pullrequests`, {
        sourceRefName: branchRef(branch),
        targetRefName: branchRef(target),
        title: `Release ${shortBranch(plan.name)} -> ${target}`,
        description,
        ...(stories.length ? { workItemRefs: stories.map((s) => ({ id: String(s) })) } : {}),
      });
      steps.push(`${tag}: PR !${created.pullRequestId} created ${client.prUrl(created.pullRequestId)}`);
    } finally {
      tryGit(root, ["worktree", "remove", "--force", wt]);
      tryGit(root, ["branch", "-D", branch]);
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  const ok = failed.length === 0;
  if (!ok) steps.push(`release incomplete: ${failed.join(", ")} failed; the other targets are done`);
  if (!ok && o.json) return JSON.stringify({ ok, steps, failed });
  if (!ok) throw new AihubError(steps.join("\n"));
  return o.json ? JSON.stringify({ ok, steps }) : steps.join("\n");
}
