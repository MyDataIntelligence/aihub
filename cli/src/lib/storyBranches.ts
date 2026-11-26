import { existsSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { AdoClient, PullRequest } from "./ado.js";
import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { currentBranch, repoRoot } from "./git.js";
import { listWorktrees, refSha, samePath, tryGit, isDirty } from "./gitx.js";
import { launchCode, openSet, storyPatternOf, worktreeRootOf, defaultSetsRootFor, type OpenMode, type OpenSetResult, type OpenWindow } from "./repoSet.js";
import { scanThisPc } from "./machineFolders.js";
import { setOfStory, type ScanSet } from "./machineScan.js";
import { rememberUse } from "./recentUse.js";
import { rememberStories } from "./storyCache.js";
import { clientForDir, resolveRepoDirs, type RepoDir } from "./repos.js";
import { moveWorktreeSafely, removeWorktreeSafely } from "./safeWorktree.js";
import {
  linkBranch,
  markStatus,
  misplacedWorktrees,
  readStoryWorktrees,
  branchNamedForStory,
  storyIdFromBranch,
  storyWorktreesFileFor,
  unlinkBranch,
  updateStoryWorktrees,
  type BranchStatus,
  type StoryBranch,
} from "./storyWorktrees.js";
import { cloneNotFoundMessage } from "./findClone.js";
import { loadTeam, type TeamConfig } from "./team.js";
import { addArtifactLink, branchArtifact, getWorkItem, repoInfo, type WorkItem } from "./workitems.js";
import type { WhenExists } from "./existingWorktree.js";

/**
 * `aihub story branches`: which branches and worktrees belong to a story, in every repository. The Azure DevOps
 * "Development" links of the work item (ArtifactLink vstfs:///Git/Ref/...) say which branches belong to it; each
 * repository's story-worktrees.json adds the star (the branch you work on), old/parked, a label and the activity.
 */

export interface BranchLink {
  repoId: string;
  branch: string;
  url: string;
}

/** The branch links of a work item: vstfs:///Git/Ref/<project>%2F<repo id>%2FGB<branch>. */
export function branchLinks(wi: Pick<WorkItem, "relations">): BranchLink[] {
  const out: BranchLink[] = [];
  for (const r of wi.relations) {
    if (r.rel !== "ArtifactLink") continue;
    const m = /^vstfs:\/\/\/Git\/Ref\/([^/]+)\/([^/]+)\/GB(.+)$/i.exec(decodeURIComponent(r.url));
    if (m) out.push({ repoId: m[2], branch: m[3], url: r.url });
  }
  return out;
}

export interface BranchRow {
  repo: string;
  branch: string;
  /** where the link is: in Azure DevOps (Development), only locally, or both; "name": no link anywhere, the name starts with the story number */
  linked: "ado" | "local" | "both" | "name";
  status: BranchStatus;
  label?: string;
  worktree?: string;
  /** the branch exists in the local clone */
  local: boolean;
  pushed: boolean;
  /** commits not on origin */
  ahead: number;
  dirty: boolean;
  pr?: { id: number; draft: boolean; status: string };
  lastActive?: string;
}

export interface StoryRow {
  id: number;
  title: string;
  state: string;
  branches: BranchRow[];
}

interface Repo {
  name: string;
  id?: string;
  dir?: string;
}

function team(ctx: Ctx): { root: string; team: TeamConfig } {
  const root = repoRoot(ctx.cwd);
  return { root, team: loadTeam(root) };
}

const tryResolve = (name: string, root: string, t: TeamConfig): RepoDir | undefined => {
  try {
    return resolveRepoDirs([name], root, t)[0];
  } catch {
    return undefined;
  }
};

/** The repositories of the project: id -> name, and the local clone when there is one. */
async function projectRepos(client: AdoClient, root: string, t: TeamConfig): Promise<Repo[]> {
  const list = await client.list<{ id: string; name: string }>("git/repositories").catch(() => [] as { id: string; name: string }[]);
  const repos: Repo[] = list.map((r) => ({ name: r.name, id: r.id, dir: tryResolve(r.name, root, t)?.dir }));
  const here = basename(root);
  if (!repos.some((r) => r.dir && samePath(r.dir, root))) repos.push({ name: here, dir: root });
  return repos;
}

async function myActiveStories(client: AdoClient, t: TeamConfig): Promise<number[]> {
  const type = t.workItems?.storyType ?? "User Story";
  const q = await client.post<{ workItems?: { id: number }[] }>("wit/wiql", {
    query: `SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.WorkItemType] = '${type.replace(/'/g, "''")}' AND [System.State] NOT IN ('Closed','Done','Removed','Resolved') ORDER BY [System.ChangedDate] DESC`,
  });
  return (q.workItems ?? []).slice(0, 15).map((w) => w.id);
}

/** Local facts of one branch: one `for-each-ref`-like read per question, no network. */
function localFacts(dir: string, branch: string, worktrees: { path: string; branch?: string }[]) {
  const local = !!refSha(dir, `refs/heads/${branch}`);
  const pushed = !!refSha(dir, `refs/remotes/origin/${branch}`);
  const wt = worktrees.find((w) => w.branch === branch)?.path;
  const ahead = local ? Number(tryGit(dir, ["rev-list", "--count", `refs/heads/${branch}`, "--not", "--remotes"]).out) || 0 : 0;
  return { local, pushed, ahead, worktree: wt, dirty: wt ? isDirty(wt) : false };
}

export async function listStoryBranches(ctx: Ctx, o: { id?: number; mine?: boolean }): Promise<StoryRow[]> {
  const { client } = repoClient(ctx);
  const { root, team: t } = team(ctx);
  const repos = await projectRepos(client, root, t);
  const files = new Map<string, Record<string, StoryBranch>>();
  for (const r of repos) if (r.dir) files.set(r.name, readStoryWorktrees(storyWorktreesFileFor(r.dir) ?? "").branches);
  // the stories you have branches for here come first (also when they are not assigned to you), then your active ones
  const local = [...files.values()].flatMap((b) => Object.values(b)).sort((a, b) => (b.lastActive ?? b.created).localeCompare(a.lastActive ?? a.created)).map((b) => b.storyId);
  const ids = o.id ? [o.id] : [...new Set([...local, ...(await myActiveStories(client, t))])].slice(0, 20);
  if (!ids.length) return [];
  const prsOf = new Map<string, Promise<PullRequest[]>>();
  const prs = (repo: string) => {
    if (!prsOf.has(repo)) prsOf.set(repo, client.forRepo(repo).list<PullRequest>(`${client.forRepo(repo).repoPath()}/pullrequests`, { "searchCriteria.status": "active" }).catch(() => []));
    return prsOf.get(repo)!;
  };
  const wtCache = new Map<string, { path: string; branch?: string }[]>();
  const worktreesOf = (dir: string) => {
    if (!wtCache.has(dir)) wtCache.set(dir, listWorktrees(dir));
    return wtCache.get(dir)!;
  };
  const out: StoryRow[] = [];
  const refCache = new Map<string, RefBranch[]>();
  const refsOf = (dir: string): RefBranch[] => refCache.get(dir) ?? (refCache.set(dir, readRefs(dir)), refCache.get(dir)!);
  for (const id of ids) {
    let wi: WorkItem;
    try {
      wi = await getWorkItem(client, id);
    } catch (e) {
      // a story that was deleted or moved: one unreadable story never hides the others
      if (o.id) throw e;
      continue;
    }
    const rows = new Map<string, BranchRow>();
    const key = (repo: string, b: string) => `${repo}\u0000${b}`;
    for (const l of branchLinks(wi)) {
      const repo = repos.find((r) => r.id === l.repoId)?.name ?? l.repoId;
      rows.set(key(repo, l.branch), { repo, branch: l.branch, linked: "ado", status: "parked", local: false, pushed: false, ahead: 0, dirty: false });
    }
    for (const [repo, branches] of files) {
      for (const b of Object.values(branches)) {
        if (b.storyId !== id) continue;
        const k = key(repo, b.branch);
        const had = rows.get(k);
        rows.set(k, { ...(had ?? { repo, branch: b.branch, local: false, pushed: false, ahead: 0, dirty: false }), linked: had ? "both" : "local", status: b.status, label: b.label, lastActive: b.lastActive } as BranchRow);
      }
    }
    for (const row of rows.values()) {
      const dir = repos.find((r) => r.name === row.repo)?.dir;
      if (dir) Object.assign(row, localFacts(dir, row.branch, worktreesOf(dir)));
      const pr = (await prs(row.repo)).find((p) => p.sourceRefName === `refs/heads/${row.branch}`);
      if (pr) row.pr = { id: pr.pullRequestId, draft: !!pr.isDraft, status: pr.status ?? "active" };
    }
    // branches that only have the story number in their name: from the refs of each clone (one for-each-ref per clone, no fetch, no network)
    for (const r of repos) {
      if (!r.dir) continue;
      for (const n of refsOf(r.dir)) {
        if (!branchNamedForStory(n.branch, id) || rows.has(key(r.name, n.branch))) continue;
        rows.set(key(r.name, n.branch), { repo: r.name, branch: n.branch, linked: "name", status: "parked", local: n.local, pushed: n.pushed, ahead: n.ahead, dirty: false, ...(worktreesOf(r.dir).find((w) => w.branch === n.branch)?.path ? { worktree: worktreesOf(r.dir).find((w) => w.branch === n.branch)!.path } : {}), ...(n.lastActive ? { lastActive: n.lastActive } : {}) });
      }
    }
    // the Worktree Maker has no Azure DevOps access: the title goes into the shared file of each repository with this story
    for (const r of repos) if (r.dir && [...rows.values()].some((x) => x.repo === r.name && x.linked !== "name")) rememberTitle(r.dir, id, wi.title);
    out.push({ id, title: wi.title, state: wi.state, branches: [...rows.values()].sort((a, b) => a.repo.localeCompare(b.repo) || rank(a.status) - rank(b.status) || a.branch.localeCompare(b.branch)) });
  }
  // the menus name a story and know it is closed from this list, without asking Azure DevOps again
  try {
    rememberStories(ctx.env, out, (ctx.now ?? Date.now)());
  } catch {
    /* an unwritable config home only costs the next read */
  }
  return out;
}

/** Writes the story title into the repository's story-worktrees.json, only when it is new or changed. */
function rememberTitle(dir: string, id: number, title: string): void {
  const file = storyWorktreesFileFor(dir);
  if (!file || !title) return;
  try {
    if (readStoryWorktrees(file).stories[String(id)]?.title === title) return;
    updateStoryWorktrees(file, (d) => ({ ...d, stories: { ...d.stories, [String(id)]: { ...d.stories[String(id)], title } } }));
  } catch {
    /* a newer schema: left alone */
  }
}

const rank = (s: BranchStatus) => (s === "current" ? 0 : s === "parked" ? 1 : 2);

/** The branches of a clone from its refs (local and what origin had at the last fetch): one `for-each-ref`, remembered per call. */
interface RefBranch {
  branch: string;
  local: boolean;
  pushed: boolean;
  ahead: number;
  lastActive?: string;
}
function readRefs(dir: string): RefBranch[] {
  const out = tryGit(dir, ["for-each-ref", "--format=%(refname)%09%(committerdate:iso-strict)%09%(upstream:track)", "refs/heads", "refs/remotes/origin"]).out;
  const by = new Map<string, RefBranch>();
  for (const line of out.split("\n").filter(Boolean)) {
    const [ref, date, track] = line.split("\t");
    const isLocal = ref.startsWith("refs/heads/");
    const branch = ref.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/origin\//, "");
    if (branch === "HEAD") continue;
    const row = by.get(branch) ?? { branch, local: false, pushed: false, ahead: 0 };
    if (isLocal) {
      row.local = true;
      row.ahead = Number(/ahead (\d+)/.exec(track ?? "")?.[1] ?? 0);
    } else row.pushed = true;
    if (date && (!row.lastActive || date > row.lastActive)) row.lastActive = date;
    by.set(branch, row);
  }
  return [...by.values()];
}


export function formatStoryBranches(rows: StoryRow[]): string {
  if (!rows.length) return "no active stories assigned to you";
  const out: string[] = [];
  for (const s of rows) {
    out.push(`story ${s.id} [${s.state}] ${s.title}`);
    if (!s.branches.length) out.push("  no branches linked yet: aihub story branches link --id " + s.id);
    for (const b of s.branches) {
      const star = b.status === "current" ? "★" : b.status === "old" ? "·" : " ";
      const facts = [b.local ? (b.pushed ? (b.ahead ? `${b.ahead} to push` : "pushed") : "local only") : b.pushed ? "remote only" : "gone", b.dirty ? "uncommitted work" : "", b.pr ? `PR !${b.pr.id}${b.pr.draft ? " (draft)" : ""}` : "", b.linked === "local" ? "not linked in Azure DevOps" : b.linked === "name" ? "not linked, found by its name" : ""].filter(Boolean);
      out.push(`  ${star} ${b.repo}: ${b.branch}${b.label ? ` "${b.label}"` : ""}  ${facts.join(", ")}${b.worktree ? `  ${b.worktree}` : ""}`);
    }
  }
  return out.join("\n");
}

/** The clone of `repo` (default: the repository you are in). */
function repoDir(ctx: Ctx, repo: string | undefined): RepoDir {
  const { root, team: t } = team(ctx);
  if (!repo) return { name: basename(root), dir: root };
  const d = tryResolve(repo, root, t);
  if (!d) throw new AihubError(cloneNotFoundMessage(repo, root));
  return d;
}

function fileOf(dir: string): string {
  const f = storyWorktreesFileFor(dir);
  if (!f) throw new AihubError(`${dir} is not a git repository`);
  return f;
}

export async function linkStoryBranches(ctx: Ctx, o: { id: number; branches: string[]; repo?: string; current?: boolean; now?: number }): Promise<string[]> {
  const { client } = repoClient(ctx);
  const r = repoDir(ctx, o.repo);
  const branches = o.branches.length ? o.branches : [currentBranch(r.dir)];
  const wi = await getWorkItem(client, o.id);
  const info = await repoInfo(clientForDir(ctx, r.dir));
  const lines: string[] = [];
  for (const [i, b] of branches.entries()) {
    const added = await addArtifactLink(client, wi, branchArtifact(info, b), "Branch");
    const wt = listWorktrees(r.dir).find((w) => w.branch === b)?.path;
    updateStoryWorktrees(fileOf(r.dir), (d) => linkBranch(d, { storyId: o.id, branch: b, worktree: wt, current: !!o.current && i === branches.length - 1 }, o.now ?? Date.now()));
    lines.push(`${r.name}: '${b}' ${added ? "linked to" : "was already linked to"} story ${o.id}${o.current && i === branches.length - 1 ? " ★" : ""}`);
  }
  return lines;
}

export async function unlinkStoryBranch(ctx: Ctx, o: { id: number; branch: string; repo?: string }): Promise<string> {
  const { client } = repoClient(ctx);
  const r = repoDir(ctx, o.repo);
  const info = await repoInfo(clientForDir(ctx, r.dir));
  const url = branchArtifact(info, o.branch).toLowerCase();
  const wi = await getWorkItem(client, o.id);
  const idx = wi.relations.findIndex((x) => x.rel === "ArtifactLink" && decodeURIComponent(x.url).toLowerCase() === decodeURIComponent(url));
  if (idx >= 0) await client.jsonPatch("PATCH", `wit/workitems/${o.id}`, [{ op: "remove", path: `/relations/${idx}` }]);
  updateStoryWorktrees(fileOf(r.dir), (d) => unlinkBranch(d, o.branch));
  return `${r.name}: '${o.branch}' unlinked from story ${o.id}${idx >= 0 ? "" : " (it had no Azure DevOps link)"}; the branch itself stays`;
}

/** ★ / old / parked and the label: local only, no network. One star per story per repository. */
export function markStoryBranch(ctx: Ctx, o: { branch: string; status?: BranchStatus; label?: string; id?: number; repo?: string; now?: number }): string {
  const r = repoDir(ctx, o.repo);
  const t = team(ctx).team;
  const now = o.now ?? Date.now();
  const d = updateStoryWorktrees(fileOf(r.dir), (d0) => {
    let d1 = d0;
    if (!d1.branches[o.branch]) {
      const id = o.id ?? storyIdFromBranch(o.branch, storyPatternOf(t));
      if (!id) throw new AihubError(`'${o.branch}' is not linked to a story; pass --id <story>`);
      d1 = linkBranch(d1, { storyId: id, branch: o.branch, worktree: listWorktrees(r.dir).find((w) => w.branch === o.branch)?.path }, now);
    }
    return markStatus(d1, o.branch, o.status ?? d1.branches[o.branch].status, now, o.label);
  });
  const e = d.branches[o.branch];
  return `${r.name}: '${o.branch}' is ${e.status === "current" ? "★ current" : e.status} for story ${e.storyId}${e.label ? ` ("${e.label}")` : ""}`;
}

/** Removes the worktree and (with deleteBranch) the local branch; refuses when work would be lost. */
export function removeStoryBranch(ctx: Ctx, o: { branch: string; repo?: string; deleteBranch?: boolean; discardLocalWork?: boolean }): string {
  const r = repoDir(ctx, o.repo);
  const wt = listWorktrees(r.dir).find((w) => w.branch === o.branch);
  if (wt?.path && samePath(wt.path, r.dir)) throw new AihubError(`'${o.branch}' is checked out in the main clone ${r.dir}; switch it to another branch first (nothing was removed)`);
  const res = removeWorktreeSafely(r.dir, wt?.path, o.branch, { deleteBranch: o.deleteBranch, discardLocalWork: o.discardLocalWork, env: ctx.env });
  if (res.removed || res.branchDeleted) {
    updateStoryWorktrees(fileOf(r.dir), (d) => {
      const e = d.branches[o.branch];
      if (!e) return d;
      if (res.branchDeleted) return unlinkBranch(d, o.branch);
      return { ...d, branches: { ...d.branches, [o.branch]: { ...e, worktree: undefined, status: e.status === "current" ? "old" : e.status } } };
    });
  }
  return `${r.name}: ${o.branch}: ${res.note}`;
}

/** The star of each repository of the story (else its only branch, else the newest), opened as one set. */
export async function openStory(ctx: Ctx, o: { id: number; mode?: OpenMode; window?: OpenWindow; root?: string; existing?: Exclude<WhenExists, "ask">; discardLocalWork?: boolean; again?: string }): Promise<OpenSetResult> {
  // a story has one set: when it is on this PC it is simply opened (no question, no Azure DevOps read)
  const have = (o.mode ?? "worktree") === "worktree" ? storySetOnThisPc(ctx, o.id) : undefined;
  if (have) return reopenSet(ctx, have, o.window ?? "new");
  const stories = await listStoryBranches(ctx, { id: o.id });
  const rows = stories[0]?.branches.filter((b) => b.local || b.pushed) ?? [];
  if (!rows.length) throw new AihubError(`story ${o.id} has no branches yet; link one with: aihub story branches link --id ${o.id}`);
  const pick = new Map<string, BranchRow>();
  // a branch that only has the story number in its name comes last: another branch of that repository wins
  const nm = (r: BranchRow) => r.linked === "name";
  for (const b of rows) {
    const had = pick.get(b.repo);
    const better = !had || (nm(b) !== nm(had) ? !nm(b) : rank(b.status) < rank(had.status) || (rank(b.status) === rank(had.status) && (b.lastActive ?? "") > (had.lastActive ?? "")));
    if (better) pick.set(b.repo, b);
  }
  const chosen = [...pick.values()];
  return openSet(ctx, { repos: chosen.map((b) => b.repo), branch: chosen[0].branch, branches: Object.fromEntries(chosen.map((b) => [b.repo, b.branch])), storyId: o.id, mode: o.mode ?? "worktree", window: o.window ?? "new", root: o.root, existing: o.existing, discardLocalWork: o.discardLocalWork, again: o.again });
}

/** The set of a story that is on this PC and still has a folder (the folders to look in, a cached scan). */
export function storySetOnThisPc(ctx: Ctx, id: number): ScanSet | undefined {
  const s = setOfStory(scanThisPc(ctx.env, ctx.cwd, { now: (ctx.now ?? Date.now)() }), id);
  return s && s.repos.some((r) => r.exists) ? s : undefined;
}

/** The set as it stands, opened in a window: nothing is created, moved or switched. */
export function reopenSet(ctx: Ctx, s: ScanSet, window: OpenWindow): OpenSetResult {
  const target = s.id.endsWith(".code-workspace") ? s.id : s.folder;
  const opened = window !== "none" && launchCode(target, window, ctx.env);
  try {
    rememberUse(ctx.env, { kind: "set", id: target, label: `#${s.story}`, detail: s.repos.map((r) => r.name).join(", "), story: s.story }, (ctx.now ?? Date.now)());
  } catch {
    /* the recent list is a convenience */
  }
  return {
    story: s.story,
    branch: s.branch,
    mode: "worktree",
    folder: s.folder,
    workspace: s.id.endsWith(".code-workspace") ? s.id : undefined,
    repos: s.repos.map((r) => (r.exists ? { repo: r.name, ok: true, state: "existing" as const, branch: r.branch, path: r.path, note: `already in the set of story ${s.story}` } : { repo: r.name, ok: false, state: "failed" as const, branch: r.branch, note: "folder not found; aihub worktree repair makes it again" })),
    opened,
  };
}

/** Worktrees of stories that are not in `<root>/<id>-<slug>/`: listed, and moved with `move`. */
export function placeWorktrees(ctx: Ctx, o: { root?: string; move?: string[] | "all" }): { misplaced: { repo: string; branch: string; path: string; target: string; storyId: number }[]; moved: string[] } {
  const { root, team: t } = team(ctx);
  const setsRoot = resolve(o.root ?? worktreeRootOf(t, root) ?? defaultSetsRootFor(ctx.cwd, root, root));
  const names = [...new Set([basename(root), ...(t.repositories ?? []).map((r) => r.name ?? "").filter(Boolean)])];
  const dirs = names.map((n) => tryResolve(n, root, t)).filter((d): d is RepoDir => !!d);
  const list = dirs.flatMap((d) => listWorktrees(d.dir).filter((w) => !w.main && w.branch).map((w) => ({ path: w.path, branch: w.branch!, repo: d.name, source: d.dir })));
  const storyFolders = existsSync(setsRoot) ? readdirSync(setsRoot) : [];
  const misplaced = misplacedWorktrees(list, { root: setsRoot, storyFolders, exists: existsSync, pattern: storyPatternOf(t) });
  const moved: string[] = [];
  for (const m of misplaced) {
    if (!o.move || (o.move !== "all" && !o.move.some((x) => samePath(x, m.path) || x === `${m.repo}:${m.branch}`))) continue;
    const src = list.find((w) => samePath(w.path, m.path))!.source;
    const r = moveWorktreeSafely(src, m.path, m.target);
    moved.push(`${m.repo} ${m.branch}: ${r.ok ? `${m.path} -> ${m.target}, ${r.note}` : `not moved: ${r.note}`}`);
    if (r.ok) updateStoryWorktrees(fileOf(src), (d) => linkBranch(d, { storyId: m.storyId, branch: m.branch, worktree: m.target }, Date.now()));
  }
  return { misplaced: misplaced.map(({ repo, branch, path, target, storyId }) => ({ repo, branch, path, target, storyId })), moved };
}
