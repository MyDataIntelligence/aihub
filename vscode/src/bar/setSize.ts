import { promises as fsp, statSync } from "node:fs";
import { join } from "node:path";
import type { ScanSet } from "../../../cli/src/lib/machineScan";
import type { BarPr } from "./types";

/**
 * Clean-up facts about a set: how much disk it holds (measured in the background when the menu opens, remembered until
 * the set changes) and whether everything in it is merged and nothing would be lost. No vscode here.
 */

/** Bytes in the folders, links not followed, measured without blocking: the walk gives the event loop a turn every 200 entries. */
export async function sizeOfDirs(paths: string[], o: { yieldEvery?: number } = {}): Promise<number> {
  const every = o.yieldEvery ?? 200;
  let total = 0;
  let seen = 0;
  const stack = [...paths];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else {
        try {
          total += (await fsp.lstat(p)).size;
        } catch {
          /* gone while measuring */
        }
      }
      if (++seen % every === 0) await new Promise((r) => setImmediate(r));
    }
  }
  return total;
}

/** What makes a measured size stale: the set file (it changes with every add, drop and switch) and the worktrees it names. */
export function setKey(s: Pick<ScanSet, "folder" | "repos">, file: (folder: string) => string[] = defaultSetFiles): string {
  const stamp = file(s.folder).map((f) => {
    try {
      return statSync(f).mtimeMs;
    } catch {
      return 0;
    }
  });
  return `${stamp.join(",")}|${s.repos.map((r) => `${r.path}:${r.exists ? 1 : 0}`).join(",")}`;
}
const defaultSetFiles = (folder: string): string[] => [join(folder, ".aihub-set.json"), join(folder, ".worktree-set.json")];

/** Sizes per set, measured one set after the other in the background and remembered until the set changes. */
export class SizeMemo {
  private sizes = new Map<string, { key: string; bytes: number }>();
  private running = false;
  constructor(private measure: (paths: string[]) => Promise<number> = sizeOfDirs) {}

  /** The remembered size, when it is still the size of this set. */
  get(id: string, key: string): number | undefined {
    const had = this.sizes.get(id);
    return had && had.key === key ? had.bytes : undefined;
  }

  /** Measures the sets whose size is unknown or stale; `done` runs after each one (the state changes). One run at a time. */
  async measureAll(sets: { id: string; key: string; paths: string[] }[], done: () => void): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const s of sets) {
        if (this.get(s.id, s.key) !== undefined) continue;
        this.sizes.set(s.id, { key: s.key, bytes: await this.measure(s.paths) });
        done();
      }
    } finally {
      this.running = false;
    }
  }
}

export interface MergedFacts {
  pr: (repo: string, branch: string) => BarPr | undefined;
  /** changed files of a worktree; undefined when it cannot say */
  changes: (path: string) => Promise<number | undefined>;
  /** commits that are on no remote; undefined when it cannot say */
  unpushed: (path: string) => Promise<number | undefined>;
}

/** Every repository of the set has a merged pull request for its branch (read from the one memory of pull requests; no call). */
export const allPrsMerged = (s: Pick<ScanSet, "repos">, pr: MergedFacts["pr"]): boolean => {
  const live = s.repos.filter((r) => r.exists);
  return live.length > 0 && live.every((r) => pr(r.name, r.branch)?.status === "merged");
};

/**
 * allMerged: every repository has a merged pull request AND nothing in the set would be lost: no uncommitted file and no
 * commit that is on no remote. Unknown counts as not merged (never offer to remove on a guess).
 */
export async function allMerged(s: Pick<ScanSet, "repos">, f: MergedFacts): Promise<boolean> {
  if (!allPrsMerged(s, f.pr)) return false;
  for (const r of s.repos.filter((x) => x.exists)) {
    const [changes, unpushed] = await Promise.all([f.changes(r.path), f.unpushed(r.path)]);
    if (changes !== 0 || unpushed !== 0) return false;
  }
  return true;
}
