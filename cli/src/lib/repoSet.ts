import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { defaultSetsRoot, slugOfBranch, type SetMeta } from "./worktree.js";

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
export function openRepo(r: RepoDir, o: { branch: string; from?: string; mode: OpenMode; folder: string; team: TeamConfig }): RepoResult {
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
    // mode worktree: one worktree per repository inside the set folder
    const path = join(o.folder, r.name);
    if (where) {
      const inSet = samePath(where.path, path);
      return out("reused-worktree", true, inSet ? "worktree of this set reused" : `branch already checked out in ${where.path}; that folder is opened`, { path: where.path });
    }
    if (existsSync(path)) return out("failed", false, `${path} exists and is not a worktree on this branch`);
    mkdirSync(o.folder, { recursive: true });
    mustGit(r.dir, ["worktree", "add", path, o.branch]);
    return out(created ? "created" : "existing", true, `worktree, ${made}`, { path, from: from || undefined });
  } catch (e) {
    return out("failed", false, (e as Error).message.split("\n")[0]);
  }
}

const norm = (p: string) => p.replace(/\\/g, "/");

export function workspaceJson(folder: string, repos: RepoResult[]): string {
  const folders = repos
    .filter((r) => r.ok && r.path)
    .map((r) => {
      const rel = relative(folder, r.path!);
      return { name: r.repo, path: norm(rel && !rel.startsWith("..") && !/^[A-Za-z]:/.test(rel) ? rel : r.path!) };
    });
  return JSON.stringify({ folders, settings: {} }, null, 2);
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

export function openSet(ctx: Ctx, o: OpenSetOpts, launcher: CodeLauncher = launchCode): OpenSetResult {
  const branch = o.branch?.trim();
  if (!branch) throw new AihubError("--branch <name> is required");
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
  const setsRoot = resolve(o.root ?? (root ? defaultSetsRoot(root) : join(dirname(dirs[0].dir), "worktrees")));
  const folder = join(setsRoot, slug(branch));
  const repos = dirs.map((d) => openRepo(d, { branch, from: o.from, mode, folder, team }));
  for (const m of missing) repos.push({ repo: m, ok: false, state: "failed", branch, note: "folder not found on this PC" });
  let workspace: string | undefined;
  const okRepos = repos.filter((r) => r.ok && r.path);
  if (okRepos.length) {
    mkdirSync(folder, { recursive: true });
    workspace = join(folder, `${slug(o.group ?? `set-${branch}`)}.code-workspace`);
    writeFileSync(workspace, workspaceJson(folder, repos), "utf8");
    if (mode === "worktree") {
      const meta: SetMeta = { story: 0, branch, group: o.group, workspace, repos: okRepos.map((r) => ({ name: r.repo, source: dirs.find((d) => d.name === r.repo)!.dir, path: r.path! })) };
      writeFileSync(join(folder, ".aihub-set.json"), JSON.stringify(meta, null, 2), "utf8");
    }
  }
  const win = o.window ?? "new";
  const opened = !!workspace && win !== "none" && launcher(workspace, win, ctx.env);
  return { group: o.group, branch, mode, folder, workspace, repos, opened };
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

export function readSetMeta(folder: string): SetMeta | undefined {
  try {
    return JSON.parse(readFileSync(join(folder, ".aihub-set.json"), "utf8")) as SetMeta;
  } catch {
    return undefined;
  }
}
