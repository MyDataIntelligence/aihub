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

type MetaLike = { story: number; group?: string; branch: string; repos: { name: string; path: string }[]; others?: MetaLike[] };

const under = (cwd: string, p: string) => {
  const a = resolve(cwd).toLowerCase();
  const b = resolve(p).toLowerCase();
  return a === b || a.startsWith(b.endsWith("\\") || b.endsWith("/") ? b : b + (b.includes("\\") ? "\\" : "/"));
};

/**
 * The worktree set (`aihub worktree create|open`, `aihub story open`) this folder belongs to: the folder with
 * .aihub-set.json above it, or itself. A story folder can hold several sets (one per branch): the one whose
 * repositories contain `cwd` wins, else the newest.
 */
export function findSet(cwd: string): SetInfo | undefined {
  let dir = resolve(cwd);
  for (let i = 0; i < 6; i++) {
    const meta = join(dir, SET_META);
    if (existsSync(meta)) {
      try {
        const top = JSON.parse(readFileSync(meta, "utf8")) as MetaLike;
        const all = [top, ...(top.others ?? [])];
        const m = all.find((s) => s.repos.some((r) => under(cwd, r.path))) ?? top;
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
