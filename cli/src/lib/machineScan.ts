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
  /** the other clones of the same remote on this PC (set when the list is made one-per-remote) */
  otherClones?: string[];
  /** every clone of the remote on this PC, the one in use included (set when there is more than one) */
  clones?: { path: string; branch: string }[];
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

/** A place where a branch is checked out now: a clone (its main folder) or a linked worktree of it. */
export interface ScanCheckout {
  /** the name of the repository (the folder of its clone, or its name in a set) */
  repo: string;
  branch: string;
  path: string;
  /** the main folder of a clone (false: a linked worktree) */
  main: boolean;
  /** the clone a linked worktree belongs to, when the clone was walked */
  clone?: string;
}

/** The branch names of a clone (local and origin), read from its ref files and packed-refs; at most MAX_REFS. */
export interface ScanRefs {
  repo: string;
  path: string;
  branches: string[];
}

export interface Scan {
  at: number;
  folders: string[];
  repos: ScanRepo[];
  sets: ScanSet[];
  /** every place on this PC where a branch is checked out now (detached ones left out); absent in an older cache */
  checkouts?: ScanCheckout[];
  /** the branches each clone knows (local and origin); absent in an older cache */
  refs?: ScanRefs[];
  /** the walk stopped at MAX_VISITED folders: not everything was looked at */
  truncated?: boolean;
  /** OneDrive and network folders that were skipped (they are only read when listed in "Folders to Look In") */
  skippedRemote?: string[];
}

/** A OneDrive folder or a network share (UNC path): read slowly, may download files. */
export function isRemoteFolder(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const key = dir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  if (key.startsWith("//")) return true;
  if (key.split("/").some((s) => s.startsWith("onedrive"))) return true;
  return [env.OneDrive, env.OneDriveCommercial, env.OneDriveConsumer].some((r) => !!r && (key === pathKey(r) || key.startsWith(pathKey(r) + "/")));
}

export const SCAN_TTL_MS = 5 * 60_000;
export const MAX_DEPTH = 3;
const MAX_VISITED = 5000;
const MAX_WORKTREES = 50;
export const MAX_REFS = 300;
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

/**
 * The origin url (without credentials) of a clone or of a linked worktree (its config is in the main clone: `commondir`); undefined
 * without git or without origin. A repository of a worktree set is no clone of its own in the scan, but it has a remote all the same.
 */
export function remoteOfFolder(dir: string): string | undefined {
  const g = gitDirOf(dir);
  if (!g) return undefined;
  if (!g.linked) return remoteOf(g.gitDir);
  try {
    const common = readFileSync(join(g.gitDir, "commondir"), "utf8").trim();
    return remoteOf(resolve(g.gitDir, common || "."));
  } catch {
    return remoteOf(g.gitDir);
  }
}

/** The folder with HEAD for a clone or a linked worktree (a worktree's is inside the main clone's .git); undefined when `dir` has no git. */
export const gitDirFor = (dir: string): string | undefined => gitDirOf(dir)?.gitDir;

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
    // the whole line: a repository name may hold spaces ("_git/Repo With Spaces"), and git keeps them as typed
    const m = /\[remote "origin"\][^[]*?\burl\s*=\s*([^\r\n]+)/.exec(cfg);
    const url = m?.[1].trim().replace(/^"(.*)"$/, "$1");
    return url ? url.replace(/\/\/[^@/]+@/, "//") : undefined;
  } catch {
    return undefined;
  }
}

/** The linked worktrees of a clone, from `.git/worktrees/<name>/{HEAD,gitdir}`: path and branch (detached and gone ones left out). */
export function worktreesFromFiles(gitDir: string): { path: string; branch: string }[] {
  const base = join(gitDir, "worktrees");
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return [];
  }
  const out: { path: string; branch: string }[] = [];
  for (const n of names.slice(0, MAX_WORKTREES)) {
    try {
      const branch = /^ref: refs\/heads\/(.+)$/m.exec(readFileSync(join(base, n, "HEAD"), "utf8"))?.[1].trim();
      // gitdir holds "<worktree>/.git"
      const path = dirname(resolve(base, n, readFileSync(join(base, n, "gitdir"), "utf8").trim()));
      if (branch && existsSync(path)) out.push({ path, branch });
    } catch {
      /* a half removed worktree: left out */
    }
  }
  return out;
}

/** The branch names a clone knows, local first, then origin's (without "origin/"); loose ref files and packed-refs, no git. */
export function refsFromFiles(gitDir: string, max = MAX_REFS): string[] {
  const names = new Set<string>();
  const loose = (dir: string, prefix: string, depth: number) => {
    if (depth > 6 || names.size >= max) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (names.size >= max) return;
      if (e.isDirectory()) loose(join(dir, e.name), `${prefix}${e.name}/`, depth + 1);
      else if (!(depth === 0 && e.name === "HEAD")) names.add(prefix + e.name);
    }
  };
  loose(join(gitDir, "refs", "heads"), "", 0);
  loose(join(gitDir, "refs", "remotes", "origin"), "", 0);
  try {
    for (const l of readFileSync(join(gitDir, "packed-refs"), "utf8").split(/\r?\n/)) {
      if (names.size >= max) break;
      const m = /^[0-9a-f]{40,64} refs\/(?:heads|remotes\/origin)\/(.+)$/.exec(l);
      if (m && m[1] !== "HEAD") names.add(m[1]);
    }
  } catch {
    /* no packed-refs */
  }
  return [...names];
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
export function walk(folders: string[], o: { allowRemote?: boolean; env?: NodeJS.ProcessEnv } = {}): Scan {
  const repos = new Map<string, ScanRepo>();
  const sets = new Map<string, ScanSet>();
  const checkouts = new Map<string, ScanCheckout>();
  const refs: ScanRefs[] = [];
  let visited = 0;
  let truncated = false;
  const skippedRemote: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (visited++ > MAX_VISITED) return void (truncated = true);
    // OneDrive folders and network shares are slow to read and may download files: only read when they are listed in "Folders to Look In"
    if (!o.allowRemote && isRemoteFolder(dir, o.env ?? process.env)) return void skippedRemote.push(dir);
    const found = setsOf(dir);
    if (found.length) return void found.forEach((s) => sets.set(pathKey(s.id), s));
    const g = gitDirOf(dir);
    if (g) {
      // a linked worktree belongs to a repository or a set: it is no clone of its own
      if (!g.linked) {
        const name = basename(dir);
        const branch = headBranchOf(dir);
        repos.set(pathKey(dir), { name, path: dir, branch, ...(remoteOf(g.gitDir) ? { remote: remoteOf(g.gitDir) } : {}) });
        // where its branches are checked out, and which branches it knows: files only
        if (branch) checkouts.set(pathKey(dir), { repo: name, branch, path: dir, main: true });
        for (const w of worktreesFromFiles(g.gitDir)) if (!checkouts.has(pathKey(w.path))) checkouts.set(pathKey(w.path), { repo: name, branch: w.branch, path: w.path, main: false, clone: dir });
        refs.push({ repo: name, path: dir, branches: refsFromFiles(g.gitDir) });
      }
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
  // a worktree of a set whose clone is outside the folders to look in: its branch from its own HEAD; the set's name for it
  for (const s of sets.values())
    for (const r of s.repos) {
      const known = checkouts.get(pathKey(r.path));
      if (known) known.repo = r.name;
      else if (r.exists) {
        const branch = headBranchOf(r.path);
        if (branch) checkouts.set(pathKey(r.path), { repo: r.name, branch, path: r.path, main: false });
      }
    }
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const byRepo = (a: { repo: string; path: string }, b: { repo: string; path: string }) => a.repo.localeCompare(b.repo) || a.path.localeCompare(b.path);
  return { at: Date.now(), folders, repos: [...repos.values()].sort(byName), sets: [...sets.values()].sort((a, b) => a.folder.localeCompare(b.folder) || a.branch.localeCompare(b.branch)), checkouts: [...checkouts.values()].sort(byRepo), refs: refs.sort(byRepo), ...(truncated ? { truncated } : {}), ...(skippedRemote.length ? { skippedRemote } : {}) };
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
  const fresh = { ...walk(folders, { allowRemote: readLookIn(env) !== undefined, env }), at: now };
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
