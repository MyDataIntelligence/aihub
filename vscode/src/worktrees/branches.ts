import { Git, GitResult } from "./git";
import { Repo, WorktreeInfo, listWorktrees } from "./core";

export async function fetchAll(git: Git, repoPath: string, remote: string): Promise<GitResult> {
  return git(["fetch", "--prune", remote], repoPath);
}

async function refNames(git: Git, repoPath: string, ref: string): Promise<string[]> {
  const r = await git(["for-each-ref", "--format=%(refname)", ref], repoPath);
  if (r.code !== 0) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export async function listBranches(git: Git, repoPath: string, remote: string): Promise<{ local: string[]; remote: string[] }> {
  const localPrefix = "refs/heads/";
  const remotePrefix = `refs/remotes/${remote}/`;
  const local = (await refNames(git, repoPath, "refs/heads"))
    .filter((n) => n.startsWith(localPrefix))
    .map((n) => n.slice(localPrefix.length));
  const remoteNames = (await refNames(git, repoPath, `refs/remotes/${remote}`))
    .filter((n) => n.startsWith(remotePrefix))
    .map((n) => n.slice(remotePrefix.length))
    .filter((n) => n !== "HEAD");
  return { local: local.sort(), remote: remoteNames.sort() };
}

export interface BranchPresence {
  name: string;
  repos: { path: string; local: boolean; remote: boolean }[];
}

export async function branchesAcross(git: Git, repos: Repo[], remote: string): Promise<BranchPresence[]> {
  const map = new Map<string, BranchPresence>();
  for (const repo of repos) {
    const { local, remote: rem } = await listBranches(git, repo.path, remote);
    const names = new Set([...local, ...rem]);
    const localSet = new Set(local);
    const remSet = new Set(rem);
    for (const name of names) {
      let p = map.get(name);
      if (!p) {
        p = { name, repos: [] };
        map.set(name, p);
      }
      p.repos.push({ path: repo.path, local: localSet.has(name), remote: remSet.has(name) });
    }
  }
  const total = repos.length;
  return [...map.values()].sort((a, b) => {
    const aAll = a.repos.length === total ? 0 : 1;
    const bAll = b.repos.length === total ? 0 : 1;
    if (aAll !== bAll) return aAll - bAll;
    if (a.repos.length !== b.repos.length) return b.repos.length - a.repos.length;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

export interface CleanupCandidate {
  repo: Repo;
  worktree: WorktreeInfo;
  branch: string;
  reason: "merged" | "remote-gone";
  base?: string;
}

async function revParse(git: Git, repoPath: string, ref: string): Promise<string | undefined> {
  const r = await git(["rev-parse", "--verify", "--quiet", ref], repoPath);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

export async function cleanupCandidates(git: Git, repos: Repo[], remote: string, bases: string[]): Promise<CleanupCandidate[]> {
  const out: CleanupCandidate[] = [];
  for (const repo of repos) {
    const worktrees = (await listWorktrees(git, repo.path)).filter((w) => !w.main && w.branch);
    for (const worktree of worktrees) {
      const branch = worktree.branch as string;
      const info = await git(["for-each-ref", "--format=%(upstream)|%(upstream:track)", `refs/heads/${branch}`], repo.path);
      const line = info.code === 0 ? info.stdout.split(/\r?\n/)[0] ?? "" : "";
      const sep = line.indexOf("|");
      const upstream = sep >= 0 ? line.slice(0, sep).trim() : "";
      const track = sep >= 0 ? line.slice(sep + 1) : "";

      if (upstream && track.includes("[gone]")) {
        out.push({ repo, worktree, branch, reason: "remote-gone" });
        continue;
      }

      const pushed =
        upstream !== "" || (await revParse(git, repo.path, `refs/remotes/${remote}/${branch}`)) !== undefined;
      if (!pushed) continue;
      const tip = await revParse(git, repo.path, `refs/heads/${branch}`);
      if (!tip) continue;
      for (const base of bases) {
        const baseTip = await revParse(git, repo.path, `refs/remotes/${remote}/${base}`);
        if (!baseTip || baseTip === tip) continue;
        const anc = await git(["merge-base", "--is-ancestor", tip, baseTip], repo.path);
        if (anc.code === 0) {
          out.push({ repo, worktree, branch, reason: "merged", base });
          break;
        }
      }
    }
  }
  return out;
}

export async function deleteLocalBranch(
  git: Git,
  repoPath: string,
  branch: string,
  force: boolean,
): Promise<{ ok: boolean; notMerged: boolean; message: string }> {
  const r = await git(["branch", force ? "-D" : "-d", branch], repoPath);
  if (r.code === 0) return { ok: true, notMerged: false, message: `Deleted branch ${branch}` };
  if (/not fully merged/i.test(r.stderr)) {
    return { ok: false, notMerged: true, message: `Branch ${branch} has commits that are not merged.` };
  }
  const first = r.stderr.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? `git exited with code ${r.code}`;
  return { ok: false, notMerged: false, message: first };
}

export async function pruneWorktrees(git: Git, repoPath: string): Promise<GitResult> {
  return git(["worktree", "prune"], repoPath);
}
