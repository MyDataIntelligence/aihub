import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { headBranchOf } from "../../../cli/src/lib/machineScan";
import { AIHUB_SET, MAKER_SET, readSetFile } from "../../../cli/src/lib/setFile";
import { gitCommonDir } from "../../../cli/src/lib/storyWorktrees";
import { guardLocalFiles, inventoryIgnored, localFilesProblem } from "../../../cli/src/lib/localFiles";
import { headSha, operationInProgress } from "./behind";
import { branchesOf, worktreesOf, type GitRun } from "./ownWindow";

/**
 * Undo for the actions that change a set (switch, move, reuse, recreate, add, drop, remove set): a snapshot before the
 * action, and afterwards one plan that puts the branch of each repository, the worktree folders, the set file and the
 * workspace file back. The plan is checked first (nothing uncommitted since, the places are free): when it cannot be
 * done it says why in one sentence and does nothing. No vscode here.
 */
export interface SnapRepo {
  name: string;
  source: string;
  path: string;
  /** the checked-out branch; undefined when it was detached */
  branch?: string;
  head: string;
}

export interface Snapshot {
  label: string;
  setFolder: string;
  files: { path: string; bytes?: Buffer }[];
  repos: SnapRepo[];
  /** local branches per source clone: name -> commit */
  branches: Map<string, Map<string, string>>;
  /** names in `<git dir>/aihub/backup` per source clone before the action */
  backups: Map<string, string[]>;
  /** clones noted without a set member (a set that did not exist yet) */
  sources?: string[];
  /** what the set looked like right after the action: Undo only goes back when it still looks like this */
  after?: Stamp;
  /** the local branches the action itself made, per clone (worked out right after it); only these are deleted by Undo */
  created?: Map<string, string[]>;
}

/** The set as it is: the hash of every set file and workspace file, and where each worktree's HEAD is. Files only. */
export interface Stamp {
  files: Record<string, string | null>;
  heads: Record<string, string | null>;
}

const sha = (b: Buffer) => createHash("sha1").update(b).digest("hex");

/** The local branches of a clone, read from its refs (loose and packed): name -> commit. No process. */
export function localBranches(source: string): Map<string, string> {
  const out = new Map<string, string>();
  const common = gitCommonDir(source);
  if (!common) return out;
  const walk = (dir: string, prefix: string) => {
    for (const e of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) {
      if (e.isDirectory()) walk(join(dir, e.name), `${prefix}${e.name}/`);
      else if (!e.name.endsWith(".lock")) out.set(`${prefix}${e.name}`, readFileSync(join(dir, e.name), "utf8").trim());
    }
  };
  walk(join(common, "refs", "heads"), "");
  try {
    for (const l of readFileSync(join(common, "packed-refs"), "utf8").split(/\r?\n/)) {
      const m = /^([0-9a-f]{40,64}) refs\/heads\/(.+)$/.exec(l.trim());
      if (m && !out.has(m[2])) out.set(m[2], m[1]);
    }
  } catch {
    /* no packed refs */
  }
  return out;
}

/** What the set looks like now (see Stamp). */
export function stampOf(s: Pick<Snapshot, "setFolder" | "files" | "repos">): Stamp {
  const files: Record<string, string | null> = {};
  const paths = new Map<string, string>();
  for (const f of [...s.files, ...(s.setFolder ? setFilesOf(s.setFolder) : [])]) paths.set(key(f.path), f.path);
  for (const [k, p] of paths) files[k] = existsSync(p) ? sha(readFileSync(p)) : null;
  const heads: Record<string, string | null> = {};
  const dirs = new Map<string, string>();
  for (const r of s.repos) dirs.set(key(r.path), r.path);
  const f = s.setFolder ? readSetFile(s.setFolder) : undefined;
  for (const m of f ? [f.top, ...(f.top.others ?? [])] : []) for (const r of m.repos) dirs.set(key(r.path), r.path);
  for (const [k, p] of dirs) heads[k] = existsSync(join(p, ".git")) ? `${headBranchOf(p)}@${headSha(p)}` : null;
  return { files, heads };
}

const sameStamp = (a: Stamp, b: Stamp) => JSON.stringify(a) === JSON.stringify(b);

/** Call right after the action: notes how the set looks and which branches the action made. */
export function finishSnapshot(s: Snapshot): Snapshot {
  s.after = stampOf(s);
  s.created = new Map();
  for (const [src, before] of s.branches) {
    const made = [...localBranches(src).keys()].filter((b) => !before.has(b));
    if (made.length) s.created.set(src, made);
  }
  return s;
}


const key = (p: string) => resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const slug = (b: string) => b.replace(/[\\/:*?"<>|\s]+/g, "-");
const backupDir = (source: string) => {
  const common = gitCommonDir(source);
  return common ? join(common, "aihub", "backup") : undefined;
};
const listDir = (d: string | undefined): string[] => {
  try {
    return d && existsSync(d) ? readdirSync(d) : [];
  } catch {
    return [];
  }
};

/** The set files and the workspace files of a set folder, as they are now (bytes, or absent). */
function setFilesOf(folder: string): { path: string; bytes?: Buffer }[] {
  const paths = new Set<string>([join(folder, AIHUB_SET), join(folder, MAKER_SET)]);
  const f = readSetFile(folder);
  for (const m of f ? [f.top, ...(f.top.others ?? [])] : []) if (m.workspace) paths.add(m.workspace);
  for (const n of listDir(folder)) if (n.endsWith(".code-workspace")) paths.add(join(folder, n));
  return [...paths].map((p) => ({ path: p, ...(existsSync(p) ? { bytes: readFileSync(p) } : {}) }));
}

/**
 * `sources`: clones whose worktrees and branches are noted although no set member lives there yet (Open Story, which makes
 * the set); `files`: what a file was before something outside this action changed it (a set file edited by hand).
 * An empty `setFolder` is a set that does not exist yet.
 */
export async function takeSnapshot(git: GitRun, setFolder: string, label: string, o: { sources?: string[]; files?: { path: string; bytes?: Buffer }[] } = {}): Promise<Snapshot> {
  const file = setFolder ? readSetFile(setFolder) : undefined;
  const seen = new Set<string>();
  const repos: SnapRepo[] = [];
  for (const m of file ? [file.top, ...(file.top.others ?? [])] : []) {
    for (const r of m.repos) {
      if (seen.has(key(r.path)) || !existsSync(join(r.path, ".git"))) continue;
      seen.add(key(r.path));
      // the commit comes from the files (no process); git only when the files cannot say
      const head = headSha(r.path) ?? (await git(r.path, ["rev-parse", "HEAD"]).then((o) => o.trim(), () => ""));
      repos.push({ name: r.name, source: r.source, path: r.path, branch: headBranchOf(r.path) || undefined, head });
    }
  }
  const branches = new Map<string, Map<string, string>>();
  const backups = new Map<string, string[]>();
  for (const src of new Set([...repos.map((r) => r.source), ...(o.sources ?? [])].filter((s) => existsSync(s)))) {
    // every other worktree of these clones (one the action may move, recreate or reuse): put back like a member of the set
    for (const w of await worktreesOf(git, src).catch(() => [])) {
      if (w.main || seen.has(key(w.path))) continue;
      seen.add(key(w.path));
      repos.push({ name: basename(w.path), source: src, path: w.path, branch: w.branch, head: w.head ?? "" });
    }
    branches.set(src, localBranches(src));
    backups.set(src, listDir(backupDir(src)));
  }
  const files = setFolder ? setFilesOf(setFolder) : [];
  for (const f of o.files ?? []) {
    const i = files.findIndex((x) => key(x.path) === key(f.path));
    if (i >= 0) files[i] = f;
    else files.push(f);
  }
  return { label, setFolder, files, repos, branches, backups, sources: [...(o.sources ?? [])] };
}

export interface UndoPlan {
  /** one sentence when it cannot be undone; then nothing is done */
  problem?: string;
  /** run may answer one more line (where something was saved) */
  steps: { what: string; run: () => Promise<void | string> }[];
}

const copyBack = (from: string, to: string): number => {
  let n = 0;
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const a = join(from, e.name);
    const b = join(to, e.name);
    if (e.isDirectory()) n += copyBack(a, b);
    else if (!existsSync(b)) {
      mkdirSync(dirname(b), { recursive: true });
      copyFileSync(a, b);
      n++;
    }
  }
  return n;
};

/** New backup folders and patches since the snapshot, per source clone. */
export function newBackups(s: Snapshot): { dir: string; names: string[] }[] {
  return [...s.backups].map(([src, before]) => ({ dir: backupDir(src) ?? "", names: listDir(backupDir(src)).filter((n) => !before.includes(n)) })).filter((b) => b.dir && b.names.length);
}

/** Works out what puts the set back as it was at the snapshot; nothing is changed here. */
export async function planUndo(git: GitRun, s: Snapshot): Promise<UndoPlan> {
  const steps: UndoPlan["steps"] = [];
  // order: switch back, take out what was added, then put back what is missing (a branch cannot be checked out twice), branches, files
  const removes: UndoPlan["steps"] = [];
  const restores: UndoPlan["steps"] = [];
  const movedFrom = new Set<string>();
  const nothing = (problem: string): UndoPlan => ({ problem, steps: [] });
  const sources = [...new Set([...s.repos.map((r) => r.source), ...(s.sources ?? [])])].filter((x) => existsSync(x));
  const now = new Map<string, Awaited<ReturnType<typeof worktreesOf>>>();
  for (const src of sources) now.set(src, await worktreesOf(git, src).catch(() => []));
  // Undo only goes back to a set that still looks like it did right after the action (another window, a hand edit, a commit since)
  if (s.after && !sameStamp(s.after, stampOf(s))) return nothing("the set changed since this action, in another window or by hand");
  const clean = async (p: string) => (await git(p, ["status", "--porcelain", "--untracked-files=no"]).catch(() => "x")).trim() === "";

  for (const r of s.repos) {
    const busy = existsSync(r.path) ? operationInProgress(r.path) : undefined;
    if (busy) return nothing(`${busy} is in progress in ${r.name}; finish or abort it first`);
  }
  for (const r of s.repos) {
    const list = now.get(r.source) ?? [];
    const here = list.find((w) => key(w.path) === key(r.path));
    if (here && existsSync(r.path)) {
      if ((here.branch ?? undefined) === r.branch) continue;
      if (!(await clean(r.path))) return nothing(`${r.name} has uncommitted changes since; commit or stash them, then undo`);
      const elsewhere = r.branch ? list.find((w) => w.branch === r.branch && key(w.path) !== key(r.path)) : undefined;
      if (elsewhere) return nothing(`${r.branch} is checked out in ${elsewhere.path} now; ${r.name} cannot go back to it`);
      steps.push({ what: `${r.name} back on ${r.branch ?? r.head.slice(0, 7)}`, run: async () => void (await git(r.path, r.branch ? ["switch", r.branch] : ["switch", "--detach", r.head])) });
      continue;
    }
    // the folder is gone: moved elsewhere (the same branch has a worktree at another path) or removed
    if (existsSync(r.path) && readdirSync(r.path).length) return nothing(`${r.path} is not empty now; ${r.name} cannot be put back there`);
    // a recreate saved this worktree's work (a patch, a folder of ignored files) and made a new one on the same branch: that is no move
    const dir = backupDir(r.source);
    const fresh = listDir(dir).filter((n) => !(s.backups.get(r.source) ?? []).includes(n));
    const saved = fresh.some((n) => n.startsWith(`${basename(r.path).replace(/[\\/:*?"<>|\s]+/g, "-")}-`) || (!!r.branch && n.startsWith(`${slug(r.branch)}-`) && n.endsWith(".patch")));
    const moved = r.branch && !saved ? list.find((w) => w.branch === r.branch && !w.main && key(w.path) !== key(r.path)) : undefined;
    if (moved) {
      movedFrom.add(key(moved.path));
      restores.push({ what: `${r.name} moved back to ${r.path}`, run: async () => (mkdirSync(dirname(r.path), { recursive: true }), void (await git(r.source, ["worktree", "move", moved.path, r.path]))) });
      continue;
    }
    const known = await branchesOf(git, r.source).catch(() => undefined);
    const branchExists = !!r.branch && !!known?.local.has(r.branch);
    if (r.branch && !branchExists && !r.head) return nothing(`${r.name}: the branch ${r.branch} is gone`);
    restores.push({
      what: `${r.name} made again at ${r.path}`,
      run: async () => {
        mkdirSync(dirname(r.path), { recursive: true });
        await git(r.source, ["worktree", "prune"]).catch(() => undefined);
        if (r.branch && branchExists) await git(r.source, ["worktree", "add", r.path, r.branch]);
        else if (r.branch) await git(r.source, ["worktree", "add", "-b", r.branch, r.path, r.head]);
        else await git(r.source, ["worktree", "add", "--detach", r.path, r.head]);
        // what the action saved of this worktree comes back: ignored files, then the patch of uncommitted work
        const dir = backupDir(r.source);
        const before = s.backups.get(r.source) ?? [];
        for (const n of listDir(dir).filter((x) => !before.includes(x))) {
          const p = join(dir!, n);
          if (statSync(p).isDirectory() && n.startsWith(`${basename(r.path).replace(/[\\/:*?"<>|\s]+/g, "-")}-`)) copyBack(p, r.path);
          else if (n.endsWith(".patch") && r.branch && n.startsWith(`${slug(r.branch)}-`)) await git(r.path, ["apply", p]).catch(() => undefined);
        }
      },
    });
  }

  // worktrees the action added to the set folder
  for (const src of sources) {
    for (const w of now.get(src) ?? []) {
      if (w.main || !key(w.path).startsWith(key(s.setFolder) + "/")) continue;
      if (s.repos.some((r) => key(r.path) === key(w.path)) || movedFrom.has(key(w.path))) continue;
      if (!(await clean(w.path))) return nothing(`${basename(w.path)} has uncommitted changes since; commit or stash them, then undo`);
      // new files that git does not ignore would stop the removal: said now, not half way
      if ((await git(w.path, ["status", "--porcelain"]).catch(() => "x")).trim() !== "") return nothing(`${basename(w.path)} has new files since; commit or remove them, then undo`);
      // ignored local files (.env, notes) are saved first, by the rule of a removal (BUILD_NAMES, limits); too much: nothing is done
      const tooMuch = localFilesProblem(inventoryIgnored(w.path));
      if (tooMuch) return nothing(`${basename(w.path)} holds ${tooMuch}; move them away, then undo`);
      removes.push({
        what: `${basename(w.path)} taken out again`,
        run: async () => {
          const saved = guardLocalFiles(w.path, src);
          if (!saved.ok) throw new Error(saved.note);
          await git(src, ["worktree", "remove", w.path]);
          return saved.note || undefined;
        },
      });
    }
  }

  // a branch the ACTION made (noted right after it) that has commits since: nothing is done, said before anything changes
  const madeBranches = [...(s.created ?? new Map<string, string[]>())].flatMap(([src, list]) => list.filter((b) => existsSync(src)).map((b) => ({ src, b })));
  const unique = async (src: string, b: string) => Number((await git(src, ["rev-list", "--count", b, "--not", `--exclude=${b}`, "--branches", "--remotes"]).catch(() => "1")).trim());
  for (const { src, b } of madeBranches) if (localBranches(src).has(b) && (await unique(src, b)) > 0) return nothing(`${b} has commits of its own since; they would be lost`);

  // only the branches the action made, and only while nothing is committed on them
  const dropBranches = async () => {
    for (const { src, b } of madeBranches) if (localBranches(src).has(b) && (await unique(src, b)) === 0) await git(src, ["branch", "-D", b]).catch(() => undefined);
  };
  steps.push(...removes, ...restores);
  steps.push({ what: "the branches the action made are gone again", run: dropBranches });

  steps.push({
    what: "the set file and the workspace file are as they were",
    run: async () => {
      for (const f of setFilesOf(s.setFolder).map((x) => x.path).concat(s.files.map((x) => x.path))) {
        const was = s.files.find((x) => key(x.path) === key(f));
        if (was?.bytes) {
          mkdirSync(dirname(f), { recursive: true });
          writeAtomicBytes(f, was.bytes);
        } else if (!was?.bytes && existsSync(f)) rmSync(f, { force: true });
      }
      // a set that did not exist before: its folder goes too, when nothing else is in it
      if (s.setFolder && s.files.every((x) => !x.bytes) && existsSync(s.setFolder) && !readdirSync(s.setFolder).length) rmdirSync(s.setFolder);
    },
  });
  return { steps };
}

function writeAtomicBytes(path: string, bytes: Buffer): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, bytes);
  // a rename that Windows refuses for a moment is tried again; after that the error stays (never a write in place: half a file)
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (e) {
      if (i >= 4 || !/^(EPERM|EBUSY|EACCES)$/.test(String((e as NodeJS.ErrnoException).code))) {
        rmSync(tmp, { force: true });
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (i + 1));
    }
  }
}

/** Does it: the steps in order. Returns what was done, one line per step; a step that fails ends the run and says which. */
export async function runUndo(p: UndoPlan): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  for (let i = 0; i < p.steps.length; i++) {
    const st = p.steps[i];
    try {
      const extra = await st.run();
      lines.push(extra ? `${st.what} (${extra})` : st.what);
    } catch (e) {
      // not rolled back (a half undone set is better described than guessed at): what was done and what was not
      const left = p.steps.slice(i + 1).map((x) => x.what);
      return { ok: false, lines: [...lines, `stopped at "${st.what}": ${(e as Error).message}`, ...(left.length ? [`not done: ${left.join("; ")}`] : [])] };
    }
  }
  return { ok: true, lines };
}
