import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { readSetFile, repoBranch, type SetKind } from "./setFile.js";

export interface SetInfo {
  folder: string;
  story: number;
  /** repo group name of a set made by `aihub worktree open` (story is 0 then) */
  group?: string;
  branch: string;
  /** repositories in the set file, also the ones whose folder is gone */
  total: number;
  /** each with its own branch (the set's branch unless one repository was put on another) */
  repos: { name: string; path: string; branch: string }[];
  /** which set file: `.aihub-set.json` (aihub) or `.worktree-set.json` (the extension's Worktree Sets) */
  kind: SetKind;
}

const under = (cwd: string, p: string) => {
  const a = resolve(cwd).toLowerCase();
  const b = resolve(p).toLowerCase();
  return a === b || a.startsWith(b.endsWith("\\") || b.endsWith("/") ? b : b + (b.includes("\\") ? "\\" : "/"));
};

/**
 * The worktree set (`aihub worktree create|open`, `aihub story open`, the extension's Worktree Sets) this folder
 * belongs to: the folder with a set file above it, or itself. A story folder can hold several sets (one per branch):
 * the one whose repositories contain `cwd` wins, else the newest.
 */
export function findSet(cwd: string): SetInfo | undefined {
  let dir = resolve(cwd);
  for (let i = 0; i < 6; i++) {
    const file = readSetFile(dir);
    if (file) {
      const all = [file.top, ...(file.top.others ?? [])];
      const m = all.find((s) => s.repos.some((r) => under(cwd, r.path))) ?? file.top;
      return {
        folder: dir,
        story: m.story,
        group: m.group,
        branch: m.branch,
        total: m.repos.length,
        repos: m.repos.filter((r) => existsSync(r.path)).map((r) => ({ name: r.name, path: r.path, branch: repoBranch(m, r) })),
        kind: file.kind,
      };
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

/** "repo-a, repo-b (feature/2-y)": a repository's branch is named only when it is not the set's branch. */
export const reposWithBranch = (set: Pick<SetInfo, "branch" | "repos">): string => set.repos.map((r) => (r.branch && r.branch !== set.branch ? `${r.name} (${r.branch})` : r.name)).join(", ");
