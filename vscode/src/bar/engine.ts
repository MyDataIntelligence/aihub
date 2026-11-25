import { existsSync } from "node:fs";
import { statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { headBranchOf, scanMachine, type Scan, type ScanRepo } from "../../../cli/src/lib/machineScan";
import { machineFolders, repoRootOf } from "../../../cli/src/lib/machineFolders";
import { pathKey, readRecentUse, rememberUse } from "../../../cli/src/lib/recentUse";
import { findSet } from "../../../cli/src/lib/setInfo";
import { readSetFile, stampStoryTitle } from "../../../cli/src/lib/setFile";
import { isClosedState, readSeenStories } from "../../../cli/src/lib/storyCache";
import { readStoryWorktrees, storyWorktreesFileFor } from "../../../cli/src/lib/storyWorktrees";
import { readPreferredClones, uniqueRepos } from "../worktrees/clones";
import { buildState, setLabel, type OpenFacts } from "./state";
import { isStoryBranch } from "./repoStatus";
import { allMerged, allPrsMerged, setKey, SizeMemo } from "./setSize";
import type { BarPr, BarState, BarStoryBranch } from "./types";

/**
 * What the buttons ask for: the state of this window and of the PC. No vscode here; the extension passes the folder
 * and a way to count changed files. Everything is read from files (no git process) except `dirtyOf`, which the
 * extension answers from a short cache.
 */
export interface EngineDeps {
  env: NodeJS.ProcessEnv;
  /** the first workspace folder, undefined in an empty window */
  dir: () => string | undefined;
  /** changed files of a worktree (a short cache in the extension); undefined when it cannot say */
  dirtyOf?: (path: string) => Promise<number | undefined>;
  /** changes and ahead (the git extension of VS Code) and behind the target (remembered), of a worktree; undefined when it cannot say */
  statusOf?: (path: string, name: string) => Promise<{ changes?: number; ahead?: number; behindTarget?: number } | undefined>;
  /** the label of the last action that can be undone (BarState.undo) */
  undoLabel?: () => string | undefined;
  /** commits of a worktree that are on no remote; undefined when it cannot say */
  unpushedOf?: (path: string) => Promise<number | undefined>;
  /** sizes of the sets, measured in the background */
  sizes?: SizeMemo;
  /** the pull request of a branch (from the one read for the set, remembered for minutes; never a call) */
  prOf?: (repo: string, branch: string) => BarPr | undefined;
  /** is the branch linked to the story in Azure DevOps (answered from an earlier read, never a call) */
  linkedOf?: (story: number, repo: string, branch: string) => boolean | undefined;
  /** other places known to be in use (the older recent list of this extension): folders, or workspace files of sets */
  extraPlaces?: () => string[];
  now?: () => number;
}

export { prune, repoRootOf } from "../../../cli/src/lib/machineFolders";

/** What the single status item says: "#4711 · 3 repositories", "<name> · 2 repositories" (a set without a story), "<repo> · single repository". */
export function infoText(f: OpenFacts): string | undefined {
  const n = (c: number) => `${c} ${c === 1 ? "repository" : "repositories"}`;
  if (f.set) return `${f.set.story ? `#${f.set.story}` : f.set.group || f.set.branch} · ${n(f.set.repos.length)}`;
  return f.repo ? `${f.repo.name} · single repository` : undefined;
}

export function openFacts(dir: string | undefined): OpenFacts {
  if (!dir) return {};
  const set = findSet(dir);
  if (set) {
    return { dir, set: { folder: set.folder, story: set.story, branch: set.branch, ...(set.group ? { group: set.group } : {}), repos: set.repos.map((r) => ({ name: r.name, path: r.path, branch: headBranchOf(r.path) || r.branch })) } };
  }
  const root = repoRootOf(dir);
  return root ? { dir, repo: { name: basename(root), path: root, branch: headBranchOf(root) } } : { dir };
}

/** The title of a story as the repositories remember it (aihub writes it into each repository's story-worktrees.json when it reads the story). */
export function titleFromFiles(story: number, repoPaths: string[]): string | undefined {
  for (const p of repoPaths) {
    try {
      const file = storyWorktreesFileFor(p);
      const t = file && existsSync(file) ? readStoryWorktrees(file).stories[String(story)]?.title : undefined;
      if (t) return t;
    } catch {
      /* a newer schema or a broken file: no title from here */
    }
  }
  return undefined;
}

/** The story's branches of a repository, from its story-worktrees.json (a file read). */
export function storyBranchesOf(repoPath: string, story: number): BarStoryBranch[] | undefined {
  try {
    const file = storyWorktreesFileFor(repoPath);
    if (!file || !existsSync(file)) return undefined;
    const rows = Object.entries(readStoryWorktrees(file).branches).filter(([, b]) => b.storyId === story);
    return rows.map(([name, b]) => ({ name, status: b.status }));
  } catch {
    return undefined;
  }
}

const MAX_CLEAN_CHECKS = 8;

/** When a clone was last used: the newest of .git/index and .git/HEAD (git writes them on status, commit, switch). */
function usedAt(dir: string): number {
  let t = 0;
  for (const f of ["index", "HEAD"]) {
    try {
      t = Math.max(t, statSync(join(dir, ".git", f)).mtimeMs);
    } catch {
      /* missing: never used */
    }
  }
  return t;
}

/** One entry per remote ("+N more" is otherClones): the preferred clone (`aihub repos prefer`), else the most recently used, else the shortest path. */
export async function oneClonePerRemote(env: NodeJS.ProcessEnv, repos: ScanRepo[]): Promise<ScanRepo[]> {
  const by = new Map(repos.map((r) => [pathKey(r.path), r]));
  const unique = await uniqueRepos(repos.map((r) => ({ name: r.name, path: r.path, root: dirname(r.path) })), readPreferredClones(env), async (f) => ({ url: by.get(pathKey(f))?.remote, lastUsed: usedAt(f) }));
  return unique.map((u) => ({ ...by.get(pathKey(u.path))!, ...(u.otherClones?.length ? { otherClones: u.otherClones } : {}) })).sort((a, b) => a.name.localeCompare(b.name));
}

export class BarEngine {
  constructor(private deps: EngineDeps) {}

  private now = () => (this.deps.now ?? Date.now)();

  folders(facts = openFacts(this.deps.dir())): string[] {
    // the personal list when there is one, else the parents of what is known (nested ones are covered by their parent)
    return machineFolders(this.deps.env, facts.dir, this.deps.extraPlaces?.() ?? []);
  }

  scan(o: { refresh?: boolean } = {}): Scan {
    return scanMachine(this.deps.env, this.folders(), { refresh: o.refresh, now: this.now() });
  }

  /** The repositories on this PC, one per remote. */
  async repositories(o: { refresh?: boolean } = {}): Promise<ScanRepo[]> {
    return oneClonePerRemote(this.deps.env, this.scan(o).repos);
  }

  /** Changed files of a worktree (remembered a few seconds); undefined when git cannot say. */
  changedFiles(path: string): Promise<number | undefined> {
    return this.deps.dirtyOf ? this.deps.dirtyOf(path) : Promise.resolve(undefined);
  }

  async state(o: { refresh?: boolean } = {}): Promise<BarState> {
    const facts = openFacts(this.deps.dir());
    const folders = this.folders(facts);
    const raw = scanMachine(this.deps.env, folders, { refresh: o.refresh, now: this.now() });
    const scan: Scan = { ...raw, repos: await oneClonePerRemote(this.deps.env, raw.repos) };
    const stories = readSeenStories(this.deps.env);
    // a story this PC has not read from Azure DevOps lately still has a title in its repositories' files
    const named = new Set<number>();
    for (const set of [...raw.sets, ...(facts.set ? [{ story: facts.set.story, repos: facts.set.repos.map((r) => ({ path: r.path, exists: true })) }] : [])]) {
      if (!set.story || stories[set.story]?.title || named.has(set.story)) continue;
      named.add(set.story);
      const t = titleFromFiles(set.story, set.repos.filter((r) => r.exists).map((r) => r.path));
      if (t) stories[set.story] = { id: set.story, title: t, at: 0 };
    }
    const dirty = new Map<string, number | undefined>();
    const status = new Map<string, { changes?: number; ahead?: number; behindTarget?: number } | undefined>();
    const ask = async (paths: string[]) => void (await Promise.all(paths.map(async (p) => dirty.set(p, await this.deps.dirtyOf?.(p)))));
    // the open set or repository: the git extension answers changes and ahead (no process of ours), dirtyOf only where it cannot
    const open = facts.set ? facts.set.repos.map((r) => ({ name: r.name, path: r.path })) : facts.repo ? [{ name: facts.repo.name, path: facts.repo.path }] : [];
    await Promise.all(open.map(async (r) => status.set(r.path, await this.deps.statusOf?.(r.path, r.name))));
    await ask(open.filter((r) => status.get(r.path)?.changes === undefined).map((r) => r.path));
    // "clean" only for sets of closed stories (the ones the menu may offer to remove), at most MAX_CLEAN_CHECKS worktrees
    const candidates = scan.sets.filter((s) => s.story && isClosedState(stories[s.story]?.state)).flatMap((s) => s.repos.filter((r) => r.exists).map((r) => r.path)).filter((p) => !dirty.has(p)).slice(0, MAX_CLEAN_CHECKS);
    await ask(candidates);
    // every pull request merged and nothing to lose: only for sets whose pull requests are all merged (a memory, no call), at most MAX_CLEAN_CHECKS sets
    const merged = new Map<string, boolean>();
    if (this.deps.prOf) {
      const pr = this.deps.prOf;
      for (const s of scan.sets.filter((x) => !(facts.set && pathKey(x.folder) === pathKey(facts.set.folder)) && allPrsMerged(x, pr)).slice(0, MAX_CLEAN_CHECKS)) {
        merged.set(s.id, await allMerged(s, { pr, changes: async (p) => this.deps.dirtyOf?.(p), unpushed: async (p) => this.deps.unpushedOf?.(p) }));
      }
    }
    return buildState({
      open: facts,
      undo: this.deps.undoLabel?.(),
      size: (s) => this.deps.sizes?.get(s.id, setKey(s)),
      allMerged: (s) => merged.get(s.id) ?? (this.deps.prOf ? false : undefined),
      scan,
      recents: readRecentUse(this.deps.env),
      lookIn: folders,
      stories,
      exists: existsSync,
      dirty: (p) => status.get(p)?.changes ?? dirty.get(p),
      status: (p) => status.get(p),
      pr: this.deps.prOf,
      storyBranch: (p, b) => !!facts.set?.story && isStoryBranch(facts.set.story, b, (storyBranchesOf(p, facts.set.story) ?? []).filter((x) => x.status !== "old").map((x) => x.name)),
      storyBranches: storyBranchesOf,
      linked: this.deps.linkedOf,
      clean: (s) => {
        const counts = s.repos.filter((r) => r.exists).map((r) => dirty.get(r.path));
        return counts.some((c) => c === undefined) ? undefined : counts.every((c) => c === 0);
      },
    });
  }

  /** Measures the size of every set in the background (one at a time, without blocking); `done` runs after each one. */
  measureSets(done: () => void): Promise<void> {
    const sets = this.scan().sets.map((s) => ({ id: s.id, key: setKey(s), paths: s.repos.filter((r) => r.exists).map((r) => r.path) }));
    return this.deps.sizes?.measureAll(sets, done) ?? Promise.resolve();
  }

  /** The window shows a set or a repository: it goes to the top of the recent list (a file write at most once a minute). */
  noteOpen(): void {
    const facts = openFacts(this.deps.dir());
    const stories = readSeenStories(this.deps.env);
    if (facts.set) {
      const t = facts.set.story && !stories[facts.set.story]?.title ? titleFromFiles(facts.set.story, facts.set.repos.map((r) => r.path)) : undefined;
      if (t) stories[facts.set.story] = { id: facts.set.story, title: t, at: 0 };
      if (facts.set.story && stories[facts.set.story]?.title) stampStoryTitle(facts.set.folder, facts.set.story, stories[facts.set.story].title);
      const id = workspaceOf(facts.set.folder, facts.set.branch) ?? facts.set.folder;
      rememberUse(this.deps.env, { kind: "set", id, label: setLabel(facts.set, stories), detail: facts.set.repos.map((r) => r.name).join(", "), ...(facts.set.story ? { story: facts.set.story } : {}) }, this.now());
    } else if (facts.repo) {
      rememberUse(this.deps.env, { kind: "repo", id: facts.repo.path, label: facts.repo.name, ...(facts.repo.branch ? { detail: facts.repo.branch } : {}) }, this.now());
    }
  }
}

/** The workspace file of the set of `branch` in `folder` (the id the recent list and the menus use). */
export function workspaceOf(folder: string, branch: string): string | undefined {
  const f = readSetFile(folder);
  const m = f && [f.top, ...(f.top.others ?? [])].find((x) => x.branch === branch);
  return m?.workspace && existsSync(m.workspace) ? m.workspace : undefined;
}
