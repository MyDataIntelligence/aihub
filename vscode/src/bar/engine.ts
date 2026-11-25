import { existsSync } from "node:fs";
import { basename } from "node:path";
import { headBranchOf, scanMachine, type Scan } from "../../../cli/src/lib/machineScan";
import { machineFolders, repoRootOf } from "../../../cli/src/lib/machineFolders";
import { readRecentUse, rememberUse } from "../../../cli/src/lib/recentUse";
import { findSet } from "../../../cli/src/lib/setInfo";
import { readSetFile } from "../../../cli/src/lib/setFile";
import { isClosedState, readSeenStories } from "../../../cli/src/lib/storyCache";
import { readStoryWorktrees, storyWorktreesFileFor } from "../../../cli/src/lib/storyWorktrees";
import { buildState, setLabel, type OpenFacts } from "./state";
import type { BarState, BarStoryBranch } from "./types";

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
  /** is the branch linked to the story in Azure DevOps (answered from an earlier read, never a call) */
  linkedOf?: (story: number, repo: string, branch: string) => boolean | undefined;
  now?: () => number;
}

export { prune, repoRootOf } from "../../../cli/src/lib/machineFolders";

export function openFacts(dir: string | undefined): OpenFacts {
  if (!dir) return {};
  const set = findSet(dir);
  if (set) {
    return { dir, set: { folder: set.folder, story: set.story, branch: set.branch, ...(set.group ? { group: set.group } : {}), repos: set.repos.map((r) => ({ name: r.name, path: r.path, branch: headBranchOf(r.path) || r.branch })) } };
  }
  const root = repoRootOf(dir);
  return root ? { dir, repo: { name: basename(root), path: root, branch: headBranchOf(root) } } : { dir };
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

export class BarEngine {
  constructor(private deps: EngineDeps) {}

  private now = () => (this.deps.now ?? Date.now)();

  folders(facts = openFacts(this.deps.dir())): string[] {
    // the personal list when there is one, else the parents of what is known (nested ones are covered by their parent)
    return machineFolders(this.deps.env, facts.dir);
  }

  scan(o: { refresh?: boolean } = {}): Scan {
    return scanMachine(this.deps.env, this.folders(), { refresh: o.refresh, now: this.now() });
  }

  async state(o: { refresh?: boolean } = {}): Promise<BarState> {
    const facts = openFacts(this.deps.dir());
    const folders = this.folders(facts);
    const scan = scanMachine(this.deps.env, folders, { refresh: o.refresh, now: this.now() });
    const stories = readSeenStories(this.deps.env);
    const dirty = new Map<string, number | undefined>();
    const ask = async (paths: string[]) => void (await Promise.all(paths.map(async (p) => dirty.set(p, await this.deps.dirtyOf?.(p)))));
    await ask(facts.set ? facts.set.repos.map((r) => r.path) : facts.repo ? [facts.repo.path] : []);
    // "clean" only for sets of closed stories (the ones the menu may offer to remove), at most MAX_CLEAN_CHECKS worktrees
    const candidates = scan.sets.filter((s) => s.story && isClosedState(stories[s.story]?.state)).flatMap((s) => s.repos.filter((r) => r.exists).map((r) => r.path)).filter((p) => !dirty.has(p)).slice(0, MAX_CLEAN_CHECKS);
    await ask(candidates);
    return buildState({
      open: facts,
      scan,
      recents: readRecentUse(this.deps.env),
      lookIn: folders,
      stories,
      exists: existsSync,
      dirty: (p) => dirty.get(p),
      storyBranches: storyBranchesOf,
      linked: this.deps.linkedOf,
      clean: (s) => {
        const counts = s.repos.filter((r) => r.exists).map((r) => dirty.get(r.path));
        return counts.some((c) => c === undefined) ? undefined : counts.every((c) => c === 0);
      },
    });
  }

  /** The window shows a set or a repository: it goes to the top of the recent list (a file write at most once a minute). */
  noteOpen(): void {
    const facts = openFacts(this.deps.dir());
    const stories = readSeenStories(this.deps.env);
    if (facts.set) {
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
