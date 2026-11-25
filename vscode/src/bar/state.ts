import { basename } from "node:path";
import { pathKey, type RecentUse } from "../../../cli/src/lib/recentUse";
import type { Scan, ScanSet } from "../../../cli/src/lib/machineScan";
import { isClosedState, type SeenStory } from "../../../cli/src/lib/storyCache";
import type { BarRecent, BarRepo, BarRepository, BarSet, BarState, BarStoryBranch } from "./types";

/**
 * BarState from what is already known: the folder this window shows, the scan of the PC, the recent list and the
 * stories seen. Pure: everything that needs the disk or git comes in as a function, so the three modes are testable.
 */
export interface OpenSetFacts {
  folder: string;
  story: number;
  branch: string;
  group?: string;
  repos: { name: string; path: string; branch: string }[];
}

export interface OpenFacts {
  /** the first workspace folder; undefined in an empty window */
  dir?: string;
  /** the set the folder belongs to */
  set?: OpenSetFacts;
  /** the folder is a git clone or worktree (not part of a set) */
  repo?: { name: string; path: string; branch: string };
}

export interface StateInput {
  open: OpenFacts;
  scan: Scan;
  recents: RecentUse[];
  lookIn: string[];
  stories: Record<number, SeenStory>;
  /** does this path still exist (a recent item whose folder is gone is dropped) */
  exists: (path: string) => boolean;
  /** changed files of a worktree; undefined when not known */
  dirty?: (path: string) => number | undefined;
  /** the story's branches in a repository (its story-worktrees.json) */
  storyBranches?: (repoPath: string, story: number) => BarStoryBranch[] | undefined;
  /** is the branch linked to the story in Azure DevOps; undefined when not known */
  linked?: (story: number, repo: string, branch: string) => boolean | undefined;
  /** a set without work in it, asked only for sets of closed stories */
  clean?: (set: ScanSet) => boolean | undefined;
}

export const storyLabel = (id: number, stories: Record<number, SeenStory>): string => (stories[id]?.title ? `#${id} ${stories[id].title}` : `#${id}`);

export const setLabel = (s: { story: number; group?: string; branch: string }, stories: Record<number, SeenStory>): string => (s.story ? storyLabel(s.story, stories) : s.group || s.branch);

export function buildState(i: StateInput): BarState {
  const { open } = i;
  const lookIn = i.lookIn;
  const sameSet = (s: { folder: string }) => !!open.set && pathKey(s.folder) === pathKey(open.set.folder);

  const sets: BarSet[] = i.scan.sets.map((s) => {
    const done = s.story ? (i.stories[s.story]?.state === undefined ? undefined : isClosedState(i.stories[s.story].state)) : undefined;
    const clean = done ? i.clean?.(s) : undefined;
    return {
      id: s.id,
      ...(s.story ? { story: s.story } : {}),
      label: setLabel(s, i.stories),
      repos: s.repos.filter((r) => r.exists).length,
      open: sameSet(s) && (!open.set || open.set.branch === s.branch),
      ...(done !== undefined ? { done } : {}),
      ...(clean !== undefined ? { clean } : {}),
    };
  });
  // the set of this window may lie outside the folders to look in: it is still in the list
  if (open.set && !sets.some((s) => s.open)) {
    sets.unshift({ id: open.set.folder, ...(open.set.story ? { story: open.set.story } : {}), label: setLabel(open.set, i.stories), repos: open.set.repos.length, open: true });
  }

  const repositories: BarRepository[] = i.scan.repos.map((r) => ({ name: r.name, path: r.path, branch: r.branch, ...(r.otherClones?.length ? { otherClones: r.otherClones.length } : {}) }));
  if (open.repo && !repositories.some((r) => pathKey(r.path) === pathKey(open.repo!.path))) repositories.push({ ...open.repo });
  repositories.sort((a, b) => a.name.localeCompare(b.name));

  const recents: BarRecent[] = i.recents
    .filter((r) => i.exists(r.id))
    .map((r) => ({ kind: r.kind, id: r.id, label: r.label, ...(r.detail ? { detail: r.detail } : {}), lastUsed: r.lastUsed }));

  const base = { recents, sets, repositories, lookIn };
  if (open.set) {
    const story = open.set.story ? { id: open.set.story, title: i.stories[open.set.story]?.title ?? "", ...(i.stories[open.set.story]?.state ? { state: i.stories[open.set.story].state } : {}) } : undefined;
    const repos: BarRepo[] = open.set.repos.map((r) => {
      const dirty = i.dirty?.(r.path);
      const sb = open.set!.story ? i.storyBranches?.(r.path, open.set!.story) : undefined;
      const linked = open.set!.story ? i.linked?.(open.set!.story, r.name, r.branch) : undefined;
      return { name: r.name, path: r.path, branch: r.branch, ...(linked !== undefined ? { linked } : {}), ...(dirty !== undefined ? { dirty } : {}), ...(sb?.length ? { storyBranches: sb } : {}) };
    });
    return { mode: "set", ...(story ? { story } : {}), setFolder: open.set.folder, repos, ...base };
  }
  if (open.repo) {
    const dirty = i.dirty?.(open.repo.path);
    return { mode: "repo", repos: [{ name: open.repo.name || basename(open.repo.path), path: open.repo.path, branch: open.repo.branch, ...(dirty !== undefined ? { dirty } : {}) }], ...base };
  }
  return { mode: "empty", repos: [], ...base };
}
