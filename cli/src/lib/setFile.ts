import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  } catch {
    rmSync(tmp, { force: true });
    writeFileSync(path, text, "utf8");
  }
}

export const repoBranch =(meta: Pick<SetMeta, "branch">, r: Pick<SetRepo, "branch">): string => r.branch || meta.branch;

/** The set file of `folder` (`.aihub-set.json` first), in the shape of SetMeta; undefined when there is none or it is broken. */
export function readSetFile(folder: string): { kind: SetKind; top: SetMeta } | undefined {
  try {
    if (existsSync(join(folder, AIHUB_SET))) {
      const top = JSON.parse(readJsonText(join(folder, AIHUB_SET))) as SetMeta;
      if (!Array.isArray(top?.repos)) return undefined;
      top.repos = completeRepos(folder, top.repos as Partial<SetRepo>[]);
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

/** Writes `meta` back into the set file of its kind; `.aihub-set.json` keeps the other sets of the folder. */
export function writeSetFile(folder: string, kind: SetKind, meta: SetMeta): void {
  const repos = meta.repos.map((r) => ({ ...r, branch: r.branch && r.branch !== meta.branch ? r.branch : undefined }));
  if (kind === "aihub") return writeSetMeta(folder, { ...meta, repos });
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
    const top = JSON.parse(readJsonText(p)) as SetMeta;
    const sets = [top, ...(top.others ?? [])];
    let changed = false;
    for (const m of sets) if (m.story === story && m.storyTitle !== title) (m.storyTitle = title), (changed = true);
    if (changed) writeAtomic(p, JSON.stringify(top, null, 2));
  } catch {
    /* a broken set file is reported elsewhere */
  }
}
