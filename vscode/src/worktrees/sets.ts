import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { branchSlug, listWorktrees, removeWorktree } from "./core";
import type { Repo, RemoveResult } from "./core";
import type { Git } from "./git";

export const SET_FILE = ".worktree-set.json";

export interface SetRepo {
  name: string;
  source: string;
  /** The branch of this worktree when it differs from the set's branch ("New branch from it"). */
  branch?: string;
  path: string;
  base?: string;
}

export interface WorktreeSet {
  schemaVersion: 1;
  branch: string;
  slug: string;
  base?: string;
  createdAt: string;
  updatedAt: string;
  repos: SetRepo[];
  folder: string;
}

// ---------------------------------------------------------------- paths

/** The one default folder for sets: C:/git/worktrees on Windows, ~/git/worktrees elsewhere. Never derived from the repos. */
export function defaultSetsRoot(platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string {
  return platform === "win32" ? "C:\\git\\worktrees" : path.join(home, "git", "worktrees");
}

/**
 * The folder new sets go to: worktreeMaker.setsRoot, else the older worktreeMaker.worktreeRoot when the user set it,
 * else defaultSetsRoot(). The same answer for creating and for listing, whichever repos are selected.
 */
export function resolveSetsRoot(setsRoot: string, legacyWorktreeRoot = ""): string {
  return (setsRoot ?? "").trim() || (legacyWorktreeRoot ?? "").trim() || defaultSetsRoot();
}

/** @deprecated kept for callers of 0.1.0-dev builds; the repos no longer decide the root. */
export function resolveWorktreeRoot(setting: string, _repos: Repo[]): string {
  return resolveSetsRoot(setting);
}

/**
 * Folders where earlier builds may have put sets: <repo root>/worktrees and <parent of repo root>/worktrees (an empty
 * root setting used to mean "next to the first repo"), plus extra folders. Deduplicated, without the current root.
 */
export function legacySetRoots(repoRoots: string[], current: string, extra: string[] = []): string[] {
  const out: string[] = [];
  const seen = new Set([norm(current)]);
  for (const r of [...repoRoots.flatMap((root) => [path.join(root, "worktrees"), path.join(path.dirname(root), "worktrees")]), ...extra]) {
    const k = norm(r);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(r);
    }
  }
  return out;
}

/** listSets over several roots; a set folder found twice (junctions, overlapping roots) is listed once. */
export async function listSetsIn(roots: string[]): Promise<WorktreeSet[]> {
  const seen = new Set<string>();
  const all: WorktreeSet[] = [];
  for (const root of roots) {
    for (const s of await listSets(root)) {
      const k = norm(s.folder);
      if (seen.has(k)) continue;
      seen.add(k);
      all.push(s);
    }
  }
  return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** findSetContaining over several roots. */
export async function findSetContainingIn(roots: string[], anyPath: string): Promise<WorktreeSet | undefined> {
  for (const root of roots) {
    const s = await findSetContaining(root, anyPath);
    if (s) return s;
  }
  return undefined;
}

export function repoFolderName(repo: Repo): string {
  return repo.name.replace(/[\/\\]/g, "-");
}

export function setFolder(root: string, branch: string): string {
  return path.join(root, branchSlug(branch));
}

export function repoWorktreePath(root: string, branch: string, repo: Repo): string {
  return path.join(setFolder(root, branch), repoFolderName(repo));
}

export function setWorkspaceFile(set: Pick<WorktreeSet, "folder" | "slug">): string {
  return path.join(set.folder, set.slug + ".code-workspace");
}

// ---------------------------------------------------------------- read / write

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.lstat(p);
    return true;
  } catch {
    return false;
  }
}

function toRel(folder: string, p: string): string {
  return path.relative(folder, p).split(path.sep).join("/");
}

export async function readSet(folder: string): Promise<WorktreeSet | undefined> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(path.join(folder, SET_FILE), "utf8");
  } catch {
    return undefined;
  }
  try {
    const j = JSON.parse(raw.replace(/^﻿/, "")) as Record<string, unknown>;
    if (!j || typeof j !== "object" || typeof j.branch !== "string" || !Array.isArray(j.repos)) return undefined;
    const repos: SetRepo[] = [];
    for (const r of j.repos as Record<string, unknown>[]) {
      if (!r || typeof r.name !== "string" || typeof r.source !== "string" || typeof r.path !== "string") continue;
      const entry: SetRepo = { name: r.name, source: r.source, path: path.resolve(folder, r.path) };
      if (typeof r.branch === "string" && r.branch) entry.branch = r.branch;
      if (typeof r.base === "string") entry.base = r.base;
      repos.push(entry);
    }
    const now = new Date().toISOString();
    const set: WorktreeSet = {
      schemaVersion: 1,
      branch: j.branch,
      slug: typeof j.slug === "string" && j.slug ? j.slug : branchSlug(j.branch),
      createdAt: typeof j.createdAt === "string" ? j.createdAt : now,
      updatedAt: typeof j.updatedAt === "string" ? j.updatedAt : now,
      repos,
      folder,
    };
    if (typeof j.base === "string") set.base = j.base;
    return set;
  } catch {
    return undefined;
  }
}

/** A member path as stored: relative with forward slashes when inside the set folder, else absolute. */
function setPath(folder: string, p: string): string {
  const rel = path.relative(folder, p);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return toRel(folder, p);
  return path.resolve(p);
}

export async function writeSet(set: WorktreeSet): Promise<void> {
  const folder = set.folder;
  await fs.promises.mkdir(folder, { recursive: true });
  const repos = [...set.repos].sort((a, b) => a.name.localeCompare(b.name));

  const meta: Record<string, unknown> = {
    schemaVersion: 1,
    branch: set.branch,
    slug: set.slug,
  };
  if (set.base !== undefined) meta.base = set.base;
  meta.createdAt = set.createdAt;
  meta.updatedAt = set.updatedAt;
  meta.repos = repos.map((r) => {
    const o: Record<string, unknown> = { name: r.name, source: r.source, path: setPath(folder, r.path) };
    if (r.branch && r.branch !== set.branch) o.branch = r.branch;
    if (r.base !== undefined) o.base = r.base;
    return o;
  });
  // a temporary file and a rename: the watcher of the bar never reads half a set file, a crash leaves the old one
  const setFile = path.join(folder, SET_FILE);
  const tmp = `${setFile}.${process.pid}.tmp`;
  const text = JSON.stringify(meta, null, 2) + "\n";
  try {
    await fs.promises.writeFile(tmp, text, "utf8");
    await fs.promises.rename(tmp, setFile);
  } catch {
    await fs.promises.rm(tmp, { force: true });
    await fs.promises.writeFile(setFile, text, "utf8");
  }

  const wsFile = setWorkspaceFile(set);
  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse((await fs.promises.readFile(wsFile, "utf8")).replace(/^﻿/, ""));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
  } catch {
    existing = {};
  }
  const ws: Record<string, unknown> = { ...existing };
  // Inside the set folder: relative (the set can be moved as a whole). A reused worktree elsewhere: its absolute path.
  ws.folders = repos.map((r) => ({ name: `${r.name} (${r.branch ?? set.branch})`, path: setPath(folder, r.path) }));
  if (!("settings" in ws)) ws.settings = {};
  await fs.promises.writeFile(wsFile, JSON.stringify(ws, null, 2) + "\n", "utf8");
}

export async function upsertSet(root: string, branch: string, base: string | undefined, entries: SetRepo[]): Promise<WorktreeSet> {
  const folder = setFolder(root, branch);
  const now = new Date().toISOString();
  const existing = await readSet(folder);
  const set: WorktreeSet = existing ?? {
    schemaVersion: 1,
    branch,
    slug: branchSlug(branch),
    createdAt: now,
    updatedAt: now,
    repos: [],
    folder,
  };
  const byName = new Map(set.repos.map((r) => [r.name, r]));
  for (const e of entries) byName.set(e.name, e);
  set.repos = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (base && !set.base) set.base = base;
  set.updatedAt = now;
  await writeSet(set);
  return set;
}

export async function listSets(root: string): Promise<WorktreeSet[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const sets: WorktreeSet[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const s = await readSet(path.join(root, e.name));
    if (s) sets.push(s);
  }
  sets.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return sets;
}

/** Comparable path: junctions, symlinks and redirected folders resolved (via the nearest existing ancestor). */
function norm(p: string): string {
  let head = path.resolve(p);
  const tail: string[] = [];
  let r = head;
  for (;;) {
    try {
      r = path.join(fs.realpathSync.native(head), ...tail);
      break;
    } catch {
      const parent = path.dirname(head);
      if (parent === head) {
        r = path.resolve(p);
        break;
      }
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
  return process.platform === "win32" ? r.toLowerCase() : r;
}

export async function findSetContaining(root: string, anyPath: string): Promise<WorktreeSet | undefined> {
  const target = norm(anyPath);
  for (const s of await listSets(root)) {
    const rel = path.relative(norm(s.folder), target);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return s;
  }
  return undefined;
}

// ---------------------------------------------------------------- status

export interface RepoStatus {
  name: string;
  path: string;
  exists: boolean;
  currentBranch?: string;
  dirty: number;
  ahead?: number;
  behind?: number;
  upstream?: string;
  remoteBranch: boolean;
  unpushed?: number;
}

/** `git status --porcelain=v2 --branch`: branch, upstream, ahead/behind and the number of changed paths. */
export function parseStatusV2(out: string): Pick<RepoStatus, "currentBranch" | "upstream" | "ahead" | "behind" | "dirty"> {
  const r: Pick<RepoStatus, "currentBranch" | "upstream" | "ahead" | "behind" | "dirty"> = { dirty: 0 };
  for (const l of out.split(/\r?\n/)) {
    if (!l) continue;
    if (l.startsWith("# branch.head ")) r.currentBranch = l.slice(14).trim() === "(detached)" ? "HEAD" : l.slice(14).trim();
    else if (l.startsWith("# branch.upstream ")) r.upstream = l.slice(18).trim();
    else if (l.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(l);
      if (m) (r.ahead = Number(m[1])), (r.behind = Number(m[2]));
    } else if (!l.startsWith("#")) r.dirty++;
  }
  return r;
}

/** The git common dir of a checkout or linked worktree, read from `.git` (no process). */
export async function commonDirOf(dir: string): Promise<string | undefined> {
  const dotgit = path.join(dir, ".git");
  const st = await fs.promises.stat(dotgit).catch(() => undefined);
  if (!st) return undefined;
  if (st.isDirectory()) return dotgit;
  const m = /^gitdir:\s*(.+)$/m.exec(await fs.promises.readFile(dotgit, "utf8").catch(() => ""));
  if (!m) return undefined;
  const gitdir = path.resolve(dir, m[1].trim());
  const common = (await fs.promises.readFile(path.join(gitdir, "commondir"), "utf8").catch(() => "")).trim();
  return common ? path.resolve(gitdir, common) : gitdir;
}

/**
 * Changes when git changes something in the checkout: the index, HEAD, the reflog, the remote refs. A cached status
 * stays valid while this is the same (fs.stat only, no process).
 */
export async function statusSignature(dir: string, remote: string): Promise<string> {
  const dotgit = path.join(dir, ".git");
  const st = await fs.promises.stat(dotgit).catch(() => undefined);
  if (!st) return "missing";
  let gitdir = dotgit;
  if (!st.isDirectory()) {
    const m = /^gitdir:\s*(.+)$/m.exec(await fs.promises.readFile(dotgit, "utf8").catch(() => ""));
    if (m) gitdir = path.resolve(dir, m[1].trim());
  }
  const common = (await commonDirOf(dir)) ?? gitdir;
  const files = [path.join(gitdir, "index"), path.join(gitdir, "HEAD"), path.join(gitdir, "logs", "HEAD"), path.join(common, "packed-refs"), path.join(common, "refs", "remotes", remote)];
  const times = await Promise.all(files.map((f) => fs.promises.stat(f).then((s) => String(s.mtimeMs), () => "-")));
  return times.join("|");
}

/** Whether a ref exists, from the loose ref file or packed-refs (what `show-ref --verify` answers, without a process). */
export async function hasRemoteRef(dir: string, ref: string): Promise<boolean> {
  const common = await commonDirOf(dir);
  if (!common) return false;
  if (await pathExists(path.join(common, ...ref.split("/")))) return true;
  const packed = await fs.promises.readFile(path.join(common, "packed-refs"), "utf8").catch(() => "");
  return packed.split(/\r?\n/).some((l) => l.endsWith(` ${ref}`));
}

export async function repoStatus(git: Git, remote: string, set: WorktreeSet, repo: SetRepo): Promise<RepoStatus> {
  const status: RepoStatus = { name: repo.name, path: repo.path, exists: false, dirty: 0, remoteBranch: false };
  if (!(await pathExists(repo.path))) return status;
  status.exists = true;

  // one process for branch, upstream, ahead/behind and changes (it was four: rev-parse, status, rev-parse @{u}, rev-list)
  const s = await git(["status", "--porcelain=v2", "--branch"], repo.path);
  if (s.code === 0) Object.assign(status, parseStatusV2(s.stdout));
  // the remote branch from the files in .git, not with show-ref
  status.remoteBranch = await hasRemoteRef(repo.path, `refs/remotes/${remote}/${repo.branch ?? set.branch}`);

  if (status.upstream) {
    status.unpushed = status.ahead;
  } else {
    const base = repo.base ?? set.base;
    if (base) {
      const c = await git(["rev-list", "--count", `${remote}/${base}..HEAD`], repo.path);
      if (c.code === 0) {
        const n = parseInt(c.stdout.trim(), 10);
        if (Number.isFinite(n)) status.unpushed = n;
      }
    }
  }
  return status;
}

// ---------------------------------------------------------------- remove

export async function removeRepoFromSet(
  git: Git,
  set: WorktreeSet,
  repoName: string,
  force: boolean,
): Promise<RemoveResult & { set: WorktreeSet }> {
  const repo = set.repos.find((r) => r.name === repoName);
  if (!repo) {
    return { ok: false, dirty: false, message: `${repoName} is not part of this set.`, set };
  }

  let result: RemoveResult;
  if (!(await pathExists(repo.path))) {
    await git(["worktree", "prune"], repo.source).catch(() => undefined);
    result = { ok: true, dirty: false, message: `Worktree folder was already gone: ${repo.path}` };
  } else {
    result = await removeWorktree(git, repo.source, repo.path, force);
    if (!result.ok && !result.dirty && !(await isRegisteredWorktree(git, repo.source, repo.path))) {
      // git already unregistered it but could not delete the folder (on Windows: a terminal, editor or watcher
      // still uses it). Finish the cleanup, but only delete what is left when it holds no files at all.
      await git(["worktree", "prune"], repo.source).catch(() => undefined);
      const files = await countFiles(repo.path);
      if (files === 0) {
        await fs.promises.rm(repo.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => undefined);
      }
      result = (await pathExists(repo.path))
        ? {
            ok: true,
            dirty: false,
            message: `Removed from git, but the folder was left behind${files ? ` (${files} files)` : ""} because a program still uses it: ${repo.path}`,
            nextStep: "Close terminals, editors or programs that use that folder, then delete it.",
          }
        : { ok: true, dirty: false, message: `Removed ${repo.path} (finished after git could not delete the folder)` };
    }
  }
  if (!result.ok) return { ...result, set };

  const updated: WorktreeSet = {
    ...set,
    repos: set.repos.filter((r) => r.name !== repoName),
    updatedAt: new Date().toISOString(),
  };
  await writeSet(updated);
  return { ...result, set: updated };
}

async function isRegisteredWorktree(git: Git, source: string, worktree: string): Promise<boolean> {
  const key = norm(worktree);
  return (await listWorktrees(git, source)).some((w) => !w.main && norm(w.path) === key);
}

/** Number of files below a folder (directories not counted); 0 for a missing folder. */
async function countFiles(folder: string): Promise<number> {
  let n = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(folder, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) n += e.isDirectory() ? await countFiles(path.join(folder, e.name)) : 1;
  return n;
}

/** Deletes subfolders of the set that are no member any more and hold no files (left behind when Windows kept them in use). */
export async function pruneEmptyLeftovers(set: WorktreeSet): Promise<string[]> {
  const members = new Set(set.repos.map((r) => norm(r.path)));
  const removed: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(set.folder, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(set.folder, e.name);
    if (members.has(norm(dir)) || (await countFiles(dir)) > 0) continue;
    try {
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      removed.push(e.name);
    } catch {
      // still in use: try again next time
    }
  }
  return removed;
}

export async function deleteSetFolderIfEmpty(set: WorktreeSet): Promise<boolean> {
  await pruneEmptyLeftovers(set);
  if (set.repos.length > 0) return !(await pathExists(set.folder));
  await fs.promises.rm(path.join(set.folder, SET_FILE), { force: true });
  await fs.promises.rm(setWorkspaceFile(set), { force: true });
  try {
    await fs.promises.rmdir(set.folder);
  } catch {
    // not empty or already gone
  }
  return !(await pathExists(set.folder));
}
