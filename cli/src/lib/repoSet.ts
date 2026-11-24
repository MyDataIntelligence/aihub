import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawn } from "./proc.js";
import { ensureBranch } from "./branches.js";
import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { originDefaultBranch, repoRoot } from "./git.js";
import { hasTrackedChanges, listWorktrees, mustGit, refSha, samePath, tryGit } from "./gitx.js";
import { findGroup, groupDirs, resolveRepos } from "./repoGroups.js";
import { fetchOrigin, type RepoDir } from "./repos.js";
import { defaultTargetFor, loadTeam, type TeamConfig } from "./team.js";
import { findSet } from "./setInfo.js";
import { linkBranch, currentOf, storyFolderFor, storyIdFromBranch, storyWorktreesFileFor, updateStoryWorktrees, variantOf, worktreePathFor } from "./storyWorktrees.js";
import { defaultSetsRoot, slugOfBranch, writeSetMeta, type SetMeta } from "./worktree.js";

/**
 * `aihub worktree open`: several repositories on the SAME branch at once, in one VS Code window.
 * Per repository: the branch exists (local or origin) -> use it; else create it from --from or the team.yaml target.
 * Mode worktree (default) leaves the normal checkout alone; mode switch switches the checkout (never over uncommitted work).
 */
export type OpenMode = "worktree" | "switch";
export type OpenWindow = "new" | "this" | "none";

export interface OpenSetOpts {
  group?: string;
  repos?: string[];
  branch: string;
  /** per repository another branch than `branch` (`aihub story open`: the star of each repository) */
  branches?: Record<string, string>;
  /** the story the set belongs to; else the id in the branch name */
  storyId?: number;
  from?: string;
  mode?: OpenMode;
  window?: OpenWindow;
  root?: string;
  json?: boolean;
}

export type RepoState = "existing" | "created" | "reused-worktree" | "switched" | "already-on" | "skipped" | "failed";

export interface RepoResult {
  repo: string;
  ok: boolean;
  state: RepoState;
  branch: string;
  /** the folder the window opens for this repository */
  path?: string;
  /** what happened, one short line */
  note: string;
  from?: string;
}

export interface OpenSetResult {
  story?: number;
  group?: string;
  branch: string;
  mode: OpenMode;
  folder: string;
  workspace?: string;
  repos: RepoResult[];
  opened: boolean;
}

export const slug = slugOfBranch;

const hasBranch = (dir: string, b: string) => !!refSha(dir, `refs/heads/${b}`) || !!refSha(dir, `refs/remotes/origin/${b}`);

/** --from, else the repository's own team.yaml target, else the one of the repository you run this in, else origin's default branch. */
function baseOf(dir: string, name: string, from: string | undefined, team: TeamConfig): string {
  return from ?? defaultTargetFor(loadTeam(dir), name) ?? defaultTargetFor(team, name) ?? (originDefaultBranch(dir) || undefined) ?? "main";
}

/** One repository on the branch. Never throws: a failure is one row, the others continue. */
export function openRepo(r: RepoDir, o: { branch: string; from?: string; mode: OpenMode; folder: string; team: TeamConfig; path?: (dir: RepoDir) => string }): RepoResult {
  const out = (state: RepoState, ok: boolean, note: string, extra: Partial<RepoResult> = {}): RepoResult => ({ repo: r.name, ok, state, branch: o.branch, note, ...extra });
  try {
    fetchOrigin(r.dir);
    let created = false;
    let from = "";
    if (!hasBranch(r.dir, o.branch)) {
      const base = baseOf(r.dir, r.name, o.from, o.team);
      const e = ensureBranch(r.dir, o.branch, base, false);
      created = e.created;
      from = e.from;
    }
    const where = listWorktrees(r.dir).find((w) => w.branch === o.branch);
    const made = created ? `created from ${from} (local; pushed with your first push)` : "existing branch";
    if (o.mode === "switch") {
      if (where && samePath(where.path, r.dir)) return out("already-on", true, "already on the branch", { path: r.dir });
      if (where) return out("failed", false, `branch is checked out in ${where.path}; use mode worktree or switch that one first`);
      if (hasTrackedChanges(r.dir)) return out("skipped", false, "uncommitted changes; commit or stash them, nothing was changed");
      mustGit(r.dir, ["switch", o.branch]);
      return out("switched", true, `switched (${made})`, { path: r.dir, from: from || undefined });
    }
    // mode worktree: one worktree per repository inside the set folder (a story folder: <repo> or <repo>--<variant>)
    const path = o.path ? o.path(r) : join(o.folder, r.name);
    if (where) {
      const inSet = samePath(where.path, path);
      return out("reused-worktree", true, inSet ? "worktree of this set reused" : `branch already checked out in ${where.path}; that folder is opened`, { path: where.path });
    }
    if (existsSync(path)) return out("failed", false, `${path} exists and is not a worktree on this branch`);
    mkdirSync(dirname(path), { recursive: true });
    mustGit(r.dir, ["worktree", "add", path, o.branch]);
    return out(created ? "created" : "existing", true, `worktree, ${made}`, { path, from: from || undefined });
  } catch (e) {
    return out("failed", false, (e as Error).message.split("\n")[0]);
  }
}

const norm = (p: string) => p.replace(/\\/g, "/");

/** The folder that holds all of them (the set folder for worktrees, the clones' parent for switch), else the set folder. */
function commonRoot(folder: string, paths: string[]): string {
  if (paths.every((p) => samePath(dirname(p), folder))) return folder;
  const parents = [...new Set(paths.map((p) => resolve(dirname(p))))];
  return parents.length === 1 ? parents[0] : folder;
}

/** What the window is, for the status bar (also for switched checkouts, which have no set file). */
export interface WindowSet {
  story?: number;
  group?: string;
  branch: string;
  mode: OpenMode;
  repos: { name: string; branch: string }[];
}

export function workspaceJson(folder: string, repos: RepoResult[], set?: Omit<WindowSet, "repos">): string {
  const ok = repos.filter((r) => r.ok && r.path);
  const folders = ok.map((r) => {
    const rel = relative(folder, r.path!);
    return { name: r.repo, path: norm(rel && !rel.startsWith("..") && !/^[A-Za-z]:/.test(rel) ? rel : r.path!) };
  });
  // a new terminal starts in the set's root, not in whichever repository VS Code would ask for
  const settings: Record<string, unknown> = { "terminal.integrated.cwd": norm(commonRoot(folder, ok.map((r) => r.path!))) };
  if (set) settings["aihub.set"] = { ...set, repos: ok.map((r) => ({ name: r.repo, branch: r.branch })) } satisfies WindowSet;
  return JSON.stringify({ folders, settings }, null, 2);
}

export type CodeLauncher = (file: string, window: OpenWindow, env: NodeJS.ProcessEnv) => boolean;

/** `code [-n|-r] file`; AIHUB_CODE_BIN / AIHUB_CODE_ARGS point it at another VS Code (tests, isolated profiles). */
export const launchCode: CodeLauncher = (file, window, env) => {
  try {
    const bin = env.AIHUB_CODE_BIN || "code";
    const extra = (env.AIHUB_CODE_ARGS ?? "").split(/\s+/).filter(Boolean);
    const child = spawn(bin, [...extra, window === "this" ? "-r" : "-n", file], { detached: true, stdio: "ignore", shell: process.platform === "win32" && !/\.exe$/i.test(bin), windowsHide: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
};

/** Where sets live: next to the main checkout, also when this runs inside a worktree or a set (never a set inside a set). */
export function defaultSetsRootFor(cwd: string, root: string | undefined, firstRepo: string): string {
  const here = findSet(cwd);
  if (here) return dirname(here.folder);
  if (!root) return join(dirname(firstRepo), "worktrees");
  const main = tryGit(root, ["worktree", "list", "--porcelain"]).out.split("\n").find((l) => l.startsWith("worktree "))?.slice(9) ?? root;
  return defaultSetsRoot(main);
}

/** Run from inside a set, repository names resolve next to the normal checkout it came from, not to the set's worktrees. */
function outsideSet(ctx: Ctx): Ctx {
  const here = findSet(ctx.cwd);
  const meta = here && readSetMeta(here.folder);
  if (!meta?.repos?.length) return ctx;
  const mine = meta.repos.find((r) => samePath(r.path, ctx.cwd) || resolve(ctx.cwd).toLowerCase().startsWith(resolve(r.path).toLowerCase())) ?? meta.repos[0];
  return mine.source && existsSync(mine.source) ? { ...ctx, cwd: mine.source } : ctx;
}

export function openSet(setCtx: Ctx, o: OpenSetOpts, launcher: CodeLauncher = launchCode): OpenSetResult {
  const branch = o.branch?.trim();
  if (!branch) throw new AihubError("--branch <name> is required");
  // the sets root is still found from where this runs (next to the set, never inside it)
  const setsBase = setCtx.cwd;
  const ctx = outsideSet(setCtx);
  const mode = o.mode ?? "worktree";
  let dirs: RepoDir[];
  let missing: string[] = [];
  if (o.group) {
    const g = findGroup(ctx, o.group);
    ({ dirs, missing } = groupDirs(ctx, g));
  } else if (o.repos?.length) dirs = resolveRepos(ctx, o.repos);
  else throw new AihubError("usage: aihub worktree open --group <name> | --repos a,b,c --branch <branch> [--from <target>] [--mode worktree|switch] [--window new|this]");
  if (!dirs.length) throw new AihubError(`none of the repositories exists on this PC${missing.length ? ` (${missing.join(", ")})` : ""}`);
  let root: string | undefined;
  try {
    root = repoRoot(ctx.cwd);
  } catch {
    root = undefined;
  }
  const team = root ? loadTeam(root) : {};
  const pattern = storyPatternOf(team);
  const setsRoot = resolve(o.root ?? worktreeRootOf(team, root) ?? defaultSetsRootFor(setsBase, root, dirs[0].dir));
  const storyId = o.storyId ?? storyIdFromBranch(branch, pattern);
  const branchOf = (name: string) => o.branches?.[name] ?? branch;
  // a story's worktrees go to <root>/<id>-<slug>/<repo>[--variant]; other branches keep one folder per branch
  const storyFolders = storyId && existsSync(setsRoot) ? readdirSync(setsRoot) : [];
  const folder = storyId ? storyFolderFor({ root: setsRoot, storyId, branch, storyFolders }) : join(setsRoot, slug(branch));
  const pathFor = storyId ? (d: RepoDir) => worktreePathFor({ root: setsRoot, storyId, repo: d.name, branch: branchOf(d.name), storyFolders, exists: existsSync }) : undefined;
  const repos = dirs.map((d) => openRepo(d, { branch: branchOf(d.name), from: o.from, mode, folder, team, path: pathFor }));
  for (const m of missing) repos.push({ repo: m, ok: false, state: "failed", branch, note: "folder not found on this PC" });
  let workspace: string | undefined;
  const okRepos = repos.filter((r) => r.ok && r.path);
  if (okRepos.length) {
    mkdirSync(folder, { recursive: true });
    const name = slug(o.group ?? (storyId ? `story-${storyId}` : `set-${branch}`)) + (storyId && !o.branches ? `--${variantOf(branch, storyId)}` : "");
    workspace = join(folder, `${name}.code-workspace`);
    writeFileSync(workspace, workspaceJson(folder, repos, { story: storyId, group: o.group, branch, mode }), "utf8");
    if (mode === "worktree") {
      const meta: SetMeta = { story: storyId ?? 0, branch, group: o.group, workspace, repos: okRepos.map((r) => ({ name: r.repo, source: dirs.find((d) => d.name === r.repo)!.dir, path: r.path! })) };
      writeSetMeta(folder, meta);
    }
    // a story branch opened here belongs to the story: linked locally, and the star when the story has none yet
    if (storyId) for (const r of okRepos) linkLocally(r.path!, storyId, r.branch, mode === "worktree" ? r.path : undefined);
  }
  const win = o.window ?? "new";
  const opened = !!workspace && win !== "none" && launcher(workspace, win, ctx.env);
  return { story: storyId, group: o.group, branch, mode, folder, workspace, repos, opened };
}

/** Links a branch to a story in the repository's story-worktrees.json; never fails the caller. */
export function linkLocally(dir: string, storyId: number, branch: string, worktree?: string, now = Date.now()): void {
  try {
    const file = storyWorktreesFileFor(dir);
    if (!file) return;
    updateStoryWorktrees(file, (d) => linkBranch(d, { storyId, branch, worktree, current: !currentOf(d, storyId) || d.branches[branch]?.status === "current" }, now));
  } catch {
    /* the link is a convenience: a read-only or newer file must not stop opening the set */
  }
}

/** team.yaml `worktrees.storyPattern`: a regex whose first group is the story id in a branch name. */
export const storyPatternOf = (team: TeamConfig): string | undefined => ((team.worktrees as { storyPattern?: string } | undefined)?.storyPattern || undefined);

/** team.yaml `worktrees.root` (absolute, or relative to the repository). */
export function worktreeRootOf(team: TeamConfig, repo: string | undefined): string | undefined {
  const r = (team.worktrees as { root?: string } | undefined)?.root;
  return r ? resolve(repo ?? ".", r) : undefined;
}

export function formatOpenSet(r: OpenSetResult): string {
  const w = Math.max(4, ...r.repos.map((x) => x.repo.length));
  const lines = [`${r.group ? `group ${r.group} · ` : ""}branch ${r.branch} · ${r.mode}`];
  for (const x of r.repos) lines.push(`${x.ok ? "ok  " : "FAIL"} ${x.repo.padEnd(w)}  ${x.state.padEnd(15)} ${x.note}`);
  if (r.workspace) lines.push(`workspace ${r.workspace}${r.opened ? " (opened in VS Code)" : ""}`);
  return lines.join("\n");
}

// ---- which branches exist where (the picker's second step) -------------------------------------------------

export interface BranchRow {
  name: string;
  in: string[];
  missing: string[];
}

export function listBranches(dirs: RepoDir[], limit = 60): BranchRow[] {
  const where = new Map<string, Set<string>>();
  const order: string[] = [];
  for (const d of dirs) {
    const refs = tryGit(d.dir, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)", "refs/heads", "refs/remotes/origin"]).out.split("\n").filter(Boolean);
    for (const r of refs) {
      const n = r.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/origin\//, "");
      if (n === "HEAD") continue;
      if (!where.has(n)) {
        where.set(n, new Set());
        order.push(n);
      }
      where.get(n)!.add(d.name);
    }
  }
  const names = dirs.map((d) => d.name);
  return order.slice(0, limit).map((n) => ({ name: n, in: names.filter((x) => where.get(n)!.has(x)), missing: names.filter((x) => !where.get(n)!.has(x)) }));
}

/** The branch each clone is on now ("" when detached): the picker offers it first. */
export function currentBranches(dirs: RepoDir[]): Record<string, string> {
  return Object.fromEntries(dirs.map((d) => [d.name, tryGit(d.dir, ["branch", "--show-current"]).out.trim()]));
}

export function readSetMeta(folder: string): SetMeta | undefined {
  try {
    return JSON.parse(readFileSync(join(folder, ".aihub-set.json"), "utf8")) as SetMeta;
  } catch {
    return undefined;
  }
}
