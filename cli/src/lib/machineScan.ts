import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { configHome } from "./configHome.js";
import { pathKey } from "./recentUse.js";
import { readSetFile, repoBranch, type SetMeta } from "./setFile.js";

/**
 * Every repository clone and every worktree set on this PC, whichever folder is open. Lazy and cheap: only called when
 * a menu opens, walks a few levels of the folders to look in, reads `.git/HEAD`, `.git/config` and the set files as
 * files (no git process), skips node_modules and the like, and keeps the answer in `<config home>/scan-cache.json`
 * for a few minutes. Imports only node and the set file reader: the VS Code extension bundles this file as it is.
 */
export interface ScanRepo {
  name: string;
  path: string;
  branch: string;
  /** origin url without credentials, for finding the clones of one repository */
  remote?: string;
}

export interface ScanSet {
  /** the workspace file of the set, else its folder: stable and unique */
  id: string;
  folder: string;
  story: number;
  group?: string;
  branch: string;
  repos: { name: string; path: string; branch: string; exists: boolean }[];
}

export interface Scan {
  at: number;
  folders: string[];
  repos: ScanRepo[];
  sets: ScanSet[];
}

export const SCAN_TTL_MS = 5 * 60_000;
export const MAX_DEPTH = 3;
const MAX_VISITED = 5000;
const SKIP = new Set(["node_modules", "venv", "__pycache__", "dist", "build", "target", "out", "bin", "obj", "site-packages", "$recycle.bin", "system volume information", "appdata", "windows", "program files", "program files (x86)"]);
const CACHE = "scan-cache.json";
const LOOKIN = "lookin.json";

// ---- folders to look in ------------------------------------------------------------------------------------

export function readLookIn(env: NodeJS.ProcessEnv): string[] | undefined {
  try {
    const f = join(configHome(env), LOOKIN);
    if (!existsSync(f)) return undefined;
    const j = JSON.parse(readFileSync(f, "utf8")) as { folders?: unknown };
    return Array.isArray(j.folders) ? (j.folders as unknown[]).filter((x): x is string => typeof x === "string" && x.trim() !== "") : undefined;
  } catch {
    return undefined;
  }
}

export function writeLookIn(env: NodeJS.ProcessEnv, folders: string[]): void {
  const dir = configHome(env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, LOOKIN), JSON.stringify({ schema: 1, folders: unique(folders.map((f) => resolve(f))) }, null, 2), "utf8");
  forgetScan(env);
}

/** Back to the default: the parents of what is known. */
export function resetLookIn(env: NodeJS.ProcessEnv): void {
  rmSync(join(configHome(env), LOOKIN), { force: true });
  forgetScan(env);
}

const unique = (xs: string[]): string[] => {
  const seen = new Set<string>();
  return xs.filter((x) => !seen.has(pathKey(x)) && !!seen.add(pathKey(x)));
};

const isRoot = (p: string) => dirname(p) === p;

/**
 * The folders to look in: the personal list when there is one, else the parent folders of what is known (an open
 * folder, a recent item, a configured worktree root); never a drive root or the home folder itself.
 */
export function lookInFolders(env: NodeJS.ProcessEnv, known: string[]): string[] {
  const own = readLookIn(env);
  if (own) return unique(own.map((f) => resolve(f)));
  const home = pathKey(homedir());
  return unique(known.filter(Boolean).map((p) => dirname(resolve(p))).filter((p) => !isRoot(p) && pathKey(p) !== home));
}

// ---- reading a clone without git ---------------------------------------------------------------------------

/** The git dir of a clone (`.git` folder) or a linked worktree (`.git` file); undefined when it is neither. */
function gitDirOf(dir: string): { gitDir: string; linked: boolean } | undefined {
  const dot = join(dir, ".git");
  try {
    const st = statSync(dot);
    if (st.isDirectory()) return { gitDir: dot, linked: false };
    const m = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dot, "utf8"));
    return m ? { gitDir: resolve(dir, m[1].trim()), linked: true } : undefined;
  } catch {
    return undefined;
  }
}

/** The checked-out branch of a clone or worktree, from HEAD; "" when detached or unreadable. */
export function headBranchOf(dir: string): string {
  const g = gitDirOf(dir);
  if (!g) return "";
  try {
    return /^ref: refs\/heads\/(.+)$/m.exec(readFileSync(join(g.gitDir, "HEAD"), "utf8"))?.[1].trim() ?? "";
  } catch {
    return "";
  }
}

/** The url of remote origin from `.git/config`, without a user or password part. */
export function remoteOf(gitDir: string): string | undefined {
  try {
    const cfg = readFileSync(join(gitDir, "config"), "utf8");
    const m = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(cfg);
    return m ? m[1].replace(/\/\/[^@/]+@/, "//") : undefined;
  } catch {
    return undefined;
  }
}

/** True when `dir` is a clone (not a linked worktree). */
export const isClone = (dir: string): boolean => gitDirOf(dir)?.linked === false;

// ---- the walk ----------------------------------------------------------------------------------------------

function setsOf(folder: string): ScanSet[] {
  const f = readSetFile(folder);
  if (!f) return [];
  return [f.top, ...(f.top.others ?? [])].map((m: SetMeta) => ({
    id: m.workspace && existsSync(m.workspace) ? m.workspace : folder,
    folder,
    story: m.story,
    ...(m.group ? { group: m.group } : {}),
    branch: m.branch,
    repos: m.repos.map((r) => ({ name: r.name, path: r.path, branch: repoBranch(m, r), exists: existsSync(r.path) })),
  }));
}

const skipped = (name: string) => name.startsWith(".") || SKIP.has(name.toLowerCase());

/** One walk over `folders`: no cache. */
export function walk(folders: string[]): Scan {
  const repos = new Map<string, ScanRepo>();
  const sets = new Map<string, ScanSet>();
  let visited = 0;
  const visit = (dir: string, depth: number) => {
    if (visited++ > MAX_VISITED) return;
    const found = setsOf(dir);
    if (found.length) return void found.forEach((s) => sets.set(pathKey(s.id), s));
    const g = gitDirOf(dir);
    if (g) {
      // a linked worktree belongs to a repository or a set: it is no clone of its own
      if (!g.linked) repos.set(pathKey(dir), { name: basename(dir), path: dir, branch: headBranchOf(dir), ...(remoteOf(g.gitDir) ? { remote: remoteOf(g.gitDir) } : {}) });
      return;
    }
    if (depth >= MAX_DEPTH) return;
    let names: string[];
    try {
      names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !skipped(e.name)).map((e) => e.name);
    } catch {
      return;
    }
    for (const n of names) visit(join(dir, n), depth + 1);
  };
  // the folder itself may be a clone or a set; else its children are the usual case
  for (const f of folders) visit(f, 0);
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return { at: Date.now(), folders, repos: [...repos.values()].sort(byName), sets: [...sets.values()].sort((a, b) => a.folder.localeCompare(b.folder) || a.branch.localeCompare(b.branch)) };
}

// ---- the cache ---------------------------------------------------------------------------------------------

function readCache(env: NodeJS.ProcessEnv): Scan | undefined {
  try {
    const f = join(configHome(env), CACHE);
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Scan) : undefined;
  } catch {
    return undefined;
  }
}

/** The next scan walks again (after a branch switch, a new set, a removed set, a changed list of folders). */
export function forgetScan(env: NodeJS.ProcessEnv): void {
  try {
    const old = readCache(env);
    if (old) writeFileSync(join(configHome(env), CACHE), JSON.stringify({ ...old, at: 0 }), "utf8");
  } catch {
    /* nothing cached */
  }
}

/** The scan of `folders`: the cache while it is younger than the TTL and was made for the same folders, else a new walk. */
export function scanMachine(env: NodeJS.ProcessEnv, folders: string[], o: { refresh?: boolean; now?: number; ttlMs?: number } = {}): Scan {
  const now = o.now ?? Date.now();
  const cached = o.refresh ? undefined : readCache(env);
  const same = !!cached && cached.folders.length === folders.length && cached.folders.every((f, i) => pathKey(f) === pathKey(folders[i]));
  if (cached && same && cached.at > 0 && now - cached.at < (o.ttlMs ?? SCAN_TTL_MS)) return cached;
  const fresh = { ...walk(folders), at: now };
  try {
    const dir = configHome(env);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `${CACHE}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(fresh), "utf8");
    renameSync(tmp, join(dir, CACHE));
  } catch {
    /* an unwritable cache only costs the next walk */
  }
  return fresh;
}

/** The set whose workspace file or folder is `id` (as ScanSet.id says). */
export const setById = (scan: Scan, id: string): ScanSet | undefined => scan.sets.find((s) => pathKey(s.id) === pathKey(id)) ?? scan.sets.find((s) => pathKey(s.folder) === pathKey(id));

/** The set of a story (a story has one set). */
export const setOfStory = (scan: Scan, story: number): ScanSet | undefined => scan.sets.find((s) => s.story === story);
