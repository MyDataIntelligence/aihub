import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { worktreePath } from "../worktrees/core";

/**
 * "Open in Own Window": one repository of a set opened as a separate copy to play with, without touching the set.
 * Everything here is git in the SOURCE clone (`git worktree add`) and answers with the folder to open: the set file and
 * the workspace file of the set are never read or written by this module. No vscode.
 */
export type GitRun = (cwd: string, args: string[]) => Promise<string>;

/** The line of git's stderr that says what went wrong: the first fatal or error line, else the first line (progress lines such as `From <url>` come first). */
export const gitErrorLine = (stderr: string): string => {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /^(fatal|error|remote: error):/i.test(l)) ?? lines[0] ?? "";
};

export const gitRun: GitRun = (cwd, args) =>
  new Promise((resolve, reject) =>
    execFile("git", args, { cwd, timeout: 60_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out, stderr) => (err ? reject(new Error(gitErrorLine(String(stderr)) || err.message)) : resolve(String(out)))),
  );

export interface WorktreeAt {
  path: string;
  branch?: string;
  main: boolean;
}

export async function worktreesOf(git: GitRun, dir: string): Promise<WorktreeAt[]> {
  const out = (await git(dir, ["worktree", "list", "--porcelain"])).replace(/\r\n/g, "\n");
  const list: WorktreeAt[] = [];
  for (const block of out.split(/\n\n+/)) {
    let path = "";
    let branch: string | undefined;
    for (const l of block.split("\n")) {
      if (l.startsWith("worktree ")) path = l.slice(9);
      else if (l.startsWith("branch ")) branch = l.slice(7).replace(/^refs\/heads\//, "");
    }
    if (path) list.push({ path: resolve(path), branch, main: list.length === 0 });
  }
  return list;
}

export interface RepoBranches {
  /** every branch name once, newest commit first */
  all: string[];
  local: Set<string>;
  remote: Set<string>;
}

export async function branchesOf(git: GitRun, dir: string): Promise<RepoBranches> {
  const out = await git(dir, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)", "refs/heads", "refs/remotes/origin"]);
  const res: RepoBranches = { all: [], local: new Set(), remote: new Set() };
  for (const ref of out.split(/\r?\n/).filter(Boolean)) {
    const isLocal = ref.startsWith("refs/heads/");
    const name = ref.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/origin\//, "");
    if (name === "HEAD") continue;
    (isLocal ? res.local : res.remote).add(name);
    if (!res.all.includes(name)) res.all.push(name);
  }
  return res;
}

/** The folder of a separate worktree of a repository: the rule of the Worktree Sets for a loose worktree (`<clone>-worktrees/<branch slug>`, or `<root>/<slug>/<repo>` with a worktree root). */
export const looseWorktreePath = (source: string, branch: string, worktreeRoot = ""): string => worktreePath({ name: basename(source), path: source, root: dirname(source) }, branch, worktreeRoot);

/** The suggested name of a copy: the next numbered story branch in a story set, else `<current>-copy`. */
export function copyName(current: string, nextStory: string | undefined, taken: Set<string>): string {
  if (nextStory) return nextStory;
  let name = `${current}-copy`;
  for (let i = 2; taken.has(name); i++) name = `${current}-copy-${i}`;
  return name;
}

export interface PickItemModel {
  kind: "new" | "branch" | "same";
  label: string;
  description: string;
  branch?: string;
  separator?: string;
}

/** The rows of the pick: a new branch (preselected), the story's branches, the others, and the same folder last. */
export function ownWindowItems(o: { current: string; storyBranches: string[]; branches: string[]; worktrees: WorktreeAt[]; uncommitted?: number }): PickItemModel[] {
  const where = new Map(o.worktrees.filter((w) => w.branch).map((w) => [w.branch!, w.path]));
  const row = (b: string): PickItemModel => ({ kind: "branch", label: b, description: where.has(b) ? `has a worktree: ${where.get(b)}` : "own worktree outside the set", branch: b });
  const story = o.storyBranches.filter((b) => b !== o.current && o.branches.includes(b));
  const rest = o.branches.filter((b) => b !== o.current && !story.includes(b));
  const items: PickItemModel[] = [
    { kind: "new", label: `New branch from ${o.current}...`, description: `a separate copy, not linked to the story, not pushed${o.uncommitted ? `; ${o.uncommitted} uncommitted file${o.uncommitted === 1 ? "" : "s"} stay in the set` : ""}` },
  ];
  if (story.length) items.push({ kind: "branch", label: "Story branches", description: "", separator: "Story branches" }, ...story.map(row));
  if (rest.length) items.push({ kind: "branch", label: "Other branches", description: "", separator: "Other branches" }, ...rest.map(row));
  items.push({ kind: "same", label: `Same folder, this branch (${o.current})`, description: "the same files as in the set" });
  return items;
}

export interface OwnResult {
  path: string;
  /** what was done, one line for the log */
  note: string;
}

/**
 * Where the new window opens. `same`: the set's own folder. `branch`: the worktree that has it (anywhere), else a new
 * worktree outside the set. `newBranch`: a worktree outside the set on a new branch that starts at the HEAD commit of
 * the set's worktree (uncommitted work stays in the set); never linked to the story, never pushed.
 */
export async function openOwn(o: { git: GitRun; source: string; setPath: string; current: string; branch?: string; newBranch?: string; worktreeRoot?: string }): Promise<OwnResult> {
  const { git } = o;
  const dir = existsSync(o.source) ? o.source : o.setPath;
  if (!o.newBranch && (!o.branch || o.branch === o.current)) return { path: o.setPath, note: "same folder" };
  if (o.newBranch) {
    const name = o.newBranch.trim();
    await git(dir, ["check-ref-format", "--branch", name]).catch(() => {
      throw new Error(`'${name}' is not a valid branch name`);
    });
    const known = await branchesOf(git, dir);
    if (known.local.has(name)) throw new Error(`the branch ${name} exists already`);
    const target = looseWorktreePath(o.source, name, o.worktreeRoot);
    if (existsSync(target)) throw new Error(`${target} exists already; nothing was created`);
    const tip = (await git(o.setPath, ["rev-parse", "HEAD"])).trim();
    await git(dir, ["worktree", "add", "--no-track", "-b", name, target, tip]);
    return { path: target, note: `new branch ${name} from ${tip.slice(0, 7)} in ${target}` };
  }
  const branch = o.branch!;
  const has = (await worktreesOf(git, dir)).find((w) => w.branch === branch);
  if (has) return { path: has.path, note: `${branch} has a worktree: ${has.path}` };
  const known = await branchesOf(git, dir);
  const target = looseWorktreePath(o.source, branch, o.worktreeRoot);
  if (existsSync(target)) throw new Error(`${target} exists already and is not a worktree of ${branch}; nothing was created`);
  if (known.local.has(branch)) await git(dir, ["worktree", "add", target, branch]);
  else if (known.remote.has(branch)) await git(dir, ["worktree", "add", "--track", "-b", branch, target, `origin/${branch}`]);
  else throw new Error(`the branch ${branch} does not exist in ${basename(o.source)}`);
  return { path: target, note: `worktree of ${branch} made in ${target}` };
}
