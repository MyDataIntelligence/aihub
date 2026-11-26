import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tryGit } from "./gitx.js";
import { configHome } from "./configHome.js";
import { gitCommonDir } from "./storyWorktrees.js";

/**
 * Files that git does not track and ignores (`.env`, local configuration, notes) are work too: `git worktree remove`
 * deletes them without a word. Before a worktree is removed or made again they are inventoried, and what is left
 * after the build and cache folders are left out is copied to `<git common dir>/aihub/backup/<worktree>-<time>/`
 * with the relative paths kept. A file over MAX_FILE_BYTES, or more than MAX_TOTAL_BYTES in all, is not copied: the
 * removal is refused with the names, unless the user said `--discard-local-work`.
 */

/** Folders and files that are rebuilt from the project: never inventoried. One place; a personal list adds to it (see `ignoredByYou`). */
export const BUILD_NAMES = ["node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", "dist", "build", "target", ".tox", ".idea", ".vscode-test", "*.pyc"];
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const MAX_FILES = 5000;

/** `ignoreInBackup` in the personal `<config home>/worktrees.json`: more names (`generated`) or `*.ext` patterns. */
export function ignoredByYou(env: NodeJS.ProcessEnv): string[] {
  try {
    const v = (JSON.parse(readFileSync(join(configHome(env), "worktrees.json"), "utf8")) as { ignoreInBackup?: unknown }).ignoreInBackup;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : [];
  } catch {
    return [];
  }
}

const matches = (name: string, patterns: string[]): boolean => patterns.some((p) => (p.startsWith("*") ? name.toLowerCase().endsWith(p.slice(1).toLowerCase()) : name.toLowerCase() === p.toLowerCase()));

export interface LocalFile {
  /** relative path, forward slashes */
  rel: string;
  bytes: number;
}

export interface LocalInventory {
  files: LocalFile[];
  bytes: number;
  /** more files than MAX_FILES: the list stops there */
  tooMany: boolean;
}

/** The ignored files of a worktree that are not build or cache output. One `git status`; the rest is file reads. */
export function inventoryIgnored(worktree: string, env: NodeJS.ProcessEnv = process.env): LocalInventory {
  const skip = [...BUILD_NAMES, ...ignoredByYou(env)];
  const st = tryGit(worktree, ["status", "--porcelain", "-z", "--ignored=traditional"]);
  const out: LocalInventory = { files: [], bytes: 0, tooMany: false };
  if (!st.ok) return out;
  const add = (rel: string, abs: string) => {
    if (out.files.length >= MAX_FILES) return void (out.tooMany = true);
    let size = 0;
    try {
      const s = lstatSync(abs);
      if (s.isSymbolicLink()) return;
      size = s.size;
    } catch {
      return;
    }
    out.files.push({ rel, bytes: size });
    out.bytes += size;
  };
  const walk = (rel: string) => {
    let entries;
    try {
      entries = readdirSync(join(worktree, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.tooMany) return;
      if (matches(e.name, skip) || e.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else add(r, join(worktree, r));
    }
  };
  for (const entry of st.out.split("\0")) {
    if (!entry.startsWith("!! ")) continue;
    const raw = entry.slice(3);
    const dir = raw.endsWith("/");
    const rel = dir ? raw.slice(0, -1) : raw;
    if (rel.split("/").some((seg) => matches(seg, skip))) continue;
    if (dir) walk(rel);
    else add(rel, join(worktree, rel));
    if (out.tooMany) break;
  }
  return out;
}

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;
const names = (files: LocalFile[], n = 3) => `${files.slice(0, n).map((f) => f.rel).join(", ")}${files.length > n ? `, ... (${files.length} in all)` : ""}`;
const count = (n: number) => `${n} ignored local file${n === 1 ? "" : "s"}`;

/** What a question or a message says about them: "2 ignored local files (.env, notes/todo.txt)", or "". */
export const describeLocal = (inv: LocalInventory): string => (inv.files.length ? `${count(inv.files.length)} (${names(inv.files)})` : "");

/** Why the ignored local files of a worktree cannot be saved (too big or too many), or undefined when they can; the text a removal says. */
export function localFilesProblem(inv: LocalInventory): string | undefined {
  const big = inv.files.filter((f) => f.bytes > MAX_FILE_BYTES);
  if (!big.length && inv.bytes <= MAX_TOTAL_BYTES && !inv.tooMany) return undefined;
  const why = big.length ? `${big.length} over ${mb(MAX_FILE_BYTES)} (${names(big)})` : inv.tooMany ? `more than ${MAX_FILES} files` : `${mb(inv.bytes)} in all`;
  return `${describeLocal(inv)}, too big to save: ${why}`;
}

export type Guarded = { ok: true; note: string; backup?: string } | { ok: false; note: string };

/**
 * Before `worktree` goes: copy its ignored local files to the backup folder, or refuse when they are too big to copy
 * (unless `discard`). `note` is one short line for the user; `backup` is the folder when files were copied.
 */
export function guardLocalFiles(worktree: string, source: string, o: { discard?: boolean; env?: NodeJS.ProcessEnv; now?: number } = {}): Guarded {
  const inv = inventoryIgnored(worktree, o.env);
  if (!inv.files.length) return { ok: true, note: "" };
  const big = inv.files.filter((f) => f.bytes > MAX_FILE_BYTES);
  if (big.length || inv.bytes > MAX_TOTAL_BYTES || inv.tooMany) {
    const why = big.length ? `${big.length} over ${mb(MAX_FILE_BYTES)} (${names(big)})` : inv.tooMany ? `more than ${MAX_FILES} files` : `${mb(inv.bytes)} in all`;
    if (!o.discard) return { ok: false, note: `${describeLocal(inv)}, too big to save: ${why}; nothing was removed. Move them away yourself, or add --discard-local-work to remove them anyway` };
    return { ok: true, note: `${count(inv.files.length)} were too big to save (${why}) and went with the worktree (--discard-local-work)` };
  }
  const common = gitCommonDir(source) ?? gitCommonDir(worktree);
  if (!common) return { ok: false, note: `${describeLocal(inv)} cannot be saved: no git folder found; nothing was removed` };
  const stamp = new Date(o.now ?? Date.now()).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  const dest = join(common, "aihub", "backup", `${basename(worktree).replace(/[\\/:*?"<>|\s]+/g, "-")}-${stamp}`);
  try {
    for (const f of inv.files) {
      const to = join(dest, f.rel);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(join(worktree, f.rel), to);
    }
  } catch (e) {
    return { ok: false, note: `${describeLocal(inv)} could not be saved (${(e as Error).message.split("\n")[0]}); nothing was removed` };
  }
  return { ok: true, backup: dest, note: `${count(inv.files.length)} saved in ${dest} (${names(inv.files)})` };
}
