import { basename } from "node:path";
import { pathKey, type RecentUse } from "../../../cli/src/lib/recentUse";
import type { Scan, ScanSet } from "../../../cli/src/lib/machineScan";
import { isClosedState, type SeenStory } from "../../../cli/src/lib/storyCache";
import type { BarPr, BarRecent, BarRepo, BarRepository, BarSet, BarState, BarStoryBranch } from "./types";

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
  /** changes (git extension), ahead and behind the target for a worktree; undefined when not known */
  status?: (path: string) => { changes?: number; ahead?: number; behindTarget?: number } | undefined;
  /** the pull request of a branch of a repository (a memory of one earlier read) */
  pr?: (repo: string, branch: string) => BarPr | undefined;
  /** the branch belongs to the story */
  storyBranch?: (repoPath: string, branch: string) => boolean;
  /** the last action that can be undone */
  undo?: string;
  /** the remembered size of a set (bytes) */
  size?: (s: ScanSet) => { bytes: number; at: number; lowerBound?: boolean } | undefined;
  /** every repository of the set has a merged pull request, from the pull request list only; undefined when the list is not known */
  prsMerged?: (s: ScanSet) => boolean | undefined;
  /** every pull request merged and nothing to lose (worked out by the engine for the sets that can be offered) */
  allMerged?: (s: ScanSet) => boolean | undefined;
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
    const size = i.size?.(s);
    const sizeBytes = size?.bytes;
    const prsMerged = i.prsMerged?.(s);
    const merged = i.allMerged?.(s);
    return {
      id: s.id,
      ...(s.story ? { story: s.story } : {}),
      label: setLabel(s, i.stories),
      repos: s.repos.filter((r) => r.exists).length,
      open: sameSet(s) && (!open.set || open.set.branch === s.branch),
      ...(done !== undefined ? { done } : {}),
      ...(clean !== undefined ? { clean } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes, sizeAt: size!.at, ...(size!.lowerBound ? { sizeLowerBound: true } : {}) } : {}),
      ...(prsMerged !== undefined ? { prsMerged } : {}),
      ...(merged !== undefined ? { allMerged: merged } : {}),
    };
  });
  const sized = sets.filter((s) => s.sizeBytes !== undefined);
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

  const base = { recents, sets, repositories, lookIn, ...(i.undo ? { undo: { label: i.undo } } : {}), ...(sized.length ? { totalSizeBytes: sized.reduce((n, s) => n + s.sizeBytes!, 0), ...(sized.some((s) => s.sizeLowerBound) ? { totalSizeLowerBound: true } : {}) } : {}), ...(i.scan.truncated ? { scanTruncated: true } : {}), ...(i.scan.skippedRemote?.length ? { scanSkipped: i.scan.skippedRemote } : {}) };
  if (open.set) {
    const story = open.set.story ? { id: open.set.story, title: i.stories[open.set.story]?.title ?? "", ...(i.stories[open.set.story]?.state ? { state: i.stories[open.set.story].state } : {}) } : undefined;
    const repos: BarRepo[] = open.set.repos.map((r) => {
      const st = i.status?.(r.path);
      const dirty = st?.changes ?? i.dirty?.(r.path);
      const sb = open.set!.story ? i.storyBranches?.(r.path, open.set!.story) : undefined;
      const linked = open.set!.story ? i.linked?.(open.set!.story, r.name, r.branch) : undefined;
      const pr = i.pr?.(r.name, r.branch);
      return {
        name: r.name,
        path: r.path,
        branch: r.branch,
        ...(linked !== undefined ? { linked } : {}),
        ...(dirty !== undefined ? { dirty, changes: dirty } : {}),
        ...(st?.ahead !== undefined ? { ahead: st.ahead } : {}),
        ...(st?.behindTarget !== undefined ? { behindTarget: st.behindTarget } : {}),
        ...(pr ? { pr } : {}),
        storyBranch: !!open.set!.story && !!i.storyBranch?.(r.path, r.branch),
        ...(sb?.length ? { storyBranches: sb } : {}),
      };
    });
    return { mode: "set", ...(story ? { story } : {}), setFolder: open.set.folder, repos, ...base };
  }
  if (open.repo) {
    const dirty = i.dirty?.(open.repo.path);
    const st = i.status?.(open.repo.path);
    return { mode: "repo", repos: [{ name: open.repo.name || basename(open.repo.path), path: open.repo.path, branch: open.repo.branch, storyBranch: false, ...(dirty !== undefined || st?.changes !== undefined ? { dirty: st?.changes ?? dirty, changes: st?.changes ?? dirty } : {}), ...(st?.ahead !== undefined ? { ahead: st.ahead } : {}), ...(st?.behindTarget !== undefined ? { behindTarget: st.behindTarget } : {}) }], ...base };
  }
  return { mode: "empty", repos: [], ...base };
}
