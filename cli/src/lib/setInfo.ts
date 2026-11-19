import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const SET_META = ".aihub-set.json";

export interface SetInfo {
  folder: string;
  story: number;
  /** repo group name of a set made by `aihub worktree open` (story is 0 then) */
  group?: string;
  branch: string;
  /** repositories in the set file, also the ones whose folder is gone */
  total: number;
  repos: { name: string; path: string }[];
}

/** The worktree set (`aihub worktree create`) this folder belongs to: the folder with .aihub-set.json above it, or itself. */
export function findSet(cwd: string): SetInfo | undefined {
  let dir = resolve(cwd);
  for (let i = 0; i < 6; i++) {
    const meta = join(dir, SET_META);
    if (existsSync(meta)) {
      try {
        const m = JSON.parse(readFileSync(meta, "utf8")) as { story: number; group?: string; branch: string; repos: { name: string; path: string }[] };
        return { folder: dir, story: m.story, group: m.group, branch: m.branch, total: m.repos.length, repos: m.repos.filter((r) => existsSync(r.path)).map((r) => ({ name: r.name, path: r.path })) };
      } catch {
        return undefined;
      }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}
