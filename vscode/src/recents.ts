/**
 * Recent worktree sets and stories, like PyCharm's Recent Projects: the last 10 of each, newest first. Kept in the
 * extension's globalState (read from memory, no file IO at activation). Pure: building, updating and the menu rows.
 */
import type { OpenResultJson, PickItem } from "./repoSetModel";

export interface RecentSet {
  /** the .code-workspace file of the set: stable and unique */
  id: string;
  label: string;
  branch: string;
  repos: string[];
  story?: number;
  lastOpened: string;
}

export interface RecentStory {
  id: number;
  title: string;
  lastOpened: string;
}

export interface Recents {
  sets: RecentSet[];
  stories: RecentStory[];
}

export const MAX_RECENTS = 10;
export const RECENTS_KEY = "aihub.recents";

export const emptyRecents = (): Recents => ({ sets: [], stories: [] });

/** What a stored value may be (an older or broken one counts as empty). */
export function readRecents(v: unknown): Recents {
  const r = v as Partial<Recents> | undefined;
  return { sets: Array.isArray(r?.sets) ? r!.sets.filter((s) => s && typeof s.id === "string") : [], stories: Array.isArray(r?.stories) ? r!.stories.filter((s) => s && typeof s.id === "number") : [] };
}

const sameFile = (a: string, b: string) => a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();

/** The set a successful `aihub worktree open|story open` made, as a recent entry; undefined without a workspace file. */
export function setFromOpen(res: OpenResultJson & { story?: number }, now: number): RecentSet | undefined {
  if (!res.workspace) return undefined;
  const repos = res.repos.filter((r) => r.ok).map((r) => r.repo);
  if (!repos.length) return undefined;
  const label = res.group ?? (res.story ? `Story ${res.story}` : repos.join(", "));
  return { id: res.workspace, label, branch: res.branch, repos, ...(res.story ? { story: res.story } : {}), lastOpened: new Date(now).toISOString() };
}

export function addSet(r: Recents, s: RecentSet): Recents {
  return { ...r, sets: [s, ...r.sets.filter((x) => !sameFile(x.id, s.id))].slice(0, MAX_RECENTS) };
}

export function addStory(r: Recents, s: { id: number; title: string }, now: number): Recents {
  const had = r.stories.find((x) => x.id === s.id);
  const entry: RecentStory = { id: s.id, title: s.title || had?.title || "", lastOpened: new Date(now).toISOString() };
  return { ...r, stories: [entry, ...r.stories.filter((x) => x.id !== s.id)].slice(0, MAX_RECENTS) };
}

export const removeSet = (r: Recents, id: string): Recents => ({ ...r, sets: r.sets.filter((x) => !sameFile(x.id, id)) });

/** "3 h ago", "yesterday", "5 d ago" for the menu. */
export function when(iso: string, now: number): string {
  const min = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} d ago`;
}

export type MenuValue = { command: string; args?: unknown };

/** The status bar button's menu: the three ways to open, then the recent sets and stories. */
export function openMenu(r: Recents, now: number): PickItem<MenuValue>[] {
  const items: PickItem<MenuValue>[] = [
    { label: "$(repo-forked) Open Repo Set...", description: "repositories on one branch", value: { command: "aihub.openRepoSet" } },
    { label: "$(add) New Worktree Set...", description: "a new branch in several repositories, as worktrees", value: { command: "aihub.newWorktreeSet" } },
    { label: "$(book) Open Story...", description: "the ★ branches of a story", value: { command: "aihub.openStory" } },
  ];
  if (r.sets.length) items.push({ label: "Recent worktree sets", separator: true }, ...recentSetItems(r, now));
  if (r.stories.length) items.push({ label: "Recent stories", separator: true }, ...recentStoryItems(r, now));
  return items;
}

export function recentSetItems(r: Recents, now: number): PickItem<MenuValue>[] {
  return r.sets.map((s) => ({ label: `$(folder-library) ${s.label}`, description: `${s.branch} · ${when(s.lastOpened, now)}`, detail: s.repos.join(", "), value: { command: "aihub.openRecentSet", args: { id: s.id } } }));
}

export function recentStoryItems(r: Recents, now: number): PickItem<MenuValue>[] {
  return r.stories.map((s) => ({ label: `$(book) #${s.id}${s.title ? ` ${s.title}` : ""}`, description: when(s.lastOpened, now), value: { command: "aihub.openRecentStory", args: { id: s.id } } }));
}

/** `aihub.getRecents` for other extensions (the PyCharm-style File menu): plain data, newest first. */
export function publicRecents(r: Recents): { sets: Omit<RecentSet, "story">[]; stories: RecentStory[] } {
  return { sets: r.sets.map(({ id, label, branch, repos, lastOpened }) => ({ id, label, branch, repos, lastOpened })), stories: r.stories.map(({ id, title, lastOpened }) => ({ id, title, lastOpened })) };
}

/** A command argument `{id}` or the bare id. */
export const idArg = <T extends string | number>(a: unknown): T | undefined => (a && typeof a === "object" && "id" in a ? ((a as { id: T }).id as T) : (a as T | undefined));

// ---- one list: a story set is a worktree set with a story link ------------------------------------------------

export interface RecentItem {
  kind: "story" | "set";
  /** story: its number; set: its .code-workspace file */
  id: number | string;
  label: string;
  detail: string;
  lastOpened: string;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * Stories and sets in one list, newest first. A set opened for a story is that story (its row says how many
 * repositories), so it is not listed twice.
 */
export function mergedRecents(r: Recents, max = 20): RecentItem[] {
  const items: RecentItem[] = [];
  const storyIds = new Set(r.stories.map((s) => s.id));
  for (const s of r.stories) {
    const sets = r.sets.filter((x) => x.story === s.id);
    const last = [s.lastOpened, ...sets.map((x) => x.lastOpened)].sort().pop()!;
    const repos = sets[0]?.repos.length;
    items.push({ kind: "story", id: s.id, label: `#${s.id}${s.title ? ` ${s.title}` : ""}`, detail: repos ? plural(repos, "repo") : "story", lastOpened: last });
  }
  for (const x of r.sets) {
    if (x.story && storyIds.has(x.story)) continue;
    if (x.story) items.push({ kind: "story", id: x.story, label: `#${x.story} ${x.label === `Story ${x.story}` ? "" : x.label}`.trim(), detail: plural(x.repos.length, "repo"), lastOpened: x.lastOpened });
    else items.push({ kind: "set", id: x.id, label: x.branch, detail: x.repos.join(", "), lastOpened: x.lastOpened });
  }
  return items.sort((a, b) => b.lastOpened.localeCompare(a.lastOpened)).slice(0, max);
}

/** The command and argument that open a merged recent item. */
export const openRecentValue = (i: RecentItem): MenuValue => ({ command: "aihub.openRecent", args: { kind: i.kind, id: i.id } });

export function recentItemRows(items: RecentItem[], now: number): PickItem<MenuValue>[] {
  return items.map((i) => ({ label: `${i.kind === "story" ? "$(book)" : "$(folder-library)"} ${i.label}`, description: `${i.detail} · ${when(i.lastOpened, now)}`, value: openRecentValue(i) }));
}

export const RECENT_IN_MENU = 8;

/** The status bar button: the two ways in, then Recent (at most 8) and "More..." (Open Worktree Set). */
export function mergedMenu(r: Recents, now: number): PickItem<MenuValue>[] {
  const items: PickItem<MenuValue>[] = [
    { label: "$(add) New Worktree Set...", description: "a new branch in several repositories, optionally for a story", value: { command: "aihub.newWorktreeSet" } },
    { label: "$(folder-opened) Open Worktree Set...", description: "a story or a set, recent ones first", value: { command: "aihub.openRepoSet" } },
  ];
  const recent = mergedRecents(r, RECENT_IN_MENU + 1);
  if (recent.length) {
    items.push({ label: "Recent", separator: true }, ...recentItemRows(recent.slice(0, RECENT_IN_MENU), now));
    if (recent.length > RECENT_IN_MENU) items.push({ label: "$(ellipsis) More...", value: { command: "aihub.openRepoSet" } });
  }
  return items;
}
