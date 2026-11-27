import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "./proc.js";
import { ensureBranch } from "./branches.js";
import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { originDefaultBranch, repoRoot } from "./git.js";
import { hasTrackedChanges, listWorktrees, mustGit, refSha, samePath, tryGit, type Worktree } from "./gitx.js";
import { checkExisting, moveAside, moveExisting, readWhenExists, recreateExisting, type WhenExists } from "./existingWorktree.js";
import { findGroup, groupDirs, resolveRepos } from "./repoGroups.js";
import { fetchOrigin, type RepoDir } from "./repos.js";
import { defaultTargetFor, loadTeam, type TeamConfig } from "./team.js";
import { findSet } from "./setInfo.js";
import { linkBranch, currentOf, readStoryWorktrees, storyFolderFor, storyIdFromBranch, storyWorktreesFileFor, updateStoryWorktrees, variantOf, worktreePathFor } from "./storyWorktrees.js";
import { defaultSetsRoot, removeWorktreeSafely, slugOfBranch } from "./worktree.js";
import { readSetFile, repoBranch, saveSetMeta, writeSetFile, type SetKind, type SetMeta } from "./setFile.js";
import { removeWorktreeSafely as removeSafely } from "./safeWorktree.js";

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
  /** per repository another base than `from` for a branch that is made new (`--from-for repo=target`) */
  froms?: Record<string, string>;
  mode?: OpenMode;
  window?: OpenWindow;
  root?: string;
  json?: boolean;
  /** a branch whose worktree is elsewhere: move it here, reuse it there, or recreate it (else the personal preference, else ask) */
  existing?: Exclude<WhenExists, "ask">;
  /** with existing recreate: also when the old worktree has uncommitted work (a patch backup is kept) */
  discardLocalWork?: boolean;
  /** the command line to repeat with --existing in the question (default: the `worktree open` of these options) */
  again?: string;
  /** run from inside a set: still make a new set (else naming only some repositories of the set switches them in place) */
  newSet?: boolean;
}

export type RepoState = "existing" | "created" | "reused-worktree" | "moved" | "recreated" | "switched" | "already-on" | "skipped" | "failed" | "removed" | "kept";

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
  /** mode switch: the worktree that has the branch checked out already */
  checkedOutIn?: string;
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
  /** run inside a set for some of its repositories: what changed in the open window (no new window) */
  stays?: string;
}

export const slug = slugOfBranch;

const hasBranch = (dir: string, b: string) => !!refSha(dir, `refs/heads/${b}`) || !!refSha(dir, `refs/remotes/origin/${b}`);

/** --from, else the repository's own team.yaml target, else the one of the repository you run this in, else origin's default branch. */
function baseOf(dir: string, name: string, from: string | undefined, team: TeamConfig): string {
  return from ?? defaultTargetFor(loadTeam(dir), name) ?? defaultTargetFor(team, name) ?? (originDefaultBranch(dir) || undefined) ?? "main";
}

/** One repository on the branch. Never throws: a failure is one row, the others continue. */
export function openRepo(
  r: RepoDir,
  o: {
    branch: string;
    from?: string;
    mode: OpenMode;
    folder: string;
    team: TeamConfig;
    path?: (dir: RepoDir) => string;
    /** the branch's worktree elsewhere: move or recreate it (checkExisting asked first); else it is reused there */
    existing?: Exclude<WhenExists, "ask">;
    discardLocalWork?: boolean;
    again?: string;
    /** `git worktree list` of r.dir, when the caller read it already (checkExisting) */
    worktrees?: Worktree[];
  },
): RepoResult {
  const out = (state: RepoState, ok: boolean, note: string, extra: Partial<RepoResult> = {}): RepoResult => ({ repo: r.name, ok, state, branch: o.branch, note, ...extra });
  try {
    fetchOrigin(r.dir);
    let created = false;
    let from = "";
    if (!hasBranch(r.dir, o.branch)) {
      // never create a branch and then refuse the switch: nothing half done
      if (o.mode === "switch" && hasTrackedChanges(r.dir)) return out("skipped", false, "uncommitted changes; commit or stash them, nothing was changed");
      const base = baseOf(r.dir, r.name, o.from, o.team);
      const e = ensureBranch(r.dir, o.branch, base, false);
      created = e.created;
      from = e.from;
    }
    const where = (o.worktrees ?? listWorktrees(r.dir)).find((w) => w.branch === o.branch);
    const made = created ? `created from ${from} (local; pushed with your first push)` : "existing branch";
    if (o.mode === "switch") {
      if (where && samePath(where.path, r.dir)) return out("already-on", true, "already on the branch", { path: r.dir });
      if (where) return out("failed", false, `branch is checked out in ${where.path}; use mode worktree or switch that one first`, { checkedOutIn: where.path });
      if (hasTrackedChanges(r.dir)) return out("skipped", false, "uncommitted changes; commit or stash them, nothing was changed");
      mustGit(r.dir, ["switch", o.branch]);
      return out("switched", true, `switched (${made})`, { path: r.dir, from: from || undefined });
    }
    // mode worktree: one worktree per repository inside the set folder (a story folder: <repo> or <repo>--<variant>)
    const path = o.path ? o.path(r) : join(o.folder, r.name);
    const again = o.again ?? "the same command";
    if (where) {
      const inSet = samePath(where.path, path) || isInside(o.folder, where.path);
      if (inSet || where.main || !o.existing || o.existing === "reuse") return out("reused-worktree", true, inSet ? "worktree of this set reused" : `branch already checked out in ${where.path}; that folder is opened`, { path: where.path });
      const p = o.existing === "move" ? moveExisting(r.dir, o.branch, where.path, path, again) : recreateExisting(r.dir, o.branch, where.path, path, { discard: o.discardLocalWork, again });
      return p.ok ? out(p.state, true, p.note, { path }) : out("failed", false, p.note);
    }
    // a leftover folder that is not a worktree: renamed aside with --existing recreate, never deleted
    let aside = "";
    if (existsSync(path)) {
      if (o.existing !== "recreate") return out("failed", false, `${path} exists and is not a worktree on this branch; move it away, or run again with --existing recreate (it is renamed to ${basename(path)}.old-<time>, nothing is deleted): ${again} --existing recreate`);
      aside = moveAside(path);
    }
    mkdirSync(dirname(path), { recursive: true });
    mustGit(r.dir, ["worktree", "add", path, o.branch]);
    return out(created ? "created" : "existing", true, `worktree, ${made}${aside ? `; the folder that was there is now ${aside}` : ""}`, { path, from: from || undefined });
  } catch (e) {
    return out("failed", false, (e as Error).message.split("\n")[0]);
  }
}

const norm = (p: string) => p.replace(/\\/g, "/");
const isInside = (folder: string, p: string) => ((rel) => !!rel && !rel.startsWith("..") && !isAbsolute(rel))(relative(folder, p));
const quoteArg = (a: string) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);
/** The command line to repeat with --existing: `aihub <words>` without --existing, --discard-local-work and --json. */
export function againOf(words: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i] === "--existing") i++;
    else if (words[i] !== "--discard-local-work" && words[i] !== "--json" && !words[i].startsWith("--existing=")) out.push(quoteArg(words[i]));
  }
  return `aihub ${out.join(" ")}`;
}

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
    // one name form for every set: "<repo> (<branch>)", so the Explorer shows the branch each repository is on
    return { name: `${r.repo} (${r.branch})`, path: norm(rel && !rel.startsWith("..") && !/^[A-Za-z]:/.test(rel) ? rel : r.path!) };
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
  const meta = setHere(ctx.cwd)?.meta;
  if (!meta?.repos?.length) return ctx;
  const mine = meta.repos.find((r) => samePath(r.path, ctx.cwd) || resolve(ctx.cwd).toLowerCase().startsWith(resolve(r.path).toLowerCase())) ?? meta.repos[0];
  return mine.source && existsSync(mine.source) ? { ...ctx, cwd: mine.source } : ctx;
}

export function openSet(setCtx: Ctx, o: OpenSetOpts, launcher: CodeLauncher = launchCode): OpenSetResult {
  const branch = o.branch?.trim();
  if (!branch) throw new AihubError("--branch <name> is required");
  // inside a set, naming some of its repositories changes those in this set: no new set, no new window
  if (!o.newSet && !o.group && !o.branches && o.repos?.length) {
    const here = setHere(setCtx.cwd);
    if (here && someOfSet(here, o.repos)) return switchInSet(here, { repos: o.repos, branch, from: o.from, mode: o.mode, existing: o.existing, discardLocalWork: o.discardLocalWork, again: o.again, env: setCtx.env });
  }
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
  const stray = [...Object.keys(o.branches ?? {}), ...Object.keys(o.froms ?? {})].filter((n) => !dirs.some((d) => d.name === n) && !missing.includes(n));
  if (stray.length) throw new AihubError(`--branch-for/--from-for names ${stray.join(", ")}, which is not in --repos/--group (${dirs.map((d) => d.name).join(", ")}); nothing was changed`);
  const branchOf = (name: string) => o.branches?.[name] ?? branch;
  // a story's worktrees go to <root>/<id>-<slug>/<repo>[--variant]; other branches keep one folder per branch
  const storyFolders = storyId && existsSync(setsRoot) ? readdirSync(setsRoot) : [];
  const folder = storyId ? storyFolderFor({ root: setsRoot, storyId, branch, storyFolders }) : join(setsRoot, slug(branch));
  const pathFor = storyId ? (d: RepoDir) => worktreePathFor({ root: setsRoot, storyId, repo: d.name, branch: branchOf(d.name), storyFolders: [basename(folder), ...storyFolders], exists: existsSync }) : undefined;
  // a branch with a worktree elsewhere: the question comes before anything is created
  const again = o.again ?? againOf(["worktree", "open", ...(o.group ? ["--group", o.group] : ["--repos", dirs.map((d) => d.name).join(",")]), "--branch", branch, ...(o.from ? ["--from", o.from] : [])]);
  const policy = o.existing ?? readWhenExists(setCtx.env);
  const lists = mode === "worktree" ? checkExisting(dirs.map((d) => ({ repo: d.name, source: d.dir, branch: branchOf(d.name), target: pathFor ? pathFor(d) : join(folder, d.name) })), { folder, policy, again }) : new Map<string, Worktree[]>();
  const how = policy === "ask" ? undefined : policy;
  const repos = dirs.map((d) => openRepo(d, { branch: branchOf(d.name), from: o.froms?.[d.name] ?? o.from, mode, folder, team, path: pathFor, existing: how, discardLocalWork: o.discardLocalWork, again, worktrees: lists.get(d.dir) }));
  for (const m of missing) repos.push({ repo: m, ok: false, state: "failed", branch, note: "folder not found on this PC" });
  let workspace: string | undefined;
  const okRepos = repos.filter((r) => r.ok && r.path);
  if (okRepos.length) {
    mkdirSync(folder, { recursive: true });
    const name = slug(o.group ?? (storyId ? `story-${storyId}` : `set-${branch}`)) + (storyId && !o.branches ? `--${variantOf(branch, storyId)}` : "");
    workspace = join(folder, `${name}.code-workspace`);
    writeFileSync(workspace, workspaceJson(folder, repos, { story: storyId, group: o.group, branch, mode }), "utf8");
    if (mode === "worktree") {
      const meta: SetMeta = { story: storyId ?? 0, branch, group: o.group, workspace, repos: okRepos.map((r) => ({ name: r.repo, source: dirs.find((d) => d.name === r.repo)!.dir, path: r.path!, ...(r.branch !== branch ? { branch: r.branch } : {}) })) };
      saveSetMeta(folder, meta);
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
  if (r.stays) lines.push(r.stays);
  else if (r.workspace) lines.push(`workspace ${r.workspace}${r.opened ? " (opened in VS Code)" : ""}`);
  return lines.join("\n");
}

// ---- some repositories of the set you are in on another branch (`aihub branch switch`) -----------------------

/** The set this folder is in, with its full set file entry (source clones, workspace file). */
export interface HereSet {
  folder: string;
  meta: SetMeta;
  /** `.aihub-set.json` or the extension's `.worktree-set.json`: changes go back into the same file */
  kind: SetKind;
}

export function setHere(cwd: string): HereSet | undefined {
  const s = findSet(cwd);
  const file = s && readSetFile(s.folder);
  if (!s || !file?.top.repos?.length) return undefined;
  const all = [file.top, ...(file.top.others ?? [])];
  const { others: _o, ...meta } = all.find((m) => m.story === s.story && m.branch === s.branch && (m.group ?? "") === (s.group ?? "")) ?? file.top;
  return { folder: s.folder, meta, kind: file.kind };
}

/** A repository of the set by name, or by the folder of its worktree in the set (the VS Code picker passes folders). */
const entryOf = (here: HereSet, name: string) => {
  const n = name.trim();
  const abs = isAbsolute(n) || /^[A-Za-z]:[\\/]/.test(n);
  return here.meta.repos.find((r) => (abs ? samePath(r.path, n) : r.name.toLowerCase() === n.toLowerCase()));
};

/** Only some of the set's repositories, all of them in the set: a branch change inside the set, not a new set. */
function someOfSet(here: HereSet, names: string[]): boolean {
  const wanted = new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean));
  return wanted.size > 0 && wanted.size < here.meta.repos.length && [...wanted].every((n) => entryOf(here, n));
}

/** A free `<set>/<repo>--<variant>` folder for a second worktree of a repository. */
function variantPath(folder: string, repo: string, branch: string, storyId?: number): string {
  const first = join(folder, `${repo}--${variantOf(branch, storyId)}`);
  if (!existsSync(first)) return first;
  for (let i = 2; ; i++) if (!existsSync(`${first}-${i}`)) return `${first}-${i}`;
}

/** A free folder next to the set folder for a worktree that leaves the set but stays on disk: `<set>--<repo>-<variant>`. */
function looseFolder(folder: string, repo: string, branch: string, storyId?: number): string {
  const first = join(dirname(folder), `${basename(folder)}--${repo}-${variantOf(branch, storyId)}`);
  if (!existsSync(first)) return first;
  for (let i = 2; ; i++) if (!existsSync(`${first}-${i}`)) return `${first}-${i}`;
}

type SetRepo = SetMeta["repos"][number];
export { repoBranch };

/**
 * Some repositories of the set you are in on another branch. Default: `git switch` in the set's own worktree (the
 * folder, the workspace file's folders and the other repositories stay). `mode worktree`: a second worktree
 * `<repo>--<variant>` (or the folder that already has the branch) is added to this set and its workspace file.
 * Never opens a window.
 */
export function switchInSet(
  here: HereSet,
  o: { repos: string[]; branch: string; from?: string; mode?: OpenMode; existing?: Exclude<WhenExists, "ask">; discardLocalWork?: boolean; again?: string; env?: NodeJS.ProcessEnv },
): OpenSetResult {
  const { folder, meta, kind } = here;
  const branch = o.branch.trim();
  if (!branch) throw new AihubError("--branch <name> is required");
  // --existing answers the question about a worktree elsewhere: that worktree comes into this set
  const mode = o.mode ?? (o.existing ? "worktree" : "switch");
  const unknown = o.repos.filter((n) => !entryOf(here, n));
  if (unknown.length) throw new AihubError(`${unknown.join(", ")} not in this set (${meta.repos.map((r) => r.name).join(", ")}); add --new-set to open a new set instead`);
  const entries = [...new Set(o.repos.map((n) => entryOf(here, n)!))];
  const team = loadTeam(entries[0].source);
  const storyId = storyIdFromBranch(branch, storyPatternOf(team));
  const result = (repos: RepoResult[], stays: string): OpenSetResult => ({ story: meta.story || undefined, group: meta.group, branch, mode, folder, workspace: meta.workspace, repos, opened: false, stays });
  const keep = "nothing was changed; the window stays as it is";
  const dirtyNote = (e: SetRepo) => `uncommitted changes in ${e.path}; nothing was changed. Commit or stash them first, or add --mode worktree for a second worktree of ${e.name} next to it`;
  // several repositories: all or nothing when one of them has uncommitted work
  if (mode === "switch" && entries.length > 1) {
    const dirty = entries.filter((e) => hasTrackedChanges(e.path));
    if (dirty.length)
      return result(
        entries.map((e) => ({ repo: e.name, ok: false, state: "skipped", branch, note: dirty.includes(e) ? dirtyNote(e) : `not switched: ${dirty.map((d) => d.name).join(", ")} has uncommitted changes` })),
        keep,
      );
  }
  // the branch has a worktree outside this set: ask before anything changes (or follow --existing / the preference)
  const again = o.again ?? againOf(["branch", "switch", "--repo", entries.map((e) => e.name).join(","), "--branch", branch, ...(o.from ? ["--from", o.from] : [])]);
  const policy = o.existing ?? (o.env ? readWhenExists(o.env) : "ask");
  const targets = new Map(entries.map((e) => [e.name, variantPath(folder, e.name, branch, storyId)]));
  const lists = checkExisting(entries.map((e) => ({ repo: e.name, source: e.source, branch, target: targets.get(e.name)! })), { folder, policy, again });
  const how = policy === "ask" ? undefined : policy;
  const elsewhere = (e: SetRepo) => (lists.get(e.source) ?? []).find((w) => w.branch === branch && !w.main && !isInside(folder, w.path));
  const added: SetRepo[] = [];
  const switched = new Set<string>();
  // the answer to the question of a switch (--existing without --mode): the repository's own entry now stands on the chosen worktree;
  // the set keeps exactly one entry per repository. (--mode worktree still adds a second worktree of the repository.)
  const replace = !o.mode && !!o.existing;
  const replaced = new Map<string, string>();
  const repos = entries.map((e): RepoResult => {
    if (replace && how && elsewhere(e) && hasWorktree(e.path)) {
      const oldBranch = repoBranch(meta, e);
      const oldPath = e.path;
      // the old worktree steps aside first (a move, reversible), so the chosen one can stand in its folder
      let aside: string | undefined;
      if (how !== "reuse") {
        aside = looseFolder(folder, e.name, oldBranch, storyId);
        const m = tryGit(e.source, ["worktree", "move", oldPath, aside]);
        if (!m.ok) return { repo: e.name, ok: false, state: "failed", branch, note: `the folder of ${oldBranch} could not step aside (${m.err.split(String.fromCharCode(10))[0]}); nothing was changed` };
      }
      const r = openRepo({ name: e.name, dir: e.source }, { branch, from: o.from, mode: "worktree", folder, team, path: () => oldPath, existing: how, discardLocalWork: o.discardLocalWork, again, worktrees: lists.get(e.source) });
      if (!r.ok || !r.path) {
        if (aside) tryGit(e.source, ["worktree", "move", aside, oldPath]);
        return r;
      }
      // the old worktree: removed by the safe rule (clean, its commits exist elsewhere), else it stays on disk as a loose folder
      const old = aside ?? oldPath;
      const rm = removeSafely(e.source, old, oldBranch, { env: o.env });
      let left = "";
      if (!rm.removed) {
        left = old;
        if (!aside) {
          const to = looseFolder(folder, e.name, oldBranch, storyId);
          if (tryGit(e.source, ["worktree", "move", old, to]).ok) left = to;
        }
      }
      replaced.set(e.name, r.path);
      if (storyId) linkLocally(r.path, storyId, branch, r.path);
      return { ...r, repo: e.name, note: `${r.note}; ${left ? `the folder on ${oldBranch} stays as a loose folder: ${left}` : `the folder on ${oldBranch} was clean and its commits exist elsewhere: removed`}` };
    }
    if (mode === "switch" && !(how && elsewhere(e))) {
      if (!hasWorktree(e.path)) return { repo: e.name, ok: false, state: "failed", branch, note: `in the set file without a worktree; make it first: aihub worktree repair` };
      const r = openRepo({ name: e.name, dir: e.path }, { branch, from: o.from, mode: "switch", folder, team, worktrees: lists.get(e.source) });
      if (r.state === "skipped") return { ...r, note: dirtyNote(e) };
      if (r.checkedOutIn) return { ...r, note: `${branch} is already checked out in ${r.checkedOutIn}; nothing was changed. Switch that checkout to another branch first, or put it in this set: ${again} --existing reuse` };
      if (r.ok) {
        relinkWorktree(e.path, branch, storyId);
        switched.add(e.name);
      }
      return r;
    }
    const target = targets.get(e.name)!;
    const r = openRepo({ name: e.name, dir: e.source }, { branch, from: o.from, mode: "worktree", folder, team, path: () => target, existing: how, discardLocalWork: o.discardLocalWork, again, worktrees: lists.get(e.source) });
    if (!r.ok || !r.path) return r;
    const inSet = meta.repos.find((x) => samePath(x.path, r.path!));
    if (inSet) return { ...r, repo: inSet.name, state: "already-on", note: `already in this set as ${inSet.name}` };
    const name = basename(target);
    added.push({ name, source: e.source, path: r.path, branch });
    if (storyId) linkLocally(r.path, storyId, branch, r.path);
    return { ...r, repo: name };
  });
  const changed = repos.filter((r) => r.ok && r.state !== "already-on");
  // the set file keeps each repository's own branch (`repos[].branch`), so status, list and --all-repos show it
  if (added.length || switched.size || replaced.size) writeSetFile(folder, kind, { ...meta, repos: [...meta.repos.map((r) => (replaced.has(r.name) ? { ...r, path: replaced.get(r.name)!, branch } : switched.has(r.name) ? { ...r, branch } : r)), ...added] });
  if (meta.workspace && changed.length) updateWorkspace(meta.workspace, folder, changed, kind);
  const total = meta.repos.length + added.length;
  const what = changed.map((r) => `${r.repo} ${added.some((a) => a.name === r.repo) ? "added" : "now"} on ${r.branch}`);
  if (what.length) return result(repos, `the window stays as it is: ${total} repositories, ${what.join(", ")}`);
  return result(repos, repos.every((r) => r.ok) ? `the window stays as it is: ${repos.map((r) => `${r.repo} already on ${r.branch}`).join(", ")}` : keep);
}

/**
 * `aihub branch switch --repo r --branch X`: inside a set, that repository's worktree in this set (see switchInSet);
 * outside a set, the checkout itself (`git switch`, never over uncommitted work). Never opens a window.
 */
export function branchSwitch(ctx: Ctx, o: { repos: string[]; branch: string; from?: string; mode?: OpenMode; existing?: Exclude<WhenExists, "ask">; discardLocalWork?: boolean; again?: string }): OpenSetResult {
  const branch = o.branch?.trim();
  if (!branch) throw new AihubError("--branch <name> is required");
  const here = setHere(ctx.cwd);
  if (here) {
    const inside = (p: string) => ((rel) => !rel.startsWith("..") && !/^[A-Za-z]:/.test(rel) && !rel.startsWith("/"))(relative(resolve(p), resolve(ctx.cwd)));
    const mine = here.meta.repos.find((r) => inside(r.path));
    const names = o.repos.length ? o.repos : mine ? [mine.name] : [];
    if (!names.length) throw new AihubError(`name the repository: --repo <name> (this set: ${here.meta.repos.map((r) => r.name).join(", ")})`);
    return switchInSet(here, { repos: names, branch, from: o.from, mode: o.mode, existing: o.existing, discardLocalWork: o.discardLocalWork, again: o.again, env: ctx.env });
  }
  if (o.mode === "worktree") throw new AihubError(`not inside a worktree set; for a worktree use: aihub worktree open --repos ${o.repos.join(",") || "<repo>"} --branch ${branch}`);
  let dirs: RepoDir[];
  if (o.repos.length) dirs = resolveRepos(ctx, o.repos);
  else {
    const root = repoRoot(ctx.cwd);
    dirs = [{ name: basename(root), dir: root }];
  }
  const team = loadTeam(dirs[0].dir);
  const repos = dirs.map((d) => openRepo(d, { branch, from: o.from, mode: "switch", folder: d.dir, team }));
  const done = repos.filter((r) => r.ok).map((r) => `${r.repo} ${r.state === "already-on" ? "already" : "now"} on ${branch}`);
  return { branch, mode: "switch", folder: dirname(dirs[0].dir), repos, opened: false, stays: done.length ? `no window opened: ${done.join(", ")}` : "nothing was changed" };
}

// ---- a repository added to or taken out of the set you are in (`aihub worktree add|drop|repair`) -------------

const notInSet = (what: string) => new AihubError(`not inside a worktree set; ${what} runs from a folder of the set (or the set folder)`);
const hasWorktree = (p: string) => existsSync(join(p, ".git"));

/**
 * Repositories added to the set you are in: a worktree `<set>/<repo>` on --branch (else the set's branch; created from
 * --from or the team target when it does not exist yet), then the set file and the workspace file. A repository that is
 * in the set file without a worktree (added by hand) gets its worktree at the folder the set file names. No window.
 */
export function addToSet(ctx: Ctx, o: { repos: string[]; branch?: string; from?: string; existing?: Exclude<WhenExists, "ask">; discardLocalWork?: boolean; again?: string }): OpenSetResult {
  const here = setHere(ctx.cwd);
  if (!here) throw notInSet("aihub worktree add");
  if (!o.repos.length) throw new AihubError("usage: aihub worktree add --repos a,b [--branch <b>] [--from <target>]");
  const { folder, meta, kind } = here;
  const team = loadTeam(meta.repos[0]?.source ?? ctx.cwd);
  const src = outsideSet(ctx);
  const repos: RepoResult[] = [];
  const entries = [...meta.repos];
  // what each name becomes (an entry without worktree, or a clone next to the set's sources), and the question first
  type Plan = { name: string; had?: SetRepo; dir?: RepoDir; branch: string; target?: string; error?: string };
  const plans: Plan[] = o.repos.map((name) => {
    const had = entryOf(here, name);
    const branch = o.branch?.trim() || (had ? repoBranch(meta, had) : meta.branch);
    if (had && hasWorktree(had.path)) return { name, had, branch };
    try {
      const dir = had ? { name: had.name, dir: had.source } : resolveRepos(src, [name])[0];
      if (!dir) return { name, branch, error: "folder not found on this PC" };
      const target = had ? had.path : existsSync(join(folder, dir.name)) ? variantPath(folder, dir.name, branch, storyIdFromBranch(branch, storyPatternOf(team))) : join(folder, dir.name);
      return { name, had, dir, branch, target };
    } catch (e) {
      return { name, branch, error: (e as Error).message.split("\n")[0] };
    }
  });
  const again = o.again ?? againOf(["worktree", "add", "--repos", o.repos.join(","), ...(o.branch ? ["--branch", o.branch] : []), ...(o.from ? ["--from", o.from] : [])]);
  const policy = o.existing ?? readWhenExists(ctx.env);
  const lists = checkExisting(plans.filter((p) => p.dir && p.target).map((p) => ({ repo: p.dir!.name, source: p.dir!.dir, branch: p.branch, target: p.target! })), { folder, policy, again });
  const how = policy === "ask" ? undefined : policy;
  for (const { name, had, dir, branch, target, error } of plans) {
    if (error || !dir || !target) {
      if (error) repos.push({ repo: name, ok: false, state: "failed", branch, note: error });
      else if (had) repos.push({ repo: had.name, ok: true, state: "already-on", branch, path: had.path, note: "already in this set" });
      continue;
    }
    const r = openRepo(dir, { branch, from: o.from, mode: "worktree", folder, team, path: () => target, existing: how, discardLocalWork: o.discardLocalWork, again, worktrees: lists.get(dir.dir) });
    const label = had ? had.name : basename(target);
    repos.push({ ...r, repo: label, ...(had && r.ok ? { note: `${r.note} (it was in the set file without a worktree)` } : {}) });
    if (!r.ok || !r.path) continue;
    const entry = { name: label, source: dir.dir, path: r.path, branch };
    const i = entries.findIndex((x) => x.name === label);
    if (i >= 0) entries[i] = entry;
    else entries.push(entry);
    const story = storyIdFromBranch(branch, storyPatternOf(team));
    if (story) linkLocally(r.path, story, branch, r.path);
  }
  const changed = repos.filter((r) => r.ok && r.state !== "already-on");
  if (changed.length) writeSetFile(folder, kind, { ...meta, repos: entries });
  if (meta.workspace && changed.length) updateWorkspace(meta.workspace, folder, changed, kind);
  const what = changed.map((r) => `${r.repo} added on ${r.branch}`);
  return { story: meta.story || undefined, group: meta.group, branch: meta.branch, mode: "worktree", folder, workspace: meta.workspace, repos, opened: false, stays: what.length ? `the window stays as it is: ${entries.length} repositories, ${what.join(", ")}` : "nothing was changed; the window stays as it is" };
}

/** `aihub worktree repair`: every repository in the set file without a worktree gets one (see addToSet). */
export function repairSet(ctx: Ctx, ex: { existing?: Exclude<WhenExists, "ask">; discardLocalWork?: boolean; again?: string } = {}): OpenSetResult {
  const here = setHere(ctx.cwd);
  if (!here) throw notInSet("aihub worktree repair");
  const broken = here.meta.repos.filter((r) => !hasWorktree(r.path)).map((r) => r.name);
  if (!broken.length) return { story: here.meta.story || undefined, branch: here.meta.branch, mode: "worktree", folder: here.folder, workspace: here.meta.workspace, repos: [], opened: false, stays: "every repository of this set has its worktree; nothing to repair" };
  return addToSet(ctx, { repos: broken, ...ex });
}

/**
 * Repositories taken out of the set you are in. A worktree inside the set folder is removed with the checks of
 * `worktree remove` (uncommitted or unpushed work keeps it, and it stays in the set); a worktree elsewhere (reused)
 * only leaves the set. The branch stays. The set file and the workspace file are updated; no window.
 */
export function dropFromSet(ctx: Ctx, o: { repos: string[]; discardLocalWork?: boolean }): OpenSetResult {
  const here = setHere(ctx.cwd);
  if (!here) throw notInSet("aihub worktree drop");
  if (!o.repos.length) throw new AihubError("usage: aihub worktree drop --repos a,b");
  const { folder, meta, kind } = here;
  const unknown = o.repos.filter((n) => !entryOf(here, n));
  if (unknown.length) throw new AihubError(`${unknown.join(", ")} not in this set (${meta.repos.map((r) => r.name).join(", ")})`);
  const entries = [...new Set(o.repos.map((n) => entryOf(here, n)!))];
  if (entries.length === meta.repos.length) throw new AihubError(`that is every repository of this set; remove the whole set: aihub worktree remove --branch ${meta.branch}`);
  const inFolder = (p: string) => ((rel) => !!rel && !rel.startsWith("..") && !isAbsolute(rel))(relative(folder, p));
  const gone = new Set<string>();
  const repos = entries.map((e): RepoResult => {
    const branch = repoBranch(meta, e);
    if (!inFolder(e.path)) {
      gone.add(e.name);
      return { repo: e.name, ok: true, state: "removed", branch, path: e.path, note: `left the set; the worktree stays where it is: ${e.path}` };
    }
    try {
      const x = removeWorktreeSafely(e, branch, { discardLocalWork: o.discardLocalWork, env: ctx.env });
      if (x.removed) gone.add(e.name);
      return { repo: e.name, ok: x.removed, state: x.removed ? "removed" : "kept", branch, path: e.path, note: x.line.replace(`${e.name}: `, "") };
    } catch (err) {
      return { repo: e.name, ok: false, state: "kept", branch, path: e.path, note: (err as Error).message.split("\n")[0] };
    }
  });
  const left = meta.repos.filter((r) => !gone.has(r.name));
  if (gone.size) {
    writeSetFile(folder, kind, { ...meta, repos: left });
    if (meta.workspace) dropFromWorkspace(meta.workspace, folder, meta.repos.filter((r) => gone.has(r.name)));
  }
  const names = [...gone];
  return { story: meta.story || undefined, group: meta.group, branch: meta.branch, mode: "worktree", folder, workspace: meta.workspace, repos, opened: false, stays: names.length ? `the window stays as it is: ${left.length} repositories, ${names.join(", ")} taken out` : "nothing was changed; the window stays as it is" };
}

function dropFromWorkspace(file: string, folder: string, gone: SetRepo[]): void {
  try {
    const ws = JSON.parse(readFileSync(file, "utf8")) as { folders?: { name?: string; path: string }[]; settings?: Record<string, unknown> };
    ws.folders = (ws.folders ?? []).filter((f) => !gone.some((g) => samePath(resolve(folder, f.path), g.path)));
    const set = ws.settings?.["aihub.set"] as WindowSet | undefined;
    if (set?.repos) set.repos = set.repos.filter((x) => !gone.some((g) => g.name === x.name));
    writeFileSync(file, JSON.stringify(ws, null, 2), "utf8");
  } catch {
    /* a hand-edited workspace file (with comments) is left alone */
  }
}

/** The set's workspace file: a new folder is added, the branch of a switched one is updated; VS Code reloads it itself. */
function updateWorkspace(file: string, folder: string, rows: RepoResult[], kind: SetKind = "aihub"): void {
  try {
    const ws = JSON.parse(readFileSync(file, "utf8")) as { folders?: { name?: string; path: string }[]; settings?: Record<string, unknown> };
    const folders = (ws.folders ??= []);
    const set = ws.settings?.["aihub.set"] as WindowSet | undefined;
    for (const r of rows) {
      if (!r.path) continue;
      // the same name form as the extension's Worktree Sets: "<repo> (<branch>)"
      const label = `${r.repo} (${r.branch})`;
      const had = folders.find((f) => samePath(resolve(folder, f.path), r.path!)) ?? folders.find((f) => f.name === r.repo || f.name?.startsWith(`${r.repo} (`));
      if (had) {
        had.name = label;
        // a member that now stands in another folder (Reuse): the folder entry follows
        if (!samePath(resolve(folder, had.path), r.path)) {
          const rel = relative(folder, r.path);
          had.path = norm(rel && !rel.startsWith("..") && !/^[A-Za-z]:/.test(rel) ? rel : r.path);
        }
      } else {
        const rel = relative(folder, r.path);
        folders.push({ name: label, path: norm(rel && !rel.startsWith("..") && !/^[A-Za-z]:/.test(rel) ? rel : r.path) });
      }
      if (set?.repos) {
        const row = set.repos.find((x) => x.name === r.repo);
        if (row) row.branch = r.branch;
        else set.repos.push({ name: r.repo, branch: r.branch });
      }
    }
    writeFileSync(file, JSON.stringify(ws, null, 2), "utf8");
  } catch {
    /* a hand-edited workspace file (with comments) is left alone: the worktrees are right, a reload shows them */
  }
}

/** story-worktrees.json after a worktree changed branch: the old branch no longer points at it, a story branch is linked. */
function relinkWorktree(path: string, branch: string, storyId?: number): void {
  try {
    const file = storyWorktreesFileFor(path);
    if (!file) return;
    const here = (b: { branch: string; worktree?: string }) => b.branch !== branch && !!b.worktree && samePath(b.worktree, path);
    if (Object.values(readStoryWorktrees(file).branches).some(here))
      updateStoryWorktrees(file, (d) => ({ ...d, branches: Object.fromEntries(Object.entries(d.branches).map(([k, b]) => [k, here(b) ? { ...b, worktree: undefined } : b])) }));
    if (storyId) linkLocally(path, storyId, branch, path);
  } catch {
    /* the link is a convenience, as in linkLocally */
  }
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

/** The set file of a folder (`.aihub-set.json`, else the extension's `.worktree-set.json`). */
export function readSetMeta(folder: string): SetMeta | undefined {
  return readSetFile(folder)?.top;
}
