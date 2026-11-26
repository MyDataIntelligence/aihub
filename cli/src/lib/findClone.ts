import { existsSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { chooseClone, samePath } from "./cloneChoice.js";
import { remoteOf } from "./machineScan.js";
import { repoNameOfUrl } from "./repoName.js";
import { usedAt as lastUsedOf } from "./repoPicker.js";

/** "Repo X", "repo_x" and "repo-x" are the same name: case, spaces, `_` and `-` do not count. */
export const looseName = (s: string): string => s.toLowerCase().replace(/[\s_-]+/g, "");

/** The repository a clone folder belongs to, from its own `.git/config` (a file read, no git process); undefined for a linked worktree or no remote. */
export const cloneRepoName = (dir: string): string | undefined => {
  const hit = memo.get(dir);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.name;
  const name = repoNameOfUrl(remoteOf(join(dir, ".git")));
  memo.set(dir, { at: Date.now(), name });
  return name;
};
// one story view asks for many repositories in a row: read each sibling's config once per few seconds, not once per question
const MEMO_MS = 5_000;
const memo = new Map<string, { at: number; name: string | undefined }>();

/** True when `dir` is a git clone whose remote points to the repository `name` (compared loosely). */
export const cloneIsOf = (dir: string, name: string): boolean => {
  const r = cloneRepoName(dir);
  return !!r && looseName(r) === looseName(name);
};

const childDirs = (root: string): string[] => {
  try {
    return readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules").map((e) => join(root, e.name));
  } catch {
    return [];
  }
};

/**
 * Finds the clone of the repository `name` when no folder has exactly that name. THE shared rule of `resolveRepoDirs` and the story branches.
 * Looks in `roots` (the folders next to the current repository, then the folders to look in; each root itself and its direct children) and in
 * `known` (clones already known, such as preferred ones). First by identity (the remote points to the repository `name`), then by a loose
 * comparison of the folder name. Several candidates: the rule of `chooseClone` (preferred, last used, first root, shortest path).
 */
export function findCloneByIdentity(name: string, roots: string[], known: string[] = [], preferred?: string): string | undefined {
  const cands: { path: string; lastUsed: number; rank: number; byRemote: boolean }[] = [];
  const seen = new Set<string>();
  const add = (dir: string, rank: number) => {
    const key = resolve(dir).toLowerCase();
    if (seen.has(key) || !existsSync(join(dir, ".git"))) return;
    seen.add(key);
    const byRemote = cloneIsOf(dir, name);
    const byFolder = looseName(basename(dir) ?? "") === looseName(name);
    if (byRemote || byFolder) cands.push({ path: resolve(dir), lastUsed: lastUsedOf(dir), rank, byRemote });
  };
  roots.forEach((r, i) => {
    add(r, i);
    for (const d of childDirs(r)) add(d, i);
  });
  known.forEach((d) => add(d, roots.length));
  const tier = cands.some((c) => c.byRemote) ? cands.filter((c) => c.byRemote) : cands;
  if (!tier.length) return undefined;
  return chooseClone(tier, preferred && tier.some((c) => samePath(c.path, preferred)) ? preferred : undefined);
}

/** The sentence when no clone is found: what to do, with the exact command (it is remembered). */
export const cloneNotFoundMessage = (name: string, where: string): string =>
  `can't find the clone of '${name}' next to ${where}; point aihub to its folder once with: aihub repos prefer "${name}" <folder> (aihub remembers it), or set repositories[].path in team.yaml`;
