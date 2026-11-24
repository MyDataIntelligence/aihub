import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { listWorktrees, refSha, samePath, tryGit } from "./gitx.js";

/**
 * Removing and moving a worktree without losing work. Shared by `aihub story branches remove|place` and the worktree
 * clean-up: local work is never thrown away (no --force anywhere), and directory links (Windows junctions such as a
 * node_modules linked to another worktree) are taken out first, because `git worktree remove` would follow them and
 * empty the folder they point to.
 */

export interface DirLink {
  /** path of the link, relative to the worktree */
  rel: string;
  target: string;
}

const SKIP = new Set([".git"]);

/** Directory links (junctions, symlinks) in the top `depth` levels of `dir`; links are not followed. */
export function findDirLinks(dir: string, depth = 2): DirLink[] {
  const out: DirLink[] = [];
  const walk = (d: string, level: number) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP.has(name)) continue;
      const p = join(d, name);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        let target = "";
        try {
          target = readlinkSync(p);
        } catch {
          /* unreadable link: still removed as a link */
        }
        out.push({ rel: relative(dir, p), target });
      } else if (st.isDirectory() && level < depth) walk(p, level + 1);
    }
  };
  walk(dir, 1);
  return out;
}

/** Removes the link itself, never what it points to. */
export function removeDirLink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    rmdirSync(path);
  }
}

export function restoreDirLinks(dir: string, links: DirLink[]): void {
  for (const l of links) {
    if (!l.target) continue;
    const p = join(dir, l.rel);
    if (existsSync(p)) continue;
    mkdirSync(dirname(p), { recursive: true });
    symlinkSync(l.target, p, process.platform === "win32" ? "junction" : "dir");
  }
}

export interface WorktreeCheck {
  ok: boolean;
  /** why it is kept, one short line */
  reason?: string;
}

/** Is the worktree safe to remove: a worktree of `source`, no uncommitted work, no commits only it has. */
export function canRemoveWorktree(source: string, path: string): WorktreeCheck {
  if (!existsSync(path)) return { ok: true };
  if (!listWorktrees(source).some((w) => samePath(w.path, path) && !w.main)) return { ok: false, reason: "not a linked worktree of its repository" };
  // folder links (a linked node_modules) show as untracked; they are taken out before removing, so they do not count
  const links = new Set(findDirLinks(path).map((l) => l.rel.replace(/\\/g, "/")));
  const changes = tryGit(path, ["status", "--porcelain"]).out.split("\n").filter(Boolean).filter((l) => !links.has(l.slice(3).replace(/\/$/, "")));
  if (changes.length) return { ok: false, reason: "uncommitted changes" };
  const r = tryGit(path, ["rev-list", "--count", "HEAD", "--not", "--remotes"]);
  const n = r.ok ? Number(r.out) || 0 : 0;
  if (n) {
    // commits that are on no remote are kept unless another local branch has them too
    const branch = tryGit(path, ["branch", "--show-current"]).out.trim();
    const elsewhere = tryGit(path, ["branch", "--contains", "HEAD", "--format=%(refname:short)"]).out.split("\n").filter((b) => b && b !== branch);
    if (!elsewhere.length) return { ok: false, reason: `${n} commit(s) that are on no remote` };
  }
  return { ok: true };
}

export interface RemoveResult {
  removed: boolean;
  branchDeleted: boolean;
  note: string;
}

/** `git worktree remove` (no --force) after taking out directory links; optionally `git branch -d` (refuses unmerged work). */
export function removeWorktreeSafely(source: string, path: string | undefined, branch: string, o: { deleteBranch?: boolean } = {}): RemoveResult {
  let removed = false;
  if (path && existsSync(path)) {
    const check = canRemoveWorktree(source, path);
    if (!check.ok) return { removed: false, branchDeleted: false, note: `kept: ${check.reason}` };
    const links = findDirLinks(path);
    for (const l of links) removeDirLink(join(path, l.rel));
    const r = tryGit(source, ["worktree", "remove", path]);
    if (!r.ok) {
      restoreDirLinks(path, links);
      return { removed: false, branchDeleted: false, note: `kept: ${r.err.split("\n")[0] || "git worktree remove failed"}` };
    }
    removed = true;
  } else tryGit(source, ["worktree", "prune"]);
  if (!o.deleteBranch || !refSha(source, `refs/heads/${branch}`)) return { removed, branchDeleted: false, note: removed ? "worktree removed, branch kept" : "no worktree" };
  if (listWorktrees(source).some((w) => w.branch === branch)) return { removed, branchDeleted: false, note: `${removed ? "worktree removed; " : ""}branch kept: it is checked out elsewhere` };
  const d = tryGit(source, ["branch", "-d", branch]);
  return d.ok
    ? { removed, branchDeleted: true, note: `${removed ? "worktree and " : ""}local branch removed (the remote branch stays)` }
    : { removed, branchDeleted: false, note: `${removed ? "worktree removed; " : ""}branch kept: not merged (git branch -d refused)` };
}

/** `git worktree move` with the directory links taken out first and put back after. */
export function moveWorktreeSafely(source: string, from: string, to: string): { ok: boolean; note: string } {
  if (existsSync(to)) return { ok: false, note: `${to} already exists` };
  const links = findDirLinks(from);
  for (const l of links) removeDirLink(join(from, l.rel));
  mkdirSync(dirname(to), { recursive: true });
  const r = tryGit(source, ["worktree", "move", from, to]);
  if (!r.ok) {
    restoreDirLinks(from, links);
    return { ok: false, note: r.err.split("\n")[0] || "git worktree move failed" };
  }
  restoreDirLinks(to, links);
  return { ok: true, note: links.length ? `moved; ${links.length} folder link(s) put back` : "moved" };
}
