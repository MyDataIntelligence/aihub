import * as fs from "fs";
import * as path from "path";
import type { Git, GitResult } from "./git";

export interface Repo {
  name: string;
  path: string;
  root: string;
}

// ---------------------------------------------------------------- repos

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function hasGitDir(folder: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(path.join(folder, ".git"))).isDirectory();
  } catch {
    return false;
  }
}

export async function findRepos(roots: string[], depth: number): Promise<Repo[]> {
  const seen = new Set<string>();
  const result: Repo[] = [];

  for (const root of roots) {
    if (!root || !(await isDir(root))) continue;
    const found: Repo[] = [];

    const visit = async (folder: string, level: number): Promise<void> => {
      if (await hasGitDir(folder)) {
        const key = path.resolve(folder).toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          const rel = path.relative(root, folder).split(path.sep).join("/");
          found.push({ name: rel || path.basename(path.resolve(root)), path: folder, root });
        }
        return;
      }
      if (level >= depth) return;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(folder, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name === "node_modules" || e.name.startsWith(".") || e.name.endsWith("-worktrees")) continue;
        await visit(path.join(folder, e.name), level + 1);
      }
    };

    await visit(root, 0);
    found.sort((a, b) => a.name.localeCompare(b.name));
    result.push(...found);
  }
  return result;
}

// ---------------------------------------------------------------- names and paths

export function branchSlug(branch: string): string {
  return branch
    .trim()
    .replace(/[\/\\<>:"|?*\s]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

export async function validateBranchName(git: Git, branch: string, cwd: string): Promise<string | undefined> {
  if (!branch || !branch.trim()) return "Enter a branch name.";
  const r = await git(["check-ref-format", "--branch", branch], cwd);
  if (r.code === 0) return undefined;
  if (r.spawnError) return classifyGitError(r).message;
  return "Branch names cannot contain spaces, '..', '~', '^', ':', '?', '*', '[' or end with '.lock'. Example: feature/123-my-change";
}

export function worktreePath(repo: Repo, branch: string, worktreeRoot: string): string {
  const slug = branchSlug(branch);
  if (!worktreeRoot) {
    return path.join(path.dirname(repo.path), path.basename(repo.path) + "-worktrees", slug);
  }
  return path.join(worktreeRoot, slug, repo.name.split("/").join("-"));
}

export function workspaceFilePath(repos: Repo[], branch: string, worktreeRoot: string, workspaceFolder: string): string {
  const slug = branchSlug(branch);
  const folder = workspaceFolder
    ? workspaceFolder
    : worktreeRoot
      ? path.join(worktreeRoot, slug)
      : path.join(path.dirname(repos[0].path), "worktree-workspaces");
  return path.join(folder, `${slug}.code-workspace`);
}

export function workspaceFileContent(folders: { name: string; path: string }[]): string {
  return (
    JSON.stringify({ folders: folders.map((f) => ({ name: f.name, path: path.resolve(f.path) })), settings: {} }, null, 2) +
    "\n"
  );
}

export async function writeWorkspaceFile(file: string, folders: { name: string; path: string }[]): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, workspaceFileContent(folders), "utf8");
}

// ---------------------------------------------------------------- errors

export function classifyGitError(r: GitResult | string): { message: string; nextStep: string } {
  if (typeof r !== "string" && r.spawnError) {
    if (r.spawnError === "ENOENT") {
      return {
        message: "Git was not found.",
        nextStep:
          "Install Git for Windows (https://git-scm.com) or set worktreeMaker.gitPath to git.exe, then reload the window.",
      };
    }
    return {
      message: `Git could not be started (${r.spawnError}).`,
      nextStep: "Check worktreeMaker.gitPath and that git can run, then reload the window.",
    };
  }
  const stderr = typeof r === "string" ? r : r.stderr;
  const code = typeof r === "string" ? undefined : r.code;
  const first = stderr.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const has = (re: RegExp) => re.test(stderr);

  if (has(/couldn't find remote ref/i)) {
    return { message: `The base branch does not exist on the remote: ${first}`, nextStep: "Choose another base branch." };
  }
  if (has(/Authentication failed|terminal prompts disabled|\b403\b|could not read Username/i)) {
    return {
      message: first || "Authentication failed.",
      nextStep:
        "Sign in once from a terminal (git fetch in that repo) so Git Credential Manager stores your login, then try again.",
    };
  }
  if (
    has(
      /Could not resolve host|unable to access|Failed to connect|Connection timed out|timed out|proxy|SSL|schannel|Could not read from remote repository/i,
    )
  ) {
    return {
      message: first || "Network error.",
      nextStep:
        "Check the network or VPN. Behind a proxy, set it for git: git config --global http.proxy http://<proxy>:<port>",
    };
  }
  if (has(/is not a valid branch name|not a valid branch name/i)) {
    return {
      message: first || "Invalid branch name.",
      nextStep: "Use a valid branch name without spaces or special characters, for example feature/123-my-change.",
    };
  }
  if (has(/already exists/i)) {
    return {
      message: first,
      nextStep: "Use another branch name, or remove the existing branch or folder first.",
    };
  }
  return {
    message: first || `git exited with code ${code ?? "?"}`,
    nextStep: "See Worktree Maker: Show Log for the full git output.",
  };
}

// ---------------------------------------------------------------- refs and bases

async function refExists(git: Git, repoPath: string, ref: string): Promise<boolean> {
  const r = await git(["show-ref", "--verify", "--quiet", ref], repoPath);
  return r.code === 0;
}

export async function availableBases(git: Git, repoPath: string, remote: string, bases: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const b of bases) {
    if ((await refExists(git, repoPath, `refs/remotes/${remote}/${b}`)) || (await refExists(git, repoPath, `refs/heads/${b}`))) {
      out.push(b);
    }
  }
  return out;
}

// ---------------------------------------------------------------- worktrees

export interface WorktreeInfo {
  path: string;
  head?: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  main: boolean;
}

export async function listWorktrees(git: Git, repoPath: string): Promise<WorktreeInfo[]> {
  const r = await git(["worktree", "list", "--porcelain"], repoPath);
  if (r.code !== 0) return [];
  const result: WorktreeInfo[] = [];
  let cur: WorktreeInfo | undefined;
  const flush = () => {
    if (cur) result.push(cur);
    cur = undefined;
  };
  for (const raw of r.stdout.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      cur = {
        path: path.normalize(line.slice("worktree ".length)),
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
        main: result.length === 0,
      };
    } else if (cur) {
      if (line.startsWith("HEAD ")) cur.head = line.slice(5);
      else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
      else if (line === "bare") cur.bare = true;
      else if (line === "detached") cur.detached = true;
      else if (line === "locked" || line.startsWith("locked ")) cur.locked = true;
      else if (line === "prunable" || line.startsWith("prunable ")) cur.prunable = true;
    }
  }
  flush();
  return result;
}

export interface BranchWorktree {
  repo: Repo;
  worktree: WorktreeInfo;
}

export async function findWorktreesForBranch(git: Git, repos: Repo[], branch?: string): Promise<BranchWorktree[]> {
  const out: BranchWorktree[] = [];
  for (const repo of repos) {
    for (const wt of await listWorktrees(git, repo.path)) {
      if (wt.main) continue;
      if (branch === undefined || wt.branch === branch) out.push({ repo, worktree: wt });
    }
  }
  return out;
}

export interface RemoveResult {
  ok: boolean;
  dirty: boolean;
  message: string;
  nextStep?: string;
}

export async function removeWorktree(git: Git, repoPath: string, worktreePathArg: string, force: boolean): Promise<RemoveResult> {
  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(worktreePathArg);
  const r = await git(args, repoPath);
  let result: RemoveResult;
  if (r.code === 0) {
    result = { ok: true, dirty: false, message: `Removed ${worktreePathArg}` };
  } else if (/contains modified or untracked files|use --force/i.test(r.stderr)) {
    result = {
      ok: false,
      dirty: true,
      message: "The worktree has uncommitted or untracked changes.",
      nextStep: "Commit or stash them first, or confirm removal with force (changes are lost).",
    };
  } else {
    const c = classifyGitError(r);
    result = { ok: false, dirty: false, message: c.message, nextStep: c.nextStep };
  }
  await git(["worktree", "prune"], repoPath).catch(() => undefined);
  return result;
}

// ---------------------------------------------------------------- create

export type Status = "ok" | "skipped" | "error";

export interface Outcome {
  repo: Repo;
  status: Status;
  path: string;
  message: string;
  nextStep?: string;
  branchSource?: "new" | "local" | "remote" | "reused";
  /** Extra lines for the result, e.g. "Stale worktree registration removed: <path>". */
  notes?: string[];
  /** Set when an existing folder could not be deleted: what probably holds it, so the UI can offer a retry. */
  blocked?: RemoveBlock;
}

export type BlockReason = "in-use" | "long-path" | "other";
export interface RemoveBlock {
  path: string;
  reason: BlockReason;
}

/** Windows paths at or above this length need core.longpaths (MAX_PATH is 260 including the file name). */
export const LONG_PATH = 240;

/** Why deleting a worktree folder failed, with the next step for the user. */
export function classifyRemoveFailure(stderr: string, folder: string): { reason: BlockReason; message: string; nextStep: string } {
  const first = stderr.split(/\r?\n/).map((l) => l.trim()).find((l) => l) ?? "the folder could not be deleted";
  if (/filename too long|path too long|name too long/i.test(stderr) || folder.length >= LONG_PATH) {
    return {
      reason: "long-path",
      message: `${folder} could not be deleted: the path is too long for Windows (${folder.length} characters). ${first}`,
      nextStep: "Enable long paths for git (git config --global core.longpaths true), or use a shorter worktree root, then retry.",
    };
  }
  if (/permission denied|being used by another process|resource busy|directory not empty|failed to delete|access is denied|EBUSY|EPERM/i.test(stderr)) {
    return {
      reason: "in-use",
      message: `${folder} is in use and could not be deleted. ${first}`,
      nextStep: "Close the VS Code window, terminals and other programs that have this folder open, then retry.",
    };
  }
  return { reason: "other", message: `${folder} could not be deleted. ${first}`, nextStep: "See Worktree Maker: Show Log for the full git output, then retry." };
}

/** The worktree (not the main checkout) that has this branch checked out, wherever it is. */
export async function findBranchWorktree(git: Git, repoPath: string, branch: string): Promise<WorktreeInfo | undefined> {
  return (await listWorktrees(git, repoPath)).find((w) => !w.main && w.branch === branch);
}

/** git worktree move from -> to (the parent of "to" is created). Fails cleanly when "to" exists or the folder is in use. */
export async function moveWorktree(git: Git, repoPath: string, from: string, to: string): Promise<{ ok: boolean; message: string; nextStep?: string; blocked?: RemoveBlock }> {
  if (await exists(to)) return { ok: false, message: `${to} already exists; nothing was moved.`, nextStep: "Choose Reuse or Remove and recreate instead." };
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  const r = await git(["worktree", "move", from, to], repoPath);
  if (r.code === 0) return { ok: true, message: `Moved ${from} to ${to}` };
  const c = classifyRemoveFailure(r.stderr, from);
  return { ok: false, message: `Could not move the worktree: ${c.message}`, nextStep: c.nextStep, blocked: { path: from, reason: c.reason } };
}

/**
 * Deletes a worktree with git worktree remove --force; when git unregistered it but could not delete the folder, the
 * leftover is deleted directly. Returns undefined when it is gone, else why not.
 */
export async function forceRemoveWorktree(git: Git, repoPath: string, folder: string): Promise<{ message: string; nextStep: string; blocked: RemoveBlock } | undefined> {
  const r = await git(["worktree", "remove", "--force", folder], repoPath);
  await git(["worktree", "prune"], repoPath);
  if (!(await exists(folder))) return undefined;
  const registered = (await listWorktrees(git, repoPath)).some((w) => !w.main && pathKey(w.path) === pathKey(folder));
  let detail = r.stderr;
  if (!registered) {
    try {
      await fs.promises.rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      if (!(await exists(folder))) return undefined;
    } catch (e) {
      detail = `${detail}\n${(e as NodeJS.ErrnoException).code ?? ""} ${(e as Error).message}`;
    }
  }
  const c = classifyRemoveFailure(detail, folder);
  return { message: c.message, nextStep: c.nextStep, blocked: { path: folder, reason: c.reason } };
}

/** What to do when the target folder already exists. */
export type OnExisting = "skip" | "reuse" | "overwrite";
/** What to do when "new branch" was chosen but the branch already exists (locally or on the remote). */
export type OnBranchExists = "use" | "overwrite";

export interface CreateOptions {
  branch: string;
  base: string;
  remote: string;
  worktreeRoot: string;
  /** Only use a branch that already exists (locally or on the remote); never create a new one. */
  existingOnly?: boolean;
  /** Default "skip". "overwrite" deletes the folder (git worktree remove --force for a worktree): ask first. */
  onExisting?: OnExisting;
  /** Default "use". "overwrite" deletes the local branch and starts it again from the base: ask first. */
  onBranchExists?: OnBranchExists;
  /**
   * Create this new branch from the tip of `branch` (local, else <remote>/<branch>) and check it out in the set folder
   * of `branch`. The existing branch is left as it is, so its pull request and story stay on it.
   */
  forkAs?: string;
}

/** A free name for a branch made from `branch`: <branch>-2, -3, ... that exists neither locally nor on the remote. */
export async function suggestForkName(git: Git, repoPaths: string[], branch: string, remote: string): Promise<string> {
  for (let n = 2; n < 100; n++) {
    const name = `${branch}-${n}`;
    let used = false;
    for (const p of repoPaths) {
      if ((await refExists(git, p, `refs/heads/${name}`)) || (await refExists(git, p, `refs/remotes/${remote}/${name}`))) used = true;
    }
    if (!used) return name;
  }
  return `${branch}-${Date.now()}`;
}

/** Comparable path: junctions, symlinks and redirected folders resolved via the nearest existing ancestor. */
export function pathKey(p: string): string {
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

async function countFiles(folder: string): Promise<number> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(folder, { withFileTypes: true });
  } catch {
    return 0;
  }
  let n = 0;
  for (const e of entries) n += e.isDirectory() ? await countFiles(path.join(folder, e.name)) : 1;
  return n;
}

async function countLines(git: Git, cwd: string, args: string[]): Promise<number | undefined> {
  const r = await git(args, cwd);
  if (r.code !== 0) return undefined;
  return r.stdout.split(/\r?\n/).filter((l) => l.trim()).length;
}

async function countRevs(git: Git, cwd: string, range: string): Promise<number | undefined> {
  const r = await git(["rev-list", "--count", range], cwd);
  if (r.code !== 0) return undefined;
  const n = parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Removes registrations of worktrees whose folder is gone (deleted by hand) or empty, so git no longer thinks their
 * branch is checked out there. Never touches a worktree that still has files. Returns the cleared paths.
 */
export async function pruneStaleWorktrees(git: Git, repoPath: string): Promise<string[]> {
  const stale: string[] = [];
  for (const w of await listWorktrees(git, repoPath)) {
    if (w.main) continue;
    if (w.prunable || !(await exists(w.path))) stale.push(w.path);
    else if ((await isDir(w.path)) && (await countFiles(w.path)) === 0) {
      // An empty folder (the files were deleted, e.g. by hand): git cannot use it as a worktree any more.
      await fs.promises.rm(w.path, { recursive: true, force: true }).catch(() => undefined);
      if (!(await exists(w.path))) stale.push(w.path);
    }
  }
  if (stale.length) await git(["worktree", "prune"], repoPath);
  const still = new Set((await listWorktrees(git, repoPath)).map((w) => pathKey(w.path)));
  return stale.filter((p) => !still.has(pathKey(p)));
}

export type TargetState =
  | { kind: "free" }
  | { kind: "worktree"; branch?: string; dirty: number; unpushed?: number }
  | { kind: "folder"; files: number };

/** What is at the target path of a new worktree (after stale registrations were pruned). No network. */
export async function inspectTarget(git: Git, repo: Repo, target: string, remote: string, base?: string): Promise<TargetState> {
  const key = pathKey(target);
  const wt = (await listWorktrees(git, repo.path)).find((w) => !w.main && pathKey(w.path) === key);
  if (wt && (await exists(target))) {
    const dirty = (await countLines(git, target, ["status", "--porcelain"])) ?? 0;
    let unpushed = await countRevs(git, target, "@{u}..HEAD");
    if (unpushed === undefined && base) unpushed = await countRevs(git, target, `${remote}/${base}..HEAD`);
    return { kind: "worktree", branch: wt.branch, dirty, unpushed };
  }
  if (await exists(target)) return { kind: "folder", files: await countFiles(target) };
  return { kind: "free" };
}

export interface BranchState {
  local: boolean;
  remote: boolean;
  /** A worktree (or the main checkout) that has the branch checked out. */
  checkedOutAt?: string;
  /** Commits on the local branch that are not on the remote branch (or, when never pushed, not on the base). */
  unpushed?: number;
}

/** The state of a branch name in a repo, for the "new branch, but it already exists" question. No network. */
export async function inspectBranch(git: Git, repo: Repo, branch: string, remote: string, base: string): Promise<BranchState> {
  const local = await refExists(git, repo.path, `refs/heads/${branch}`);
  const remoteRef = await refExists(git, repo.path, `refs/remotes/${remote}/${branch}`);
  const used = (await listWorktrees(git, repo.path)).find((w) => w.branch === branch);
  let unpushed: number | undefined;
  if (local) unpushed = await countRevs(git, repo.path, remoteRef ? `${remote}/${branch}..${branch}` : `${remote}/${base}..${branch}`);
  return { local, remote: remoteRef, checkedOutAt: used?.path, unpushed };
}

export async function createWorktree(git: Git, repo: Repo, opts: CreateOptions): Promise<Outcome> {
  const { branch, base, remote } = opts;
  const target = worktreePath(repo, branch, opts.worktreeRoot);
  const notes: string[] = [];
  const done = (o: Omit<Outcome, "repo" | "path" | "notes">): Outcome => ({ repo, path: target, ...o, ...(notes.length ? { notes } : {}) });
  const fail = (r: GitResult | string, prefix = ""): Outcome => {
    const c = classifyGitError(r);
    return done({ status: "error", message: prefix + c.message, nextStep: c.nextStep });
  };

  // 1. Registrations of worktrees that were deleted by hand: clear them first, or git keeps saying the branch is
  //    checked out there (the "already exists in folder X" the user saw after deleting the folder).
  for (const p of await pruneStaleWorktrees(git, repo.path)) notes.push(`Stale worktree registration removed: ${p}`);

  // 2. Something at the target path.
  const state = await inspectTarget(git, repo, target, remote, base || undefined);
  const onExisting = opts.onExisting ?? "skip";
  if (state.kind === "folder" && state.files === 0) {
    await fs.promises.rm(target, { recursive: true, force: true }).catch(() => undefined);
  } else if (state.kind === "worktree") {
    if (onExisting === "reuse") {
      if (state.branch === branch) {
        return done({ status: "ok", message: `Existing worktree reused (branch ${branch})`, branchSource: "reused" });
      }
      return done({
        status: "skipped",
        message: `The existing worktree at ${target} is on ${state.branch ? `branch ${state.branch}` : "a detached HEAD"}, not ${branch}; not reused.`,
        nextStep: "Choose Overwrite to recreate it, or Skip.",
      });
    }
    if (onExisting === "overwrite") {
      const blocked = await forceRemoveWorktree(git, repo.path, target);
      if (blocked) return done({ status: "error", message: `Could not remove the existing worktree: ${blocked.message}`, nextStep: blocked.nextStep, blocked: blocked.blocked });
      notes.push(`Existing worktree replaced${state.dirty ? ` (${state.dirty} uncommitted changes discarded)` : ""}`);
    } else {
      return done({
        status: "skipped",
        message: `A worktree already exists at ${target}${state.branch ? ` (branch ${state.branch})` : ""}.`,
        nextStep: "Choose Reuse or Overwrite when asked, or remove it with Worktree Maker: Remove Set.",
      });
    }
  } else if (state.kind === "folder") {
    if (onExisting === "overwrite") {
      try {
        await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      } catch (e) {
        const c = classifyRemoveFailure(`${(e as NodeJS.ErrnoException).code ?? ""} ${(e as Error).message}`, target);
        return done({ status: "error", message: `Could not delete the existing folder: ${c.message}`, nextStep: c.nextStep, blocked: { path: target, reason: c.reason } });
      }
      notes.push(`Existing folder replaced (${state.files} files deleted)`);
    } else {
      return done({
        status: "skipped",
        message: `Target folder already exists and is not a worktree of this repository: ${target}`,
        nextStep: onExisting === "reuse" ? "It cannot be reused. Choose Overwrite, or remove or rename that folder." : "Remove or rename that folder, choose Overwrite, or use another branch name.",
      });
    }
  }

  if (!(opts.existingOnly && base === "")) {
    const fetch = await git(["fetch", remote, base], repo.path);
    if (fetch.code !== 0) return fail(fetch, `Fetching ${remote}/${base} failed: `);
  }

  const add = async (args: string[], source: "new" | "local" | "remote", message: string): Promise<Outcome> => {
    try {
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
    } catch (e) {
      return done({ status: "error", message: `Cannot create folder: ${(e as Error).message}`, nextStep: "Check the worktree root setting and folder permissions." });
    }
    const r = await git(["worktree", "add", ...args], repo.path);
    if (r.code !== 0) return fail(r);
    return done({ status: "ok", message, branchSource: source });
  };
  const fromBase = (message = `New branch ${branch} from ${remote}/${base}`) =>
    add(["--no-track", "-b", branch, target, `${remote}/${base}`], "new", message);
  const overwriteBranch = !opts.existingOnly && opts.onBranchExists === "overwrite";

  if (opts.forkAs) {
    const fork = opts.forkAs;
    if ((await refExists(git, repo.path, `refs/heads/${fork}`)) || (await refExists(git, repo.path, `refs/remotes/${remote}/${fork}`))) {
      return done({ status: "error", message: `Branch ${fork} already exists in this repository.`, nextStep: "Choose another name for the new branch." });
    }
    await git(["fetch", remote, branch], repo.path);
    const from = (await refExists(git, repo.path, `refs/heads/${branch}`)) ? branch : (await refExists(git, repo.path, `refs/remotes/${remote}/${branch}`)) ? `${remote}/${branch}` : "";
    if (!from) return done({ status: "error", message: `Branch ${branch} does not exist here, so nothing to branch from.`, nextStep: "Create it as a new branch from a base instead." });
    notes.push(`${branch} is left as it is; its pull request and story stay on ${branch}`);
    return add(["--no-track", "-b", fork, target, from], "new", `New branch ${fork} from the tip of ${from}`);
  }

  if (await refExists(git, repo.path, `refs/heads/${branch}`)) {
    const used = (await listWorktrees(git, repo.path)).find((w) => w.branch === branch);
    if (used) {
      return done({
        status: "skipped",
        message: `Branch ${branch} is already checked out in ${used.path}`,
        nextStep: used.main ? "Switch that checkout to another branch first." : "Open that folder, or remove that worktree first.",
      });
    }
    if (overwriteBranch) {
      const del = await git(["branch", "-D", branch], repo.path);
      if (del.code !== 0) return fail(del, `Could not delete the old branch ${branch}: `);
      notes.push(`Old local branch ${branch} deleted and started again from ${remote}/${base}`);
      return fromBase();
    }
    return add([target, branch], "local", `Existing local branch ${branch} used (not reset to ${base})`);
  }

  // A branch someone else already pushed: fetch it too (best effort; "couldn't find remote ref" just means it is new).
  await git(["fetch", remote, branch], repo.path);

  if (await refExists(git, repo.path, `refs/remotes/${remote}/${branch}`)) {
    if (overwriteBranch) {
      notes.push(`${remote}/${branch} exists and was left as it is; a later push of this new branch is refused unless you force it.`);
      return fromBase();
    }
    return add(["--track", "-b", branch, target, `${remote}/${branch}`], "remote", `Existing remote branch ${remote}/${branch} checked out`);
  }

  if (opts.existingOnly) {
    return done({
      status: "skipped",
      message: `Branch ${branch} does not exist in this repository.`,
      nextStep: "Create it as a new branch from a base, or deselect this repository.",
    });
  }

  return fromBase();
}
