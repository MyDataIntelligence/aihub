import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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
import { linkBranch, currentOf, readStoryWorktrees, storyFolderFor, storyIdFromBranch, storyWorktreesFileFor, updateStoryWorktrees, variantOf, worktreePathFor } from "./storyWorktrees.js";
import { defaultSetsRoot, slugOfBranch } from "./worktree.js";
import { readSetFile, repoBranch, writeSetFile, writeSetMeta, type SetKind, type SetMeta } from "./setFile.js";

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
  /** run from inside a set: still make a new set (else naming only some repositories of the set switches them in place) */
  newSet?: boolean;
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
export function openRepo(r: RepoDir, o: { branch: string; from?: string; mode: OpenMode; folder: string; team: TeamConfig; path?: (dir: RepoDir) => string }): RepoResult {
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
    const where = listWorktrees(r.dir).find((w) => w.branch === o.branch);
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
    if (here && someOfSet(here, o.repos)) return switchInSet(here, { repos: o.repos, branch, from: o.from, mode: o.mode });
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
  const stray = Object.keys(o.branches ?? {}).filter((n) => !dirs.some((d) => d.name === n) && !missing.includes(n));
  if (stray.length) throw new AihubError(`--branch-for names ${stray.join(", ")}, which is not in --repos/--group (${dirs.map((d) => d.name).join(", ")}); nothing was changed`);
  const branchOf = (name: string) => o.branches?.[name] ?? branch;
  // a story's worktrees go to <root>/<id>-<slug>/<repo>[--variant]; other branches keep one folder per branch
  const storyFolders = storyId && existsSync(setsRoot) ? readdirSync(setsRoot) : [];
  const folder = storyId ? storyFolderFor({ root: setsRoot, storyId, branch, storyFolders }) : join(setsRoot, slug(branch));
  const pathFor = storyId ? (d: RepoDir) => worktreePathFor({ root: setsRoot, storyId, repo: d.name, branch: branchOf(d.name), storyFolders: [basename(folder), ...storyFolders], exists: existsSync }) : undefined;
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
      const meta: SetMeta = { story: storyId ?? 0, branch, group: o.group, workspace, repos: okRepos.map((r) => ({ name: r.repo, source: dirs.find((d) => d.name === r.repo)!.dir, path: r.path!, ...(r.branch !== branch ? { branch: r.branch } : {}) })) };
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

type SetRepo = SetMeta["repos"][number];
export { repoBranch };

/**
 * Some repositories of the set you are in on another branch. Default: `git switch` in the set's own worktree (the
 * folder, the workspace file's folders and the other repositories stay). `mode worktree`: a second worktree
 * `<repo>--<variant>` (or the folder that already has the branch) is added to this set and its workspace file.
 * Never opens a window.
 */
export function switchInSet(here: HereSet, o: { repos: string[]; branch: string; from?: string; mode?: OpenMode }): OpenSetResult {
  const { folder, meta, kind } = here;
  const branch = o.branch.trim();
  if (!branch) throw new AihubError("--branch <name> is required");
  const mode = o.mode ?? "switch";
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
  const added: SetRepo[] = [];
  const switched = new Set<string>();
  const repos = entries.map((e): RepoResult => {
    if (mode === "switch") {
      const r = openRepo({ name: e.name, dir: e.path }, { branch, from: o.from, mode: "switch", folder, team });
      if (r.state === "skipped") return { ...r, note: dirtyNote(e) };
      if (r.checkedOutIn) return { ...r, note: `${branch} is already checked out in ${r.checkedOutIn}; nothing was changed. Add --mode worktree to put that folder in this set next to ${e.name}` };
      if (r.ok) {
        relinkWorktree(e.path, branch, storyId);
        switched.add(e.name);
      }
      return r;
    }
    const target = variantPath(folder, e.name, branch, storyId);
    const r = openRepo({ name: e.name, dir: e.source }, { branch, from: o.from, mode: "worktree", folder, team, path: () => target });
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
  if (added.length || switched.size) writeSetFile(folder, kind, { ...meta, repos: [...meta.repos.map((r) => (switched.has(r.name) ? { ...r, branch } : r)), ...added] });
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
export function branchSwitch(ctx: Ctx, o: { repos: string[]; branch: string; from?: string; mode?: OpenMode }): OpenSetResult {
  const branch = o.branch?.trim();
  if (!branch) throw new AihubError("--branch <name> is required");
  const here = setHere(ctx.cwd);
  if (here) {
    const inside = (p: string) => ((rel) => !rel.startsWith("..") && !/^[A-Za-z]:/.test(rel) && !rel.startsWith("/"))(relative(resolve(p), resolve(ctx.cwd)));
    const mine = here.meta.repos.find((r) => inside(r.path));
    const names = o.repos.length ? o.repos : mine ? [mine.name] : [];
    if (!names.length) throw new AihubError(`name the repository: --repo <name> (this set: ${here.meta.repos.map((r) => r.name).join(", ")})`);
    return switchInSet(here, { repos: names, branch, from: o.from, mode: o.mode });
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

/** The set's workspace file: a new folder is added, the branch of a switched one is updated; VS Code reloads it itself. */
function updateWorkspace(file: string, folder: string, rows: RepoResult[], kind: SetKind = "aihub"): void {
  try {
    const ws = JSON.parse(readFileSync(file, "utf8")) as { folders?: { name?: string; path: string }[]; settings?: Record<string, unknown> };
    const folders = (ws.folders ??= []);
    const set = ws.settings?.["aihub.set"] as WindowSet | undefined;
    for (const r of rows) {
      if (!r.path) continue;
      // the extension's Worktree Sets name a folder "<repo> (<branch>)"
      const label = kind === "maker" ? `${r.repo} (${r.branch})` : r.repo;
      const had = folders.find((f) => samePath(resolve(folder, f.path), r.path!)) ?? folders.find((f) => f.name === r.repo);
      if (had) had.name = label;
      else {
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
