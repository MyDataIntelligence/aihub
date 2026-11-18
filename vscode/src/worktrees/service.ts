import * as path from "path";
import { cleanupCandidates, deleteLocalBranch, fetchAll, type CleanupCandidate } from "./branches";
import { createWorktree, listWorktrees, pathKey, removeWorktree, type Outcome, type Repo } from "./core";
import { pushRepo, syncRepo, type StepResult } from "./extras";
import type { Git } from "./git";
import { repoStatus, repoWorktreePath, removeRepoFromSet, setFolder, upsertSet, readSet, deleteSetFolderIfEmpty, type RepoStatus, type SetRepo, type WorktreeSet } from "./sets";

/** The worktree-set operations as plain git, without vscode: the glue asks the questions and shows the results. */

export interface CreateSetInput {
  root: string;
  branch: string;
  base: string;
  remote: string;
  repos: Repo[];
}

export interface CreateSetResult {
  outcomes: Outcome[];
  set?: WorktreeSet;
}

/** Creates (or extends) the set of `branch`: one worktree per repo, then writes .worktree-set.json and the .code-workspace. */
export async function createSet(git: Git, input: CreateSetInput): Promise<CreateSetResult> {
  const { root, branch, base, remote, repos } = input;
  const outcomes: Outcome[] = [];
  for (const repo of repos) {
    await fetchAll(git, repo.path, remote);
    outcomes.push(await createWorktree(git, repo, { branch, base, remote, worktreeRoot: root, onExisting: "reuse" }));
  }
  const entries: SetRepo[] = [];
  for (const repo of repos) {
    const target = repoWorktreePath(root, branch, repo);
    const key = await pathKey(target);
    let found = false;
    for (const w of await listWorktrees(git, repo.path)) if (!w.main && (await pathKey(w.path)) === key) found = true;
    if (found) entries.push({ name: path.basename(target), source: repo.path, path: target, base });
  }
  if (!entries.length) return { outcomes, set: await readSet(setFolder(root, branch)) };
  return { outcomes, set: await upsertSet(root, branch, base, entries) };
}

export interface RepoStep extends StepResult {
  name: string;
}

export async function syncSet(git: Git, set: WorktreeSet, remote: string): Promise<RepoStep[]> {
  const out: RepoStep[] = [];
  for (const r of set.repos) out.push({ name: r.name, ...(await syncRepo(git, r.path, remote)) });
  return out;
}

export async function pushSet(git: Git, set: WorktreeSet, remote: string): Promise<RepoStep[]> {
  const out: RepoStep[] = [];
  for (const r of set.repos) out.push({ name: r.name, ...(await pushRepo(git, r.path, remote, r.branch ?? set.branch)) });
  return out;
}

export async function setStatuses(git: Git, remote: string, set: WorktreeSet): Promise<RepoStatus[]> {
  return Promise.all(set.repos.map((r) => repoStatus(git, remote, set, r)));
}

/** What would be lost by removing the set: dirty worktrees and unpushed commits, for the confirm dialog. */
export function lossSummary(statuses: RepoStatus[]): string[] {
  const out: string[] = [];
  for (const s of statuses) {
    if (s.dirty) out.push(`${s.name}: ${s.dirty} uncommitted file(s)`);
    if (s.unpushed) out.push(`${s.name}: ${s.unpushed} commit(s) not pushed`);
  }
  return out;
}

export interface RemoveStepResult {
  name: string;
  ok: boolean;
  message: string;
}

export async function removeSet(git: Git, set: WorktreeSet, force: boolean): Promise<RemoveStepResult[]> {
  const out: RemoveStepResult[] = [];
  let current = set;
  for (const r of set.repos) {
    const res = await removeRepoFromSet(git, current, r.name, force);
    current = res.set;
    out.push({ name: r.name, ok: res.ok, message: res.message });
  }
  if (current.repos.length === 0) await deleteSetFolderIfEmpty(current);
  return out;
}

export interface MergedCandidate extends CleanupCandidate {
  label: string;
}

/** Worktrees whose branch is merged into a base (or whose remote branch is gone). */
export async function mergedWorktrees(git: Git, repos: Repo[], remote: string, bases: string[]): Promise<MergedCandidate[]> {
  for (const r of repos) await fetchAll(git, r.path, remote);
  return (await cleanupCandidates(git, repos, remote, bases)).map((c) => ({ ...c, label: `${c.repo.name}: ${c.branch} (${c.reason === "merged" ? `merged into ${c.base}` : "remote branch deleted"})` }));
}

/** Removes the worktree and the local branch of one candidate. A dirty worktree is never removed without `force`. */
export async function cleanUpCandidate(git: Git, c: CleanupCandidate, force = false): Promise<RemoveStepResult> {
  const w = await removeWorktree(git, c.repo.path, c.worktree.path, force);
  if (!w.ok) return { name: c.repo.name, ok: false, message: w.message };
  const b = await deleteLocalBranch(git, c.repo.path, c.branch, c.reason === "remote-gone" ? force : false);
  return { name: c.repo.name, ok: b.ok || b.notMerged, message: b.ok ? `Removed worktree and branch ${c.branch}` : `Worktree removed; ${b.message}` };
}
