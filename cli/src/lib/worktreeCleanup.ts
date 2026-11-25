import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Ctx } from "./context.js";
import { findPullRequests } from "./worktreeCleanupAdo.js";
import { originDefaultBranch, repoRoot } from "./git.js";
import { listWorktrees, pruneIfSafe, samePath, tryGit } from "./gitx.js";
import { listGroups, resolveRepos } from "./repoGroups.js";
import { clientForDir } from "./repos.js";
import { dirSize, findDirLinks, removeWorktreeSafely } from "./safeWorktree.js";
import { readStoryWorktrees, storyIdFromBranch, storyWorktreesFileFor } from "./storyWorktrees.js";
import { defaultTargetFor, loadTeam } from "./team.js";
import { getWorkItem } from "./workitems.js";

/**
 * `aihub worktree cleanup`: every linked worktree of the user's repositories (this one, the repo groups, --repos) with
 * what decides whether it can go: local work (uncommitted, unpushed), merged into the target, the pull request and the
 * story of its branch. A worktree is preselected only when its work is done (PR completed or abandoned, story done, or
 * merged) AND it has no local work; one with local work is never preselected. Removal goes through safeWorktree.ts.
 */

export interface CleanupRow {
  repo: string;
  /** the main checkout of the repository */
  source: string;
  path: string;
  branch: string;
  sizeBytes?: number;
  /** epoch ms of the last checkout, commit or status in the worktree */
  lastActive?: number;
  uncommitted: number;
  unpushed: number;
  target?: string;
  merged?: boolean;
  pr?: { id: number; status: string };
  story?: { id: number; state?: string; title?: string; done?: boolean };
  /** false: not signed in to Azure DevOps (or --offline), so PR and story state are unknown */
  remote: boolean;
  /** why it can go (empty: keep) */
  reasons: string[];
  /** a warning when there is local work */
  warning?: string;
  preselected: boolean;
}

export const DONE_STATES = /^(closed|done|resolved|removed|completed)$/i;

/** The decision, separate so it is tested on its own. */
export function decideRow(r: Pick<CleanupRow, "uncommitted" | "unpushed" | "merged" | "pr" | "story">): { reasons: string[]; warning?: string; preselected: boolean } {
  const reasons: string[] = [];
  if (r.pr && /^(completed|abandoned)$/i.test(r.pr.status)) reasons.push(`PR !${r.pr.id} ${r.pr.status}`);
  if (r.story?.done) reasons.push(`story ${r.story.id} ${r.story.state}`);
  if (r.merged) reasons.push("merged");
  const local = [r.uncommitted ? `${r.uncommitted} uncommitted` : "", r.unpushed ? `${r.unpushed} unpushed` : ""].filter(Boolean).join(", ");
  return { reasons, warning: local ? `local work: ${local}` : undefined, preselected: reasons.length > 0 && !local };
}

/** The repositories to look in: --repos, else this repository and every repository of the user's groups. */
export function cleanupRepos(ctx: Ctx, specs: string[]): { name: string; dir: string }[] {
  const dirs: { name: string; dir: string }[] = [];
  if (specs.length) dirs.push(...resolveRepos(ctx, specs));
  else {
    try {
      const root = repoRoot(ctx.cwd);
      dirs.push({ name: basename(root), dir: root });
    } catch {
      /* not in a repository */
    }
    for (const g of listGroups(ctx)) for (const r of g.repos) if (existsSync(r.path)) dirs.push({ name: r.name, dir: r.path });
  }
  // one entry per repository: a worktree of a repository leads to its main checkout
  const seen: { name: string; dir: string }[] = [];
  for (const d of dirs) {
    const main = listWorktrees(d.dir).find((w) => w.main)?.path ?? d.dir;
    if (!seen.some((s) => samePath(s.dir, main))) seen.push({ name: d.name, dir: main });
  }
  return seen;
}

function gitDirOf(worktree: string): string | undefined {
  try {
    const dotgit = join(worktree, ".git");
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotgit, "utf8"));
    if (!m) return undefined;
    return isAbsolute(m[1].trim()) ? m[1].trim() : resolve(worktree, m[1].trim());
  } catch {
    return undefined;
  }
}

function lastActive(worktree: string): number | undefined {
  const g = gitDirOf(worktree);
  const times = [g && join(g, "index"), g && join(g, "logs", "HEAD"), g && join(g, "HEAD")]
    .filter((f): f is string => !!f && existsSync(f))
    .map((f) => statSync(f).mtimeMs);
  return times.length ? Math.max(...times) : undefined;
}

export async function listCleanup(ctx: Ctx, o: { repos?: string[]; sizes?: boolean; offline?: boolean }): Promise<CleanupRow[]> {
  const rows: CleanupRow[] = [];
  for (const repo of cleanupRepos(ctx, o.repos ?? [])) {
    const team = (() => {
      try {
        return loadTeam(repo.dir);
      } catch {
        return {} as ReturnType<typeof loadTeam>;
      }
    })();
    const target = defaultTargetFor(team, repo.name) || originDefaultBranch(repo.dir) || "main";
    const file = storyWorktreesFileFor(repo.dir);
    const links = file && existsSync(file) ? readStoryWorktrees(file).branches : {};
    const pattern = (team.worktrees as { storyPattern?: string } | undefined)?.storyPattern;
    const worktrees = listWorktrees(repo.dir).filter((w) => !w.main && w.branch && existsSync(w.path));
    const client = o.offline ? undefined : (() => {
      try {
        return clientForDir(ctx, repo.dir);
      } catch {
        return undefined;
      }
    })();
    const signedIn = client ? await client.signIn().then(() => true, () => false) : false;
    const prs = signedIn && client ? await findPullRequests(client, worktrees.map((w) => w.branch!)) : new Map<string, { id: number; status: string }>();
    const stories = new Map<number, { state?: string; title?: string }>();
    for (const w of worktrees) {
      const branch = w.branch!;
      const linkFiles = new Set(findDirLinks(w.path).map((l) => l.rel.replace(/\\/g, "/")));
      const uncommitted = tryGit(w.path, ["status", "--porcelain"]).out.split("\n").filter(Boolean).filter((l) => !linkFiles.has(l.slice(3).replace(/\/$/, ""))).length;
      const up = tryGit(w.path, ["rev-list", "--count", "HEAD", "--not", "--remotes"]);
      const unpushed = up.ok ? Number(up.out) || 0 : 0;
      const merged = tryGit(repo.dir, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, `refs/remotes/origin/${target}`]).ok;
      const storyId = links[branch]?.storyId ?? storyIdFromBranch(branch, pattern);
      if (storyId && signedIn && client && !stories.has(storyId)) {
        try {
          const wi = await getWorkItem(client, storyId);
          stories.set(storyId, { state: wi.state, title: wi.title });
        } catch {
          stories.set(storyId, {});
        }
      }
      const s = storyId ? stories.get(storyId) : undefined;
      const row: Omit<CleanupRow, "reasons" | "warning" | "preselected"> = {
        repo: repo.name,
        source: repo.dir,
        path: w.path,
        branch,
        sizeBytes: o.sizes === false ? undefined : dirSize(w.path),
        lastActive: lastActive(w.path),
        uncommitted,
        unpushed,
        target,
        merged,
        pr: prs.get(branch),
        story: storyId ? { id: storyId, state: s?.state, title: s?.title, done: !!s?.state && DONE_STATES.test(s.state) } : undefined,
        remote: signedIn,
      };
      rows.push({ ...row, ...decideRow(row) });
    }
  }
  return rows.sort((a, b) => Number(b.preselected) - Number(a.preselected) || (a.lastActive ?? 0) - (b.lastActive ?? 0));
}

export interface RemovedRow {
  path: string;
  branch: string;
  removed: boolean;
  branchDeleted: boolean;
  freedBytes: number;
  note: string;
}

/** Removes the chosen worktrees safely (links first, never --force, never local work); prunes once per repository. */
export function removeCleanup(rows: CleanupRow[], paths: string[], o: { deleteBranch?: boolean } = {}): RemovedRow[] {
  const out: RemovedRow[] = [];
  const sources = new Set<string>();
  for (const p of paths) {
    const row = rows.find((r) => samePath(r.path, p));
    if (!row) {
      out.push({ path: p, branch: "", removed: false, branchDeleted: false, freedBytes: 0, note: "not a worktree in the list" });
      continue;
    }
    // a merged branch may go too; an unmerged one is kept (git branch -d refuses it)
    const r = removeWorktreeSafely(row.source, row.path, row.branch, { deleteBranch: !!o.deleteBranch });
    const busy = /permission denied|being used|busy|cannot (remove|delete)|directory not empty/i.test(r.note);
    out.push({ path: row.path, branch: row.branch, ...r, note: busy ? `${r.note} (a program still has files open here: close VS Code windows and terminals in this folder)` : r.note });
    sources.add(row.source);
  }
  for (const s of sources) pruneIfSafe(s);
  return out;
}

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(b >= 10 * 1024 ** 3 ? 0 : 2)} GB`;
const mb = (b: number) => (b >= 1024 ** 3 ? gb(b) : `${Math.round(b / 1024 ** 2)} MB`);
const age = (t: number | undefined, now: number) => (t === undefined ? "?" : `${Math.max(0, Math.round((now - t) / 86_400_000))} d`);

export function formatCleanup(rows: CleanupRow[], now = Date.now()): string {
  if (!rows.length) return "no linked worktrees found (this repository and the repositories of your groups)";
  const lines = rows.map((r) => `${r.preselected ? "[x]" : "[ ]"} ${r.repo} ${r.branch}  ${r.sizeBytes !== undefined ? mb(r.sizeBytes) : ""}  ${age(r.lastActive, now)} ago  ${r.reasons.join(", ") || "in progress"}${r.warning ? `  !! ${r.warning}` : ""}\n    ${r.path}`);
  const pre = rows.filter((r) => r.preselected);
  const bytes = pre.reduce((n, r) => n + (r.sizeBytes ?? 0), 0);
  return [...lines, "", `${pre.length} of ${rows.length} can go${bytes ? ` (${mb(bytes)})` : ""}; remove with: aihub worktree cleanup --remove <path,path> [--delete-branch]`].join("\n");
}

export const formatRemoved = (rows: RemovedRow[]) => {
  const freed = rows.reduce((n, r) => n + r.freedBytes, 0);
  return [...rows.map((r) => `${r.removed ? "removed" : "kept"} ${r.branch || r.path}: ${r.note}`), `${rows.filter((r) => r.removed).length} removed, ${mb(freed)} freed`].join("\n");
};
