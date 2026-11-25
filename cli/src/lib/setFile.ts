import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { storyIdFromBranch } from "./storyWorktrees.js";

/**
 * The two set files a set folder can hold, read and written here only (no git, no process):
 * - `.aihub-set.json`: written by `aihub worktree create|open` and `aihub story open`;
 * - `.worktree-set.json` (schema 1): written by the Worktree Sets of the VS Code extension (and the older Worktree
 *   Maker). Paths inside the set folder are relative there; `repos[].branch` only when it differs from the set's branch.
 * Both keep their field names; a repository's own branch is the optional `repos[].branch`, else the set's `branch`.
 */
export const AIHUB_SET = ".aihub-set.json";
export const MAKER_SET = ".worktree-set.json";
export type SetKind = "aihub" | "maker";

export interface SetRepo {
  name: string;
  source: string;
  path: string;
  /** this repository's branch when it is not the set's branch (one repository switched, or `--branch-for`) */
  branch?: string;
}

export interface SetMeta {
  story: number;
  /** repo group name when `aihub worktree open` made the set (story is 0 then) */
  group?: string;
  /** the .code-workspace file of the set; removed with the set */
  workspace?: string;
  branch: string;
  repos: SetRepo[];
  /** the other sets in the same folder (a story folder holds one set per branch); newest is the top one */
  others?: SetMeta[];
}

export const repoBranch = (meta: Pick<SetMeta, "branch">, r: Pick<SetRepo, "branch">): string => r.branch || meta.branch;

/** The set file of `folder` (`.aihub-set.json` first), in the shape of SetMeta; undefined when there is none or it is broken. */
export function readSetFile(folder: string): { kind: SetKind; top: SetMeta } | undefined {
  try {
    if (existsSync(join(folder, AIHUB_SET))) {
      const top = JSON.parse(readFileSync(join(folder, AIHUB_SET), "utf8")) as SetMeta;
      return Array.isArray(top?.repos) ? { kind: "aihub", top } : undefined;
    }
    if (existsSync(join(folder, MAKER_SET))) {
      const j = JSON.parse(readFileSync(join(folder, MAKER_SET), "utf8").replace(/^\uFEFF/, "")) as { branch?: unknown; slug?: unknown; repos?: unknown };
      if (typeof j.branch !== "string" || !Array.isArray(j.repos)) return undefined;
      const repos: SetRepo[] = [];
      for (const r of j.repos as Record<string, unknown>[]) {
        if (!r || typeof r.name !== "string" || typeof r.source !== "string" || typeof r.path !== "string") continue;
        repos.push({ name: r.name, source: r.source, path: resolve(folder, r.path), ...(typeof r.branch === "string" && r.branch ? { branch: r.branch } : {}) });
      }
      const slug = typeof j.slug === "string" && j.slug ? j.slug : j.branch.replace(/[\\/:*?"<>|\s]+/g, "-");
      return { kind: "maker", top: { story: storyIdFromBranch(j.branch) ?? 0, branch: j.branch, workspace: join(folder, `${slug}.code-workspace`), repos } };
    }
  } catch {
    /* a broken set file is no set */
  }
  return undefined;
}

/** Writes `meta` back into the set file of its kind; `.aihub-set.json` keeps the other sets of the folder. */
export function writeSetFile(folder: string, kind: SetKind, meta: SetMeta): void {
  const repos = meta.repos.map((r) => ({ ...r, branch: r.branch && r.branch !== meta.branch ? r.branch : undefined }));
  if (kind === "aihub") return writeSetMeta(folder, { ...meta, repos });
  const p = join(folder, MAKER_SET);
  const raw = JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown> & { repos?: Record<string, unknown>[] };
  const old = new Map((raw.repos ?? []).map((r) => [String(r.name), r]));
  const rel = (x: string) => {
    const r = relative(folder, x);
    return r && !r.startsWith("..") && !/^[A-Za-z]:/.test(r) && !r.startsWith("/") ? r.split("\\").join("/") : resolve(x);
  };
  raw.repos = [...repos]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => {
      const base = old.get(r.name)?.base;
      return { name: r.name, source: r.source, path: rel(r.path), ...(r.branch ? { branch: r.branch } : {}), ...(typeof base === "string" ? { base } : {}) };
    });
  raw.updatedAt = new Date().toISOString();
  writeFileSync(p, JSON.stringify(raw, null, 2) + "\n", "utf8");
}

/** Writes `meta` as the newest set of `folder`, keeping the other sets there (one per story and branch). */
export function writeSetMeta(folder: string, meta: SetMeta): void {
  const p = join(folder, AIHUB_SET);
  let old: SetMeta[] = [];
  try {
    const top = JSON.parse(readFileSync(p, "utf8")) as SetMeta;
    old = [{ ...top, others: undefined }, ...(top.others ?? [])];
  } catch {
    /* no set file yet, or a broken one: start fresh */
  }
  const same = (a: SetMeta) => a.story === meta.story && a.branch === meta.branch && (a.group ?? "") === (meta.group ?? "");
  const others = old.filter((s) => !same(s)).map(({ others: _o, ...s }) => s);
  writeFileSync(p, JSON.stringify({ ...meta, ...(others.length ? { others } : {}) }, null, 2), "utf8");
}
