import { existsSync } from "node:fs";
import { statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { headBranchOf, scanMachine, type Scan, type ScanRepo } from "../../../cli/src/lib/machineScan";
import { machineFolders, repoRootOf } from "../../../cli/src/lib/machineFolders";
import { pathKey, readRecentUse, rememberUse } from "../../../cli/src/lib/recentUse";
import { findSet } from "../../../cli/src/lib/setInfo";
import { AIHUB_SET, MAKER_SET, readJsonText, readSetFile, stampStoryTitle } from "../../../cli/src/lib/setFile";
import { isClosedState, readSeenStories } from "../../../cli/src/lib/storyCache";
import { readStoryWorktrees, storyWorktreesFileFor } from "../../../cli/src/lib/storyWorktrees";
import { readPreferredClones, uniqueRepos } from "../worktrees/clones";
import { repoNameOfUrl } from "../../../cli/src/lib/repoName";
import { isHidden, readHiddenClones } from "./hiddenClones";
import { buildState, setLabel, type OpenFacts } from "./state";
import { isStoryBranch } from "./repoStatus";
import { allPrsMerged, setKey, SizeMemo } from "./setSize";
import { headSha, refSha } from "./behind";
import type { BarPr, BarRemote, BarState, BarStoryBranch } from "./types";

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
  statusOf?: (path: string, name: string) => Promise<{ changes?: number; ahead?: number; behindTarget?: number; target?: string } | undefined>;
  /** the label of the last action that can be undone (BarState.undo) */
  undoLabel?: (setFolder?: string) => string | undefined;
  /** commits of a worktree that are on no remote; undefined when it cannot say */
  unpushedOf?: (path: string) => Promise<number | undefined>;
  /** sizes of the sets, measured in the background */
  sizes?: SizeMemo;
  /** the pull request of a branch (from the one read for the set, remembered for minutes; never a call) */
  prOf?: (repo: string, branch: string) => BarPr | undefined;
  /** the pull request list has been read (an empty memory is "unknown", not "no pull requests") */
  prsKnown?: () => boolean;
  /** is the branch linked to the story in Azure DevOps (answered from an earlier read, never a call) */
  linkedOf?: (story: number, repo: string, branch: string) => boolean | undefined;
  /** the Azure DevOps repositories not on this PC, given the origin urls of every clone found (a file read, never a call) */
  remote?: (localRemotes: (string | undefined)[]) => BarRemote;
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

/** The last set that was read well, per window folder: a set file that cannot be read for a moment does not turn the set into a loose repository. */
const lastGoodSet = new Map<string, NonNullable<OpenFacts["set"]>>();

/** The set file above this folder that exists but cannot be read, with why; undefined when there is none. */
export function unreadableSetFile(dir: string): string | undefined {
  let d = dir;
  for (let i = 0; i < 12; i++) {
    for (const name of [AIHUB_SET, MAKER_SET]) {
      const file = join(d, name);
      if (!existsSync(file) || readSetFile(d)) continue;
      try {
        JSON.parse(readJsonText(file));
        return "the set file has no list of repositories";
      } catch {
        return "not valid JSON";
      }
    }
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return undefined;
}

export function openFacts(dir: string | undefined): OpenFacts {
  if (!dir) return {};
  const set = findSet(dir);
  if (!set) {
    // a set this window showed does not become a loose repository because the file cannot be read for a moment (it is being replaced, a
    // scanner holds it): the last good one stays while its folder is there
    const was = lastGoodSet.get(dir);
    const problem = unreadableSetFile(dir) ?? (was && existsSync(was.folder) ? "the set file cannot be read right now" : undefined);
    const kept = problem ? was : undefined;
    if (problem && kept) return { dir, set: { ...kept, repos: kept.repos.map((r) => ({ ...r, branch: headBranchOf(r.path) || r.branch })) }, setFileProblem: problem };
    if (problem) {
      const root = repoRootOf(dir);
      return { dir, setFileProblem: problem, ...(root ? { repo: { name: basename(root), path: root, branch: headBranchOf(root) } } : {}) };
    }
  }
  if (set) {
    const facts = { folder: set.folder, story: set.story, branch: set.branch, ...(set.group ? { group: set.group } : {}), repos: set.repos.map((r) => ({ name: r.name, path: r.path, branch: headBranchOf(r.path) || r.branch })) };
    lastGoodSet.set(dir, facts);
    return { dir, set: facts };
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
export async function oneClonePerRemote(env: NodeJS.ProcessEnv, all: ScanRepo[], o: { folders?: string[] } = {}): Promise<ScanRepo[]> {
  const hidden = readHiddenClones(env);
  const repos = all.filter((r) => !isHidden(hidden, r.path));
  const by = new Map(repos.map((r) => [pathKey(r.path), r]));
  // the first folder to look in that holds the clone: the last tie-break of "which clone wins" (preferred, last used, first folder)
  const rank = (p: string) => {
    const i = (o.folders ?? []).findIndex((f) => pathKey(p).startsWith(`${pathKey(f)}/`) || pathKey(p) === pathKey(f));
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const unique = await uniqueRepos(repos.map((r) => ({ name: r.name, path: r.path, root: dirname(r.path) })), readPreferredClones(env), async (f) => ({ url: by.get(pathKey(f))?.remote, lastUsed: usedAt(f) }), rank);
  return unique
    .map((u) => {
      const main = by.get(pathKey(u.path))!;
      // the repository is its remote, not its folder: a clone in `repo-a-copy` of the repository repo-a is repo-a
      const name = repoNameOfUrl(main.remote) ?? main.name;
      const others = u.otherClones ?? [];
      return { ...main, name, ...(others.length ? { otherClones: others, clones: [main, ...others.map((p) => by.get(pathKey(p))!).filter(Boolean)].map((c) => ({ path: c.path, branch: c.branch })) } : {}) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

const OTHERS_TTL_MS = 5 * 60_000;

export class BarEngine {
  constructor(private deps: EngineDeps) {}
  private others = new Map<string, { at: number; changes?: number; unpushed?: number }>();

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
    return oneClonePerRemote(this.deps.env, this.scan(o).repos, { folders: this.folders() });
  }

  /** Changed files of a worktree (remembered a few seconds); undefined when git cannot say. */
  changedFiles(path: string): Promise<number | undefined> {
    return this.deps.dirtyOf ? this.deps.dirtyOf(path) : Promise.resolve(undefined);
  }

  async state(o: { refresh?: boolean } = {}): Promise<BarState> {
    const facts = openFacts(this.deps.dir());
    const folders = this.folders(facts);
    const raw = scanMachine(this.deps.env, folders, { refresh: o.refresh, now: this.now() });
    const scan: Scan = { ...raw, repos: await oneClonePerRemote(this.deps.env, raw.repos, { folders }) };
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
    const status = new Map<string, { changes?: number; ahead?: number; behindTarget?: number; target?: string } | undefined>();
    const ask = async (paths: string[]) => void (await Promise.all(paths.map(async (p) => dirty.set(p, await this.deps.dirtyOf?.(p)))));
    // the open set or repository: the git extension answers changes and ahead (no process of ours), dirtyOf only where it cannot
    const open = facts.set ? facts.set.repos.map((r) => ({ name: r.name, path: r.path })) : facts.repo ? [{ name: facts.repo.name, path: facts.repo.path }] : [];
    await Promise.all(open.map(async (r) => status.set(r.path, await this.deps.statusOf?.(r.path, r.name))));
    await ask(open.filter((r) => status.get(r.path)?.changes === undefined).map((r) => r.path));
    // what is known of the worktrees of the OTHER sets (closed stories, merged pull requests): a memory filled in the background when the left menu opens, never here
    const known = (p: string) => this.others.get(p);
    const fresh = (p: string) => {
      const k = known(p);
      return k && this.now() - k.at < OTHERS_TTL_MS ? k : undefined;
    };
    for (const s of scan.sets) for (const r of s.repos) if (r.exists && !dirty.has(r.path) && fresh(r.path)) dirty.set(r.path, fresh(r.path)!.changes);
    const merged = new Map<string, boolean>();
    if (this.deps.prOf) {
      const pr = this.deps.prOf;
      for (const s of scan.sets.filter((x) => allPrsMerged(x, pr))) {
        const live = s.repos.filter((r) => r.exists);
        const k = live.map((r) => fresh(r.path));
        // unknown until the background check has looked: not "no"
        if (k.every((x) => x && x.changes !== undefined && x.unpushed !== undefined)) merged.set(s.id, k.every((x) => x!.changes === 0 && x!.unpushed === 0));
      }
    }
    return buildState({
      open: facts,
      undo: this.deps.undoLabel?.(facts.set?.folder),
      // a worktree whose source clone is gone (read from the set file and the folders: no process)
      sourceMissing: (p) => {
        const f = facts.set ? readSetFile(facts.set.folder) : undefined;
        const r = f && [f.top, ...(f.top.others ?? [])].flatMap((m) => m.repos).find((x) => pathKey(x.path) === pathKey(p));
        return !!r?.source && !existsSync(join(r.source, ".git"));
      },
      size: (s) => this.deps.sizes?.get(s.id, setKey(s)),
      prsMerged: (s) => (this.deps.prOf && this.deps.prsKnown?.() ? allPrsMerged(s, this.deps.prOf) : undefined),
      allMerged: (s) => merged.get(s.id) ?? (this.deps.prOf && !allPrsMerged(s, this.deps.prOf) ? false : undefined),
      scan,
      remote: this.deps.remote?.(raw.repos.map((r) => r.remote)),
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
  async measureSets(done: () => void, o: { force?: boolean } = {}): Promise<void> {
    const scan = this.scan();
    const sets = scan.sets.map((s) => ({ id: s.id, key: setKey(s), paths: s.repos.filter((r) => r.exists).map((r) => r.path) }));
    await (this.deps.sizes?.measureAll(sets, done, o) ?? Promise.resolve());
    // unpushed of the worktrees of other sets, from the files only: no process
    for (const w of this.offered()) {
      const head = headSha(w.path);
      const k = this.others.get(w.path);
      if (head && head === refSha(w.path, `refs/remotes/origin/${w.branch}`) && !(k && k.unpushed === 0)) this.others.set(w.path, { ...(k ?? { changes: undefined }), at: k?.at ?? this.now(), unpushed: 0 });
    }
    done();
  }

  /**
   * Changed files and unpushed commits of the worktrees of other sets that can be offered for removal (closed story, all
   * pull requests merged): at most MAX_CLEAN_CHECKS worktrees per menu opening, each remembered for 5 minutes. Unpushed is
   * read from files when the branch is at its remote branch; git is asked only when it is not.
   */
  /** The worktrees of the other sets that can be offered for removal (closed story, or all pull requests merged). */
  private offered(): { path: string; branch: string }[] {
    const stories = readSeenStories(this.deps.env);
    const facts = openFacts(this.deps.dir());
    const wanted: { path: string; branch: string }[] = [];
    for (const s of this.scan().sets) {
      if (facts.set && pathKey(s.folder) === pathKey(facts.set.folder)) continue;
      const offered = (s.story && isClosedState(stories[s.story]?.state)) || (this.deps.prOf && allPrsMerged(s, this.deps.prOf));
      if (offered) for (const r of s.repos) if (r.exists) wanted.push({ path: r.path, branch: r.branch });
    }
    return wanted;
  }

  /**
   * Changed files (and unpushed commits, git only when the files cannot say) of at most MAX_CLEAN_CHECKS offered worktrees, each
   * remembered 5 minutes: asked for when the clean-up dialog opens, not when the left menu opens (that starts no process).
   */
  async checkClean(done: () => void): Promise<void> {
    const wanted = this.offered();
    let n = 0;
    for (const w of wanted) {
      const k = this.others.get(w.path);
      if (k && k.changes !== undefined && this.now() - k.at < OTHERS_TTL_MS) continue;
      if (n++ >= MAX_CLEAN_CHECKS) break;
      const changes = await this.deps.dirtyOf?.(w.path);
      const head = headSha(w.path);
      const unpushed = head && head === refSha(w.path, `refs/remotes/origin/${w.branch}`) ? 0 : await this.deps.unpushedOf?.(w.path);
      this.others.set(w.path, { at: this.now(), changes, unpushed });
    }
    if (n) done();
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
