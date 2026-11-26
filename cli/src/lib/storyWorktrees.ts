import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";

/**
 * Which branches and worktrees belong to which story, which one is the one you work on (the star), and how much you
 * work in each. One small JSON file per repository, in its git common dir (`<repo>/.git/aihub/story-worktrees.json`),
 * shared by the aihub CLI, the AI Context Hub extension and the Worktree Maker extension: they all read and write it.
 * The Azure DevOps "Development" links of a story stay the source for which branches belong to it; this file only adds
 * the star, the status, a label and the activity.
 *
 * No imports outside node: the VS Code extension bundles this file as it is (no process, no git: reading it is cheap).
 */

export const STORY_WORKTREES_VERSION = 1;

export type BranchStatus = "current" | "old" | "parked";

export interface StoryBranch {
  storyId: number;
  branch: string;
  status: BranchStatus;
  /** free note, e.g. "spike for the demo" */
  label?: string;
  /** the worktree folder the branch is checked out in, when known */
  worktree?: string;
  created: string;
  lastActive?: string;
  /** activity score at `scoreAt`, decaying with a half-life of two days */
  score?: number;
  scoreAt?: string;
  lastCommit?: string;
  /** the score when the developer said No to "mark as current?": ask again only when it is clearly stronger */
  declinedScore?: number;
}

export interface StoryWorktrees {
  version: number;
  branches: Record<string, StoryBranch>;
  /** per story: its title (when a tool knew it), never ask again, the last sessions (branch per session start, newest last) */
  stories: Record<string, { title?: string; neverAsk?: boolean; sessions?: string[] }>;
}

export const emptyStoryWorktrees = (): StoryWorktrees => ({ version: STORY_WORKTREES_VERSION, branches: {}, stories: {} });

// ---- where the file is -------------------------------------------------------------------------------------

/** The git common dir of the repository `dir` is in (also from a linked worktree or a subfolder), without starting git. */
export function gitCommonDir(dir: string): string | undefined {
  let d = resolve(dir);
  for (let i = 0; i < 40; i++) {
    const dotGit = join(d, ".git");
    if (existsSync(dotGit)) {
      if (statSync(dotGit).isDirectory()) return dotGit;
      const m = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, "utf8"));
      if (!m) return undefined;
      const gitdir = resolve(d, m[1].trim());
      const common = join(gitdir, "commondir");
      return existsSync(common) ? resolve(gitdir, readFileSync(common, "utf8").trim()) : gitdir;
    }
    const up = dirname(d);
    if (up === d) return undefined;
    d = up;
  }
  return undefined;
}

export const storyWorktreesFile = (commonDir: string) => join(commonDir, "aihub", "story-worktrees.json");

/** The file of the repository `dir` is in, or undefined outside a repository. */
export const storyWorktreesFileFor = (dir: string) => {
  const c = gitCommonDir(dir);
  return c ? storyWorktreesFile(c) : undefined;
};

export function readStoryWorktrees(file: string): StoryWorktrees {
  if (!existsSync(file)) return emptyStoryWorktrees();
  let j: Partial<StoryWorktrees>;
  try {
    j = JSON.parse(readFileSync(file, "utf8")) as Partial<StoryWorktrees>;
  } catch {
    throw new Error(`${file} cannot be read (not JSON); fix or delete it`);
  }
  if ((j.version ?? 0) > STORY_WORKTREES_VERSION) throw new Error(`${file} was written by a newer version (schema ${j.version}); update aihub and the extensions`);
  return { version: STORY_WORKTREES_VERSION, branches: j.branches ?? {}, stories: j.stories ?? {} };
}

/** Read, change, write: the write goes to a temporary file that replaces the old one, so a reader never sees half a file. */
export function updateStoryWorktrees(file: string, change: (d: StoryWorktrees) => StoryWorktrees): StoryWorktrees {
  const next = change(readStoryWorktrees(file));
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
  return next;
}

// ---- star, status, label -----------------------------------------------------------------------------------

const iso = (t: number) => new Date(t).toISOString();

/** Links a branch to a story (or updates the link). `current` makes it the star; a new branch is otherwise parked. */
export function linkBranch(d: StoryWorktrees, o: { storyId: number; branch: string; worktree?: string; current?: boolean; label?: string }, now: number): StoryWorktrees {
  const had = d.branches[o.branch];
  const entry: StoryBranch = {
    ...(had && had.storyId === o.storyId ? had : { created: iso(now), status: "parked" as BranchStatus }),
    storyId: o.storyId,
    branch: o.branch,
    ...(o.worktree ? { worktree: o.worktree } : {}),
    ...(o.label !== undefined ? { label: o.label } : {}),
  };
  const next = { ...d, branches: { ...d.branches, [o.branch]: entry } };
  return o.current ? markStatus(next, o.branch, "current", now) : next;
}

export function unlinkBranch(d: StoryWorktrees, branch: string): StoryWorktrees {
  const branches = { ...d.branches };
  delete branches[branch];
  return { ...d, branches };
}

/** One star per story in this repository: marking one current makes the previous star old. */
export function markStatus(d: StoryWorktrees, branch: string, status: BranchStatus, now: number, label?: string): StoryWorktrees {
  const e = d.branches[branch];
  if (!e) throw new Error(`branch '${branch}' is not linked to a story here`);
  const branches: Record<string, StoryBranch> = {};
  for (const [k, v] of Object.entries(d.branches)) {
    if (k === branch) branches[k] = { ...v, status, ...(label !== undefined ? { label } : {}), ...(status === "current" ? { declinedScore: undefined, lastActive: v.lastActive ?? iso(now) } : {}) };
    else branches[k] = status === "current" && v.storyId === e.storyId && v.status === "current" ? { ...v, status: "old" } : v;
  }
  return { ...d, branches };
}

export const currentOf = (d: StoryWorktrees, storyId: number) => Object.values(d.branches).find((b) => b.storyId === storyId && b.status === "current");

// ---- the story id in a branch name ---------------------------------------------------------------------------

/** `feature/1234-x`, `1234-x`, `bugfix/US-77_y`, `users/me/feature/4321`; a team.yaml pattern (first group = id) wins. */
export function storyIdFromBranch(branch: string, pattern?: string): number | undefined {
  const m = pattern ? new RegExp(pattern).exec(branch) : /(?:^|[/_-])(\d+)(?=$|[-_/])/.exec(branch);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Does this branch name belong to the story by its name alone: the story number is the first number of the name, after
 * an optional prefix with slashes (`feature/4711-x`, `bugfix/4711_x`, `users/me/feature/4711`, `4711-x`) and an optional
 * ticket prefix (`US-4711`), on a word boundary (4711 is not 47110, 14711 or 4711a).
 */
export function branchNamedForStory(branch: string, id: number): boolean {
  return new RegExp(`(?:^|/)(?:[A-Z]+[-_])?${id}(?![0-9A-Za-z.])`).test(branch);
}

// ---- folder layout -----------------------------------------------------------------------------------------

const safe = (s: string) => s.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");

/** The part of a branch name that tells it apart: `feature/1234-search-v2` -> `search-v2`. */
export function variantOf(branch: string, storyId?: number): string {
  const last = branch.split("/").filter(Boolean).pop() ?? branch;
  const rest = storyId ? last.replace(new RegExp(`^(?:[A-Za-z]+-)?${storyId}(?:[-_]|$)`), "") : last;
  return safe(rest) || safe(last) || "branch";
}

export interface PathRequest {
  root: string;
  storyId?: number;
  /** slug for a new story folder; else taken from the branch */
  slug?: string;
  repo: string;
  branch: string;
  /** the folder names directly under root */
  storyFolders: string[];
  exists: (p: string) => boolean;
}

const pathOps = (root: string) => (root.includes("\\") || /^[A-Za-z]:/.test(root) ? win32 : posix);

/** The story folder: an existing `<id>-...` folder under root, else `<id>-<slug>`. */
export function storyFolderFor(r: Pick<PathRequest, "root" | "storyId" | "slug" | "branch" | "storyFolders">): string {
  const p = pathOps(r.root);
  if (!r.storyId) return p.join(r.root, "_no-story");
  const have = r.storyFolders.find((f) => f === String(r.storyId) || f.startsWith(`${r.storyId}-`));
  if (have) return p.join(r.root, have);
  const slug = safe(r.slug ?? variantOf(r.branch, r.storyId)).toLowerCase();
  return p.join(r.root, slug ? `${r.storyId}-${slug}` : String(r.storyId));
}

/** `<root>/<id>-<slug>/<repo>` for the first worktree of a repository, `<repo>--<variant>` for the next; `_no-story/<repo>--<branch>` without a story. */
export function worktreePathFor(r: PathRequest): string {
  const p = pathOps(r.root);
  const folder = storyFolderFor(r);
  if (!r.storyId) return unique(p.join(folder, `${r.repo}--${safe(r.branch)}`), r.exists);
  const first = p.join(folder, r.repo);
  if (!r.exists(first)) return first;
  return unique(p.join(folder, `${r.repo}--${variantOf(r.branch, r.storyId)}`), r.exists);
}

function unique(path: string, exists: (p: string) => boolean): string {
  if (!exists(path)) return path;
  for (let i = 2; ; i++) if (!exists(`${path}-${i}`)) return `${path}-${i}`;
}

export interface PlacedWorktree {
  path: string;
  branch: string;
  repo: string;
}

/** Worktrees of a story that are not in their story folder, with where they belong. Worktrees without a story id stay. */
export function misplacedWorktrees(list: PlacedWorktree[], o: { root: string; storyFolders: string[]; exists: (p: string) => boolean; pattern?: string }): (PlacedWorktree & { storyId: number; target: string })[] {
  const p = pathOps(o.root);
  const out: (PlacedWorktree & { storyId: number; target: string })[] = [];
  const taken = new Set<string>();
  const norm = (x: string) => x.replace(/\\/g, "/").toLowerCase();
  for (const w of list) {
    const storyId = storyIdFromBranch(w.branch, o.pattern);
    if (!storyId) continue;
    const folder = storyFolderFor({ root: o.root, storyId, branch: w.branch, storyFolders: o.storyFolders });
    const name = basename(w.path.replace(/\\/g, "/"));
    if (norm(p.dirname(w.path)) === norm(folder) && (name === w.repo || name.startsWith(`${w.repo}--`))) continue;
    const target = worktreePathFor({ root: o.root, storyId, repo: w.repo, branch: w.branch, storyFolders: o.storyFolders, exists: (x) => o.exists(x) || taken.has(norm(x)) });
    taken.add(norm(target));
    out.push({ ...w, storyId, target });
  }
  return out;
}

// ---- activity and the star suggestion ----------------------------------------------------------------------

export type ActivityKind = "edit" | "save" | "commit" | "focus" | "checkout";

/** Points per event (focus: per minute the window or editor of the worktree had focus). */
export const ACTIVITY: Record<ActivityKind, number> = { edit: 0.2, save: 1, commit: 5, focus: 0.5, checkout: 3 };
const HALF_LIFE_MS = 2 * 86_400_000;
/** a gap this long between two events of a story starts a new session */
const SESSION_GAP_MS = 30 * 60_000;
/** below this a branch is not "where you work" yet (about ten saves) */
const MIN_SCORE = 8;

export function scoreAt(b: StoryBranch, now: number): number {
  if (!b.score || !b.scoreAt) return 0;
  const dt = Math.max(0, now - Date.parse(b.scoreAt));
  return b.score * Math.pow(0.5, dt / HALF_LIFE_MS);
}

/** One event in a branch of a story. `amount` multiplies the points (minutes of focus). Unlinked branches are ignored. */
export function recordActivity(d: StoryWorktrees, branch: string, kind: ActivityKind, now: number, amount = 1): StoryWorktrees {
  const b = d.branches[branch];
  if (!b) return d;
  const key = String(b.storyId);
  const story = d.stories[key] ?? {};
  const lastInStory = Math.max(0, ...Object.values(d.branches).filter((x) => x.storyId === b.storyId && x.lastActive).map((x) => Date.parse(x.lastActive!)));
  const sessions = now - lastInStory > SESSION_GAP_MS ? [...(story.sessions ?? []), branch].slice(-5) : story.sessions?.length ? story.sessions : [branch];
  const nb: StoryBranch = { ...b, score: scoreAt(b, now) + ACTIVITY[kind] * amount, scoreAt: iso(now), lastActive: iso(now), ...(kind === "commit" ? { lastCommit: iso(now) } : {}) };
  return { ...d, branches: { ...d.branches, [branch]: nb }, stories: { ...d.stories, [key]: { ...story, sessions } } };
}

export interface StarSuggestion {
  storyId: number;
  branch: string;
  /** the star now, if any */
  current?: string;
  reason: "most activity" | "three sessions in a row" | "commit while the star is quiet";
  score: number;
}

/**
 * Should the developer be asked to move the star? Yes when a linked branch that is not the star has clearly the most
 * activity (at least twice the star's, decayed over about two days), or the last three sessions of the story were in
 * it, or it got a commit while the star has been quiet for three days. Never after "never ask" for the story; after a
 * "No" only when its score is half as strong again as when the developer said No.
 */
export function suggestCurrent(d: StoryWorktrees, storyId: number, now: number): StarSuggestion | undefined {
  if (d.stories[String(storyId)]?.neverAsk) return undefined;
  const mine = Object.values(d.branches).filter((b) => b.storyId === storyId);
  const star = mine.find((b) => b.status === "current");
  const starScore = star ? scoreAt(star, now) : 0;
  const starQuietDays = star?.lastActive ? (now - Date.parse(star.lastActive)) / 86_400_000 : Infinity;
  const sessions = d.stories[String(storyId)]?.sessions ?? [];
  const blocked = (b: StoryBranch, s: number) => b.declinedScore !== undefined && s < b.declinedScore * 1.5;
  let best: StarSuggestion | undefined;
  for (const b of mine) {
    if (b.status === "current") continue;
    const s = scoreAt(b, now);
    if (blocked(b, s)) continue;
    const base = { storyId, branch: b.branch, current: star?.branch, score: s };
    let reason: StarSuggestion["reason"] | undefined;
    if (s >= MIN_SCORE && s >= 2 * starScore) reason = "most activity";
    else if (sessions.length >= 3 && sessions.slice(-3).every((x) => x === b.branch)) reason = "three sessions in a row";
    else if (starQuietDays >= 3 && b.lastCommit && now - Date.parse(b.lastCommit) < 86_400_000) reason = "commit while the star is quiet";
    if (reason && (!best || s > best.score)) best = { ...base, reason };
  }
  return best;
}

/** True when `p` is an absolute folder (a worktree path from the file may come from another PC). */
export const isLocalPath = (p: string | undefined): p is string => !!p && isAbsolute(p) && existsSync(p);
