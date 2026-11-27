import { closeSync, copyFileSync, existsSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { storyIdFromBranch } from "./storyWorktrees.js";

/**
 * The two set files a set folder can hold, read and written here only (no git, no process):
 * - `.aihub-set.json`: written by `aihub worktree create|open` and `aihub story open`;
 * - `.worktree-set.json` (schema 1): written by the Worktree Sets of the VS Code extension (and the older Worktree
 *   Maker). Paths inside the set folder are relative there; `repos[].branch` only when it differs from the set's branch.
 * Both keep their field names; a repository's own branch is the optional `repos[].branch`, else the set's `branch`.
 */
export const AIHUB_SET = ".aihub-set.json";
export const MAKER_SET = ".worktree-set.json";
export type SetKind = "aihub" | "maker";

export interface SetRepo {
  name: string;
  source: string;
  path: string;
  /** this repository's branch when it is not the set's branch (one repository switched, or `--branch-for`) */
  branch?: string;
}

export interface SetMeta {
  story: number;
  /** the story's title when it was known, so a label needs no read of Azure DevOps (optional; written by the extension) */
  storyTitle?: string;
  /** repo group name when `aihub worktree open` made the set (story is 0 then) */
  group?: string;
  /** the .code-workspace file of the set; removed with the set */
  workspace?: string;
  branch: string;
  repos: SetRepo[];
  /** the other sets in the same folder (a story folder holds one set per branch); newest is the top one */
  others?: SetMeta[];
}

/**
 * The text of a JSON file as an editor or PowerShell may have saved it: UTF-8 with or without a BOM, or UTF-16 (what
 * `>` and `Out-File` write in Windows PowerShell 5). A set file edited by hand must stay readable.
 */
export function readJsonText(path: string): string {
  const b = readFileSync(path);
  if (b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString("utf16le");
  if (b[0] === 0xfe && b[1] === 0xff) return Buffer.from(b.subarray(2)).swap16().toString("utf16le");
  return b.toString("utf8").replace(/^\uFEFF/, "");
}

/**
 * Writes a file so that a reader (the extension's set-file watcher, another window, `aihub`) never sees half of it and
 * a crash leaves the old file, not an empty one: a temporary file in the same folder, then a rename. The rename can
 * be refused for a moment on Windows (a scanner or watcher has the file open): it is tried again, and as a last resort
 * the file is written in place.
 */
export function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, "utf8");
    for (let i = 0; ; i++) {
      try {
        renameSync(tmp, path);
        return;
      } catch (e) {
        if (i >= 4 || !/^(EPERM|EBUSY|EACCES)$/.test(String((e as NodeJS.ErrnoException).code))) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (i + 1));
      }
    }
  } catch (e) {
    // never half a file: the error is the answer and the old file stays as it was
    rmSync(tmp, { force: true });
    throw e;
  }
}

export const repoBranch =(meta: Pick<SetMeta, "branch">, r: Pick<SetRepo, "branch">): string => r.branch || meta.branch;

/** The set file of `folder` (`.aihub-set.json` first), in the shape of SetMeta; undefined when there is none or it is broken. */
/**
 * A set file in an older or hand-written form, as it is read: `story` as `{ id, title }` (or a string) becomes the number,
 * with the title as `storyTitle`; a missing `branch` is the branch of the first repository that names one. Never "#[object
 * Object]" or "on undefined" in a label.
 */
export function normalizeMeta(m: SetMeta): SetMeta {
  const s = m.story as unknown;
  if (s && typeof s === "object") {
    const o = s as { id?: unknown; title?: unknown };
    m.story = Number(o.id) > 0 ? Number(o.id) : 0;
    if (!m.storyTitle && typeof o.title === "string" && o.title) m.storyTitle = o.title;
  } else if (typeof s !== "number") m.story = Number(s) > 0 ? Number(s) : 0;
  if (typeof m.branch !== "string" || !m.branch) m.branch = m.repos.find((r) => typeof r.branch === "string" && r.branch)?.branch ?? "";
  return m;
}

export function readSetFile(folder: string): { kind: SetKind; top: SetMeta } | undefined {
  try {
    if (existsSync(join(folder, AIHUB_SET))) {
      const top = JSON.parse(readJsonText(join(folder, AIHUB_SET))) as SetMeta;
      if (!Array.isArray(top?.repos)) return undefined;
      top.repos = completeRepos(folder, top.repos as Partial<SetRepo>[]);
      normalizeMeta(top);
      for (const o of top.others ?? []) if (o && Array.isArray(o.repos)) normalizeMeta(o);
      return { kind: "aihub", top };
    }
    if (existsSync(join(folder, MAKER_SET))) {
      const j = JSON.parse(readJsonText(join(folder, MAKER_SET))) as { branch?: unknown; slug?: unknown; repos?: unknown };
      if (typeof j.branch !== "string" || !Array.isArray(j.repos)) return undefined;
      const repos = completeRepos(folder, j.repos as Partial<SetRepo>[]);
      const slug = typeof j.slug === "string" && j.slug ? j.slug : j.branch.replace(/[\\/:*?"<>|\s]+/g, "-");
      return { kind: "maker", top: { story: storyIdFromBranch(j.branch) ?? 0, branch: j.branch, workspace: join(folder, `${slug}.code-workspace`), repos } };
    }
  } catch {
    /* a broken set file is no set */
  }
  return undefined;
}

/**
 * The repositories of a set file, also one added by hand with only a name: its folder is `<set>/<name>`, its source
 * clone sits next to the other sources. Such an entry has no worktree yet; `aihub worktree repair` makes it.
 */
function completeRepos(folder: string, raw: Partial<SetRepo>[]): SetRepo[] {
  const ok = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
  const sibling = raw.find((r) => ok(r?.source))?.source;
  const out: SetRepo[] = [];
  for (const r of raw) {
    if (!r || !ok(r.name)) continue;
    const source = ok(r.source) ? r.source : sibling ? join(dirname(sibling), r.name) : undefined;
    if (!source) continue;
    out.push({ name: r.name, source, path: resolve(folder, ok(r.path) ? r.path : r.name), ...(ok(r.branch) ? { branch: r.branch } : {}) });
  }
  return out;
}

const LOCK = ".aihub-set.lock";
const held = new Set<string>();

/**
 * One writer at a time for the set files of a folder, across processes (the extension of every window and the CLI): a lock
 * file created exclusively next to them. A lock older than 10 seconds is a crashed writer and is taken over. Re-entrant
 * within this process. A folder that cannot hold the lock file (not there yet, read-only) runs without it; the write then
 * says what is wrong.
 */
export function withSetLock<T>(folder: string, fn: () => T): T {
  const k = resolve(folder).toLowerCase();
  if (held.has(k)) return fn();
  const p = join(folder, LOCK);
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      const fd = openSync(p, "wx");
      writeSync(fd, `${process.pid} ${Date.now()}`);
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return fn();
      try {
        if (Date.now() - statSync(p).mtimeMs > 10_000) {
          rmSync(p, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new Error("the set file is being written by another window; try again in a moment");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  held.add(k);
  try {
    return fn();
  } finally {
    held.delete(k);
    rmSync(p, { force: true });
  }
}

/**
 * Changes the branch of ONE repository inside its own set, and nothing else: the other sets of the folder stay where they are
 * (writeSetMeta would move the one it writes to the top), the order and the unknown fields stay. True when something changed.
 */
export function setRepoBranchInPlace(folder: string, repoPath: string, branch: string): boolean {
  return withSetLock(folder, () => {
    const found = readSetFile(folder);
    if (!found) return false;
    const same = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
    if (found.kind === "maker") {
      const entry = found.top.repos.find((r) => same(r.path, repoPath));
      if (!entry || repoBranch(found.top, entry) === branch) return false;
      writeSetFile(folder, "maker", { ...found.top, repos: found.top.repos.map((r) => (r === entry ? { ...r, branch } : r)) });
      return true;
    }
    const top = JSON.parse(readJsonText(join(folder, AIHUB_SET))) as SetMeta;
    for (const m of [top, ...(top.others ?? [])]) {
      const r = (m.repos as { path?: string; branch?: string }[]).find((x) => typeof x.path === "string" && same(resolve(folder, x.path), repoPath));
      if (!r) continue;
      if ((r.branch || m.branch) === branch) return false;
      if (branch === m.branch) delete r.branch;
      else r.branch = branch;
      writeAtomic(join(folder, AIHUB_SET), JSON.stringify(top, null, 2));
      return true;
    }
    return false;
  });
}

/** Points ONE repository of its own set at another source clone (it was moved or deleted); nothing else in the file changes. True when something changed. */
export function setRepoSourceInPlace(folder: string, repoPath: string, source: string): boolean {
  return withSetLock(folder, () => {
    if (!existsSync(join(folder, AIHUB_SET))) return false;
    const same = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
    const top = JSON.parse(readJsonText(join(folder, AIHUB_SET))) as SetMeta;
    for (const m of [top, ...(top.others ?? [])]) {
      const r = (m.repos as { path?: string; source?: string }[]).find((x) => typeof x.path === "string" && same(resolve(folder, x.path), repoPath));
      if (!r) continue;
      if (r.source && same(r.source, source)) return false;
      r.source = source;
      writeAtomic(join(folder, AIHUB_SET), JSON.stringify(top, null, 2));
      return true;
    }
    return false;
  });
}

/** Writes `meta` back into the set file of its kind; `.aihub-set.json` keeps the other sets of the folder. */
export function writeSetFile(folder: string, kind: SetKind, meta: SetMeta): void {
  return withSetLock(folder, () => writeSetFileLocked(folder, kind, meta));
}

function writeSetFileLocked(folder: string, kind: SetKind, meta: SetMeta): void {
  const repos = meta.repos.map((r) => ({ ...r, branch: r.branch && r.branch !== meta.branch ? r.branch : undefined }));
  if (kind === "aihub") return writeSetMetaLocked(folder, { ...meta, repos });
  const p = join(folder, MAKER_SET);
  const raw = JSON.parse(readJsonText(p)) as Record<string, unknown> & { repos?: Record<string, unknown>[] };
  const old = new Map((raw.repos ?? []).map((r) => [String(r.name), r]));
  const rel = (x: string) => {
    const r = relative(folder, x);
    return r && !r.startsWith("..") && !/^[A-Za-z]:/.test(r) && !r.startsWith("/") ? r.split("\\").join("/") : resolve(x);
  };
  raw.repos = [...repos]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => {
      const base = old.get(r.name)?.base;
      return { name: r.name, source: r.source, path: rel(r.path), ...(r.branch ? { branch: r.branch } : {}), ...(typeof base === "string" ? { base } : {}) };
    });
  raw.updatedAt = new Date().toISOString();
  writeAtomic(p, JSON.stringify(raw, null, 2) + "\n");
}

/**
 * Saves a set a command just made: into the extension's `.worktree-set.json` when the folder holds one for the same
 * branch (its other repositories stay, the new ones are added), else as the newest set of `.aihub-set.json`. A folder
 * never gets a second set file for the same set: `readSetFile` would show only one of the two.
 */
export function saveSetMeta(folder: string, meta: SetMeta): void {
  const have = existsSync(join(folder, AIHUB_SET)) ? undefined : readSetFile(folder);
  if (have?.kind === "maker" && have.top.branch === meta.branch) {
    const byName = new Map(have.top.repos.map((r) => [r.name, r]));
    for (const r of meta.repos) byName.set(r.name, r);
    return writeSetFile(folder, "maker", { ...have.top, repos: [...byName.values()] });
  }
  writeSetMeta(folder, meta);
}

/** Writes `meta` as the newest set of `folder`, keeping the other sets there (one per story and branch). */
export function writeSetMeta(folder: string, meta: SetMeta): void {
  return withSetLock(folder, () => writeSetMetaLocked(folder, meta));
}

function writeSetMetaLocked(folder: string, meta: SetMeta): void {
  const p = join(folder, AIHUB_SET);
  let old: SetMeta[] = [];
  if (existsSync(p)) {
    try {
      const top = JSON.parse(readJsonText(p)) as SetMeta;
      old = [{ ...top, others: undefined }, ...(top.others ?? [])];
    } catch {
      // a set file that cannot be read (broken by hand) is never overwritten unseen: its text is kept next to it
      try {
        copyFileSync(p, `${p}.broken-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-")}`);
      } catch {
        /* a read-only folder: the write below fails the same way */
      }
    }
  }
  const same = (a: SetMeta) => a.story === meta.story && a.branch === meta.branch && (a.group ?? "") === (meta.group ?? "");
  const others = old.filter((s) => !same(s)).map(({ others: _o, ...s }) => s);
  writeAtomic(p, JSON.stringify({ ...meta, ...(others.length ? { others } : {}) }, null, 2));
}

/** Writes the story title into `.aihub-set.json` for the set of `story` (only when it is new or changed; no file, no write). */
export function stampStoryTitle(folder: string, story: number, title: string): void {
  const p = join(folder, AIHUB_SET);
  if (!story || !title || !existsSync(p)) return;
  try {
    withSetLock(folder, () => {
      const top = JSON.parse(readJsonText(p)) as SetMeta;
      const sets = [top, ...(top.others ?? [])];
      let changed = false;
      for (const m of sets) if (m.story === story && m.storyTitle !== title) (m.storyTitle = title), (changed = true);
      if (changed) writeAtomic(p, JSON.stringify(top, null, 2));
    });
  } catch {
    /* a broken set file is reported elsewhere */
  }
}
