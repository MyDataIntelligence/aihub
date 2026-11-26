import { statSync } from "node:fs";
import { join, resolve } from "node:path";

export const samePath = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase();

/**
 * THE rule for which clone of a repository wins, for the CLI and for the extension: the preferred one (`aihub repos prefer`), else the
 * most recently used, else the first in the folders to look in (`rank`, lower first), else the shortest path, else by path.
 */
export function chooseClone(clones: { path: string; lastUsed: number; rank?: number }[], preferred?: string): string {
  if (preferred) {
    const hit = clones.find((c) => samePath(c.path, preferred));
    if (hit) return hit.path;
  }
  return [...clones].sort((a, b) => b.lastUsed - a.lastUsed || (a.rank ?? 0) - (b.rank ?? 0) || a.path.length - b.path.length || a.path.localeCompare(b.path))[0].path;
}

/** When a clone was last used: the newest of .git/index and .git/HEAD (git writes them on status, commit, switch). */
export function usedAt(dir: string): number {
  let t = 0;
  for (const f of ["index", "HEAD"]) {
    try {
      t = Math.max(t, statSync(join(dir, ".git", f)).mtimeMs);
    } catch {
      /* missing: never used */
    }
  }
  return t;
}
