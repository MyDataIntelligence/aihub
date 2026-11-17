import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getPr, shortBranch, type AdoClient } from "./ado.js";
import { repoClient, type Ctx } from "./context.js";
import { clientForRepo, crossRepoConfig, resolveRepo, storyPrs, type StoryPr } from "./crossRepo.js";
import { AihubError } from "./errors.js";
import { fetchBranch, git, gitRaw, withTempWorktree } from "./git.js";
import { anyGlob } from "./glob.js";
import { latestPerDefinition, type Build } from "./pipeline.js";
import { followBuild, queueRobot, robotDefinitionId, summarize } from "./robot.js";
import { codeKindOf, editSection, parseSections } from "./templates.js";
import { isProtected, loadTeam, readUtf8 } from "./team.js";

// ---- status ------------------------------------------------------------------

export interface RepoStatus {
  repo: string;
  pr: number;
  title: string;
  branch: string;
  target: string;
  prStatus: string;
  ahead?: number;
  behind?: number;
  pipelines: { name: string; state: string }[];
  url: string;
}

const prStatusOf = (p: StoryPr) => (p.isDraft ? "draft" : p.status);

export async function crossStatus(ctx: Ctx, o: { story: number; json?: boolean }): Promise<RepoStatus[]> {
  const { client } = repoClient(ctx);
  const prs = await storyPrs(client, o.story);
  if (!prs.length) throw new AihubError(`story ${o.story} has no linked pull requests`);
  const rows: RepoStatus[] = [];
  for (const p of prs) {
    const repo = p.repository?.name ?? client.remote.repo;
    const c = clientForRepo(ctx, client.remote, repo);
    const branch = shortBranch(p.sourceRefName);
    let ahead: number | undefined;
    let behind: number | undefined;
    try {
      const s = await c.get<{ aheadCount?: number; behindCount?: number }>(`${c.repoPath()}/stats/branches`, { name: branch });
      ahead = s.aheadCount;
      behind = s.behindCount;
    } catch {
      /* branch gone (merged and deleted) */
    }
    const q = async (branchName: string) => (await c.get<{ value?: Build[] }>("build/builds", { branchName, queryOrder: "queueTimeDescending", $top: 10 })).value ?? [];
    let builds = await q(`refs/pull/${p.pullRequestId}/merge`);
    if (!builds.length) builds = await q(p.sourceRefName);
    rows.push({
      repo,
      pr: p.pullRequestId,
      title: p.title,
      branch,
      target: shortBranch(p.targetRefName),
      prStatus: prStatusOf(p),
      ahead,
      behind,
      pipelines: latestPerDefinition(builds).map((b) => ({ name: b.definition?.name ?? "pipeline", state: b.status === "completed" ? (b.result ?? "completed") : (b.status ?? "unknown") })),
      url: c.prUrl(p.pullRequestId),
    });
  }
  return rows;
}

export function formatStatus(story: number, rows: RepoStatus[]): string {
  const lines = [`story ${story}: ${rows.length} pull request(s) in ${new Set(rows.map((r) => r.repo)).size} repo(s)`];
  for (const r of rows) {
    const ab = r.ahead === undefined ? "branch gone" : `ahead ${r.ahead} behind ${r.behind ?? 0}`;
    const pipes = r.pipelines.length ? r.pipelines.map((p) => `${p.name} ${p.state}`).join(", ") : "no pipeline run";
    lines.push(`${r.repo}: ${r.branch} -> ${r.target}  ${ab}  PR !${r.pr} ${r.prStatus}  ${pipes}`);
    lines.push(`  ${r.url}`);
  }
  return lines.join("\n");
}

// ---- link-prs ----------------------------------------------------------------

export interface LinkResult {
  repo: string;
  pr: number;
  updated: boolean;
}

/** `repo!42` or `repo:42` */
export function parseRepoPr(s: string): { repo: string; id: number } {
  const m = /^(.+?)[!:#](\d+)$/.exec(s.trim());
  if (!m) throw new AihubError(`--pr '${s}' must look like repo!42`);
  return { repo: m[1], id: Number(m[2]) };
}

async function linkToStory(base: AdoClient, story: number, p: StoryPr): Promise<boolean> {
  const wi = await base.get<{ relations?: { rel: string; url: string }[] }>(`wit/workitems/${story}`, { $expand: "relations" });
  const has = (wi.relations ?? []).some((r) => r.rel === "ArtifactLink" && new RegExp(`PullRequestId/.*?(?:%2F|/)${p.pullRequestId}$`, "i").test(r.url));
  if (has) return false;
  const proj = p.repository?.project?.id;
  const repoId = p.repository?.id;
  if (!proj || !repoId) throw new AihubError(`cannot link PR !${p.pullRequestId} to story ${story}: the pull request has no repository id`);
  await base.jsonPatch("PATCH", `wit/workitems/${story}`, [
    { op: "add", path: "/relations/-", value: { rel: "ArtifactLink", url: `vstfs:///Git/PullRequestId/${proj}%2F${repoId}%2F${p.pullRequestId}`, attributes: { name: "Pull Request" } } },
  ]);
  return true;
}

export async function linkPrs(ctx: Ctx, o: { story: number; extra?: string[] }): Promise<{ results: LinkResult[]; linkedToStory: number[] }> {
  const { root, client } = repoClient(ctx);
  const team = loadTeam(root);
  const prs = await storyPrs(client, o.story);
  const linkedToStory: number[] = [];
  for (const e of o.extra ?? []) {
    const { repo, id } = parseRepoPr(e);
    const name = (team.repositories ?? []).find((r) => r.name?.toLowerCase() === repo.toLowerCase() || ((r as { aliases?: string[] }).aliases ?? []).some((a) => a.toLowerCase() === repo.toLowerCase()))?.name ?? repo;
    if (prs.some((p) => p.pullRequestId === id)) continue;
    const c = clientForRepo(ctx, client.remote, name);
    const pr = (await getPr(c, id)) as StoryPr;
    pr.repository = { ...(pr.repository ?? {}), name };
    if (await linkToStory(client, o.story, pr)) linkedToStory.push(id);
    prs.push(pr);
  }
  if (prs.length < 2) throw new AihubError(`story ${o.story} has ${prs.length} pull request(s); nothing to cross-link`);
  const defaultHeading = team.language === "nl" ? "Gerelateerde PR's" : "Related PRs";
  const results: LinkResult[] = [];
  for (const p of prs) {
    const repo = p.repository?.name ?? client.remote.repo;
    const c = clientForRepo(ctx, client.remote, repo);
    const others = prs.filter((x) => x !== p);
    const list = others
      .map((x) => {
        const r = x.repository?.name ?? client.remote.repo;
        return `- [${r} !${x.pullRequestId}](${clientForRepo(ctx, client.remote, r).prUrl(x.pullRequestId)}) ${x.title} (${prStatusOf(x)})`;
      })
      .join("\n");
    const desc = p.description ?? "";
    const heading = parseSections(desc).sections.find((s) => codeKindOf(s.heading) === "linked")?.heading ?? defaultHeading;
    const next = editSection(desc, heading, { replace: list });
    if (next.trim() === desc.trim()) {
      results.push({ repo, pr: p.pullRequestId, updated: false });
      continue;
    }
    await c.patch(`${c.repoPath()}/pullrequests/${p.pullRequestId}`, { description: next });
    results.push({ repo, pr: p.pullRequestId, updated: true });
  }
  return { results, linkedToStory };
}

// ---- test resources ------------------------------------------------------------

export interface TestResourcesOpts {
  fromRepo?: string;
  toRepo?: string;
  target?: string;
  paths?: string;
  toPath?: string;
  messageFile?: string;
  runPipeline?: string;
  noFollow?: boolean;
  json?: boolean;
}

export interface TestResourcesResult {
  result: "ok" | "unchanged" | "failed" | "refused";
  detail: string;
  repo: string;
  branch: string;
  files: string[];
  build?: { id: number; result?: string; summary?: string };
}

export async function testResources(ctx: Ctx, o: TestResourcesOpts): Promise<TestResourcesResult> {
  const { root } = repoClient(ctx);
  const team = loadTeam(root);
  const cfg = crossRepoConfig(team);
  const fromName = o.fromRepo ?? cfg.testResources?.fromRepo;
  const toName = o.toRepo ?? cfg.testTarget?.repo;
  const target = o.target ?? cfg.testTarget?.branch;
  const paths = o.paths ? o.paths.split(",").map((s) => s.trim()).filter(Boolean) : (cfg.testResources?.paths ?? []);
  const toPath = (o.toPath ?? cfg.testResources?.toPath ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!fromName) throw new AihubError("pass --from-repo (or set crossRepo.testResources.fromRepo in team.yaml)");
  if (!toName) throw new AihubError("pass --to-repo (or set crossRepo.testTarget.repo in team.yaml)");
  if (!target) throw new AihubError("pass --target <branch> (or set crossRepo.testTarget.branch in team.yaml)");
  if (!paths.length) throw new AihubError("pass --paths <glob,...> (or set crossRepo.testResources.paths in team.yaml)");
  if (isProtected(team, target)) {
    return { result: "refused", detail: `'${target}' is protected; test resources go to the active test branch, not a protected one`, repo: toName, branch: target, files: [] };
  }
  const a = resolveRepo(ctx, team, fromName);
  const b = resolveRepo(ctx, team, toName);
  try {
    if (a.root === b.root) throw new AihubError("--from-repo and --to-repo are the same repository");
    const listed = git(a.root, ["-c", "core.quotepath=false", "ls-files", "--cached", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
    const files = [...new Set(listed)].filter((f) => anyGlob(paths, f));
    if (!files.length) throw new AihubError(`no file in ${a.name} matches ${paths.join(", ")}`);
    if (!fetchBranch(b.root, target)) {
      return { result: "failed", detail: `branch '${target}' not found on origin of ${b.name}`, repo: b.name, branch: target, files: [] };
    }
    const message = o.messageFile ? readUtf8(o.messageFile).trim() : `test: add test resources from ${a.name}`;
    const res = await withTempWorktree(b.root, `origin/${target}`, (wt): TestResourcesResult => {
      const dests: string[] = [];
      for (const f of files) {
        const dest = toPath ? `${toPath}/${f}` : f;
        mkdirSync(dirname(join(wt, dest)), { recursive: true });
        copyFileSync(join(a.root, f), join(wt, dest));
        dests.push(dest);
      }
      git(wt, ["add", "-A", "--", ...dests]);
      if (gitRaw(wt, ["diff", "--cached", "--quiet"]).status === 0) {
        return { result: "unchanged", detail: `${b.name}/${target} already has these resources`, repo: b.name, branch: target, files: dests };
      }
      const cr = gitRaw(wt, ["commit", "-q", "-m", message]);
      if (cr.status !== 0) return { result: "failed", detail: `commit failed: ${cr.stderr.split("\n")[0]}`, repo: b.name, branch: target, files: dests };
      const push = gitRaw(wt, ["push", "--quiet", "origin", `HEAD:refs/heads/${target}`]);
      if (push.status !== 0) return { result: "failed", detail: `push to '${target}' rejected: ${push.stderr.split("\n").pop()}`, repo: b.name, branch: target, files: dests };
      return { result: "ok", detail: `pushed ${dests.length} file(s) to ${b.name}/${target}`, repo: b.name, branch: target, files: dests };
    });
    if (o.runPipeline && (res.result === "ok" || res.result === "unchanged")) {
      const def = await robotDefinitionId(b.client, o.runPipeline);
      const queued = await queueRobot(b.client, { definitionId: def, branch: target });
      res.build = { id: queued.id };
      if (!o.noFollow) {
        const done = await followBuild(b.client, queued.id, 15_000);
        res.build = { id: done.id, result: done.result, summary: await summarize(b.client, done) };
        if (done.result !== "succeeded") {
          res.result = "failed";
          res.detail += `; pipeline ${o.runPipeline} ${done.result ?? done.status}`;
        }
      }
    }
    return res;
  } finally {
    a.release();
    b.release();
  }
}
