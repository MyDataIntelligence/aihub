import { branchRef, findActivePr, repoDefaultBranch, type AdoClient, type PullRequest } from "./ado.js";
import { ensureBranch, findStoryBranchName, findStoryBranchNames } from "./branches.js";
import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { currentBranch, originDefaultBranch } from "./git.js";
import { isAncestor, isDirty, listWorktrees, mustGit, refSha, samePath, tryGit, unpushedCount } from "./gitx.js";
import { clientForDir, fetchOrigin, resolveRepoDirs, type RepoDir } from "./repos.js";
import { defaultTargetFor, loadTeam, type TeamConfig } from "./team.js";
import {
  addArtifactLink,
  branchArtifact,
  getWorkItem,
  isProtected,
  prArtifact,
  repoInfo,
  setWorkItemState,
  storyBranchName,
  storyStates,
  type WorkItem,
} from "./workitems.js";

export async function baseFor(dir: string, client: AdoClient, team: TeamConfig, override?: string): Promise<string> {
  return override ?? defaultTargetFor(team, client.remote.repo) ?? (originDefaultBranch(dir) || undefined) ?? (await repoDefaultBranch(client)) ?? "main";
}

function targets(ctx: Ctx, repos: string[] | undefined, root: string, team: TeamConfig, extraRoot?: string): RepoDir[] {
  const list = repos?.length ? repos : [];
  if (!list.length) return [{ name: clientForDir(ctx, root).remote.repo, dir: root }];
  return resolveRepoDirs(list, root, team, extraRoot ? [extraRoot] : []);
}

const stateIs = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export interface StartOpts {
  id: number;
  repos?: string[];
  base?: string;
  root?: string;
  checkout?: boolean;
  noCheckout?: boolean;
  json?: boolean;
}

export async function startStory(ctx: Ctx, o: StartOpts): Promise<string> {
  const { root, client: mainClient } = repoClient(ctx);
  const team = loadTeam(root);
  const wi = await getWorkItem(mainClient, o.id);
  if (!wi.title) throw new AihubError(`work item ${o.id} not found or has no title`);
  const states = storyStates(team);
  const single = !o.repos?.length;
  const lines: string[] = [];
  const results: Record<string, unknown>[] = [];

  for (const r of targets(ctx, o.repos, root, team, o.root)) {
    const client = clientForDir(ctx, r.dir);
    fetchOrigin(r.dir);
    const base = await baseFor(r.dir, client, team, o.base);
    const branch = findStoryBranchName(r.dir, o.id, storyBranchName(team, o.id, wi.title)) ?? storyBranchName(team, o.id, wi.title);
    const e = ensureBranch(r.dir, branch, base);
    const info = await repoInfo(client);
    const linked = await addArtifactLink(mainClient, wi, branchArtifact(info, branch), "Branch");
    let checkedOut = false;
    if ((o.checkout ?? (single && !o.noCheckout)) && currentBranch(r.dir) !== branch) {
      if (isDirty(r.dir)) lines.push(`${r.name}: kept branch '${currentBranch(r.dir)}' checked out (uncommitted changes)`);
      else {
        mustGit(r.dir, ["switch", branch]);
        checkedOut = true;
      }
    }
    results.push({ repo: r.name, branch, base, created: e.created, pushed: e.pushed, linked, checkedOut });
    lines.push(`${r.name}: ${e.created ? "created" : "reused"} '${branch}' from ${base}${e.pushed ? ", pushed" : ""}${linked ? ", linked to the story" : ", already linked"}${checkedOut ? ", checked out" : ""}`);
  }

  let stateText = `state stays ${wi.state}`;
  if (!stateIs(wi.state, states.active) && !stateIs(wi.state, states.finished)) {
    await setWorkItemState(mainClient, o.id, states.active);
    stateText = `state ${wi.state} -> ${states.active}`;
  }
  lines.push(`story ${o.id} '${wi.title}': ${stateText}`);
  return o.json ? JSON.stringify({ story: o.id, title: wi.title, state: stateText, repos: results }) : lines.join("\n");
}

export interface LinkOpts {
  id: number;
  branch?: string;
  json?: boolean;
}

export async function linkStory(ctx: Ctx, o: LinkOpts): Promise<string> {
  const { root, client } = repoClient(ctx);
  const branch = o.branch ?? currentBranch(root);
  const wi = await getWorkItem(client, o.id);
  const info = await repoInfo(client);
  const out: string[] = [];
  out.push((await addArtifactLink(client, wi, branchArtifact(info, branch), "Branch")) ? `branch '${branch}' linked to story ${o.id}` : `branch '${branch}' was already linked to story ${o.id}`);
  const pr = await findActivePr(client, branch);
  if (pr) {
    out.push((await addArtifactLink(client, wi, prArtifact(info, pr.pullRequestId), "Pull Request")) ? `PR !${pr.pullRequestId} linked` : `PR !${pr.pullRequestId} was already linked`);
  }
  return o.json ? JSON.stringify({ story: o.id, branch, pr: pr?.pullRequestId, messages: out }) : out.join("\n");
}

export interface FinishOpts {
  id: number;
  repos?: string[];
  root?: string;
  dryRun?: boolean;
  noState?: boolean;
  json?: boolean;
}

async function completedPr(client: AdoClient, branch: string): Promise<PullRequest | undefined> {
  const prs = await client.list<PullRequest & { closedDate?: string }>(`${client.repoPath()}/pullrequests`, {
    "searchCriteria.sourceRefName": branchRef(branch),
    "searchCriteria.status": "completed",
  });
  return prs.sort((a, b) => String(b.closedDate ?? "").localeCompare(String(a.closedDate ?? "")))[0];
}

/** Merged = the local/remote tip is contained in the PR's final source commit or in the target branch. */
function containedIn(dir: string, tip: string, mergedSha: string | undefined, base: string): boolean {
  if (!tip) return true;
  if (mergedSha && refSha(dir, mergedSha) && isAncestor(dir, tip, mergedSha)) return true;
  const b = refSha(dir, `refs/remotes/origin/${base}`) ? `origin/${base}` : base;
  return refSha(dir, b) !== "" && isAncestor(dir, tip, b);
}

export async function finishStory(ctx: Ctx, o: FinishOpts): Promise<string> {
  const { root, client: mainClient } = repoClient(ctx);
  const team = loadTeam(root);
  const states = storyStates(team);
  const wi = await getWorkItem(mainClient, o.id);
  const lines: string[] = [];
  let allMerged = true;
  let anyBranch = false;
  const dry = !!o.dryRun;
  const act = (text: string) => lines.push(dry ? `would: ${text}` : text);

  for (const r of targets(ctx, o.repos, root, team, o.root)) {
    const client = clientForDir(ctx, r.dir);
    fetchOrigin(r.dir);
    const base = await baseFor(r.dir, client, team);
    const names = findStoryBranchNames(r.dir, o.id).filter((n) => !isProtected(team, n));
    if (!names.length) {
      lines.push(`${r.name}: no branch for story ${o.id}`);
      continue;
    }
    for (const branch of names) {
      anyBranch = true;
      const tag = `${r.name}/${branch}`;
      const active = await findActivePr(client, branch);
      if (active) {
        allMerged = false;
        lines.push(`${tag}: kept, PR !${active.pullRequestId} is still active`);
        continue;
      }
      const pr = await completedPr(client, branch);
      if (!pr) {
        allMerged = false;
        lines.push(`${tag}: kept, no completed pull request (not merged)`);
        continue;
      }
      const mergedSha = pr.lastMergeSourceCommit?.commitId;
      const localTip = refSha(r.dir, `refs/heads/${branch}`);
      const remoteTip = refSha(r.dir, `refs/remotes/origin/${branch}`);
      if (localTip && !containedIn(r.dir, localTip, mergedSha, base)) {
        allMerged = false;
        lines.push(`${tag}: kept, local commits are not in the merged PR !${pr.pullRequestId}`);
        continue;
      }
      if (remoteTip && !containedIn(r.dir, remoteTip, mergedSha, base)) {
        allMerged = false;
        lines.push(`${tag}: kept, the remote branch has commits that are not in the merged PR !${pr.pullRequestId}`);
        continue;
      }

      // worktrees on this branch: remove only when clean and pushed
      let blocked = false;
      for (const w of listWorktrees(r.dir)) {
        if (w.main || w.branch !== branch) continue;
        if (isDirty(w.path)) {
          blocked = true;
          lines.push(`${tag}: worktree ${w.path} kept, it has uncommitted changes`);
        } else if (unpushedCount(w.path) > 0) {
          blocked = true;
          lines.push(`${tag}: worktree ${w.path} kept, it has unpushed commits`);
        } else {
          act(`removed worktree ${w.path}`);
          if (!dry) mustGit(r.dir, ["worktree", "remove", w.path]);
        }
      }
      if (blocked) {
        allMerged = false;
        continue;
      }

      if (localTip) {
        const cur = tryGit(r.dir, ["rev-parse", "--abbrev-ref", "HEAD"]).out.trim();
        if (cur === branch) {
          if (isDirty(r.dir)) {
            allMerged = false;
            lines.push(`${tag}: kept checked out, uncommitted changes`);
            continue;
          }
          act(`switched ${r.name} to ${base}`);
          if (!dry) {
            if (refSha(r.dir, `refs/heads/${base}`)) {
              mustGit(r.dir, ["switch", base]);
              tryGit(r.dir, ["merge", "--ff-only", `origin/${base}`]);
            } else mustGit(r.dir, ["switch", "-c", base, `origin/${base}`]);
          }
        }
        act(`deleted local branch ${branch}`);
        if (!dry) mustGit(r.dir, ["branch", "-D", branch]);
      }
      if (remoteTip) {
        act(`deleted remote branch ${branch}`);
        if (!dry) mustGit(r.dir, ["push", "origin", "--delete", branch]);
      }
      if (!localTip && !remoteTip) lines.push(`${tag}: nothing to delete`);
      lines.push(`${tag}: merged by PR !${pr.pullRequestId}`);
    }
  }

  if (anyBranch && allMerged && !o.noState) {
    if (stateIs(wi.state, states.finished)) lines.push(`story ${o.id}: already ${wi.state}`);
    else {
      act(`story ${o.id} state ${wi.state} -> ${states.finished}`);
      if (!dry) await setWorkItemState(mainClient, o.id, states.finished);
    }
  } else if (anyBranch) lines.push(`story ${o.id}: state not changed (not everything is merged)`);
  return o.json ? JSON.stringify({ story: o.id, dryRun: dry, lines }) : lines.join("\n");
}

export type { WorkItem };
export { samePath };
