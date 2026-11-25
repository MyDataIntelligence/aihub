import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gitDirFor } from "../../../cli/src/lib/machineScan";
import { branchNamedForStory } from "../../../cli/src/lib/storyWorktrees";
import type { GitRun } from "./ownWindow";
import type { BarPr } from "./types";

/**
 * The state of each repository of a set for the buttons: changes and ahead from the git extension of VS Code (no process
 * of ours), behind the target branch from the refs already there (one git call per repository after a HEAD change, then
 * remembered), and the pull request from one `aihub pr list` for the whole set (remembered for minutes). No vscode here.
 */

/** The part of the git extension's repository that is read. */
export interface GitRepoLike {
  rootUri: { fsPath: string };
  state: {
    workingTreeChanges: { uri: { fsPath: string } }[];
    indexChanges: { uri: { fsPath: string } }[];
    mergeChanges: { uri: { fsPath: string } }[];
    HEAD?: { ahead?: number };
  };
}

const key = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** Changed files (a file staged and changed again counts once) and commits to push, from the git extension. */
export function gitStatusOf(repos: GitRepoLike[], path: string): { changes: number; ahead: number } | undefined {
  const r = repos.find((x) => key(x.rootUri.fsPath) === key(path));
  if (!r) return undefined;
  const files = new Set([...r.state.workingTreeChanges, ...r.state.indexChanges, ...r.state.mergeChanges].map((c) => key(c.uri.fsPath)));
  return { changes: files.size, ahead: r.state.HEAD?.ahead ?? 0 };
}

/** The team.yaml path inside a repository (the same as the CLI's TEAM_FILE; no yaml package is needed here for one key). */
const TEAM_YAML = ".agents/skills/_shared/references/team.yaml";

/**
 * `defaultTarget` of the repository `name` in the text of team.yaml: the item of `repositories:` with that name, or the only
 * item when it has no name. A line reader for this one key, so the extension needs no yaml parser.
 */
export function teamTargetOf(text: string, name: string): string | undefined {
  const items: { name?: string; target?: string }[] = [];
  let inRepos = false;
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    if (/^repositories:\s*$/.test(raw)) {
      inRepos = true;
      continue;
    }
    if (/^\S/.test(raw)) inRepos = false;
    if (!inRepos) continue;
    const dash = /^\s*-\s+(\w+):\s*(.*?)\s*$/.exec(raw);
    const key = /^\s+(\w+):\s*(.*?)\s*$/.exec(raw);
    const m = dash ?? key;
    if (!m) continue;
    if (dash) items.push({});
    const it = items[items.length - 1];
    const val = m[2].replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "");
    if (it && m[1] === "name") it.name = val;
    if (it && m[1] === "defaultTarget") it.target = val;
  }
  const hit = items.find((i) => i.name?.toLowerCase() === name.toLowerCase()) ?? (items.length === 1 && !items[0].name ? items[0] : undefined);
  return hit?.target || undefined;
}

/** The common git dir of a clone or a worktree (a worktree's own git dir is <clone>/.git/worktrees/<name>). */
function commonDirOf(path: string): string | undefined {
  const dir = gitDirFor(path);
  return dir && /[\\/]worktrees[\\/][^\\/]+$/.test(dir) ? join(dir, "..", "..") : dir;
}

/** Does origin have this branch, as far as the refs on disk say (loose ref or packed-refs; no git process, no fetch)? */
export function originHas(path: string, branch: string): boolean {
  const common = commonDirOf(path);
  if (!common) return false;
  if (existsSync(join(common, "refs", "remotes", "origin", ...branch.split("/")))) return true;
  try {
    return readFileSync(join(common, "packed-refs"), "utf8").split(/\r?\n/).some((l) => l.endsWith(` refs/remotes/origin/${branch}`));
  } catch {
    return false;
  }
}

/**
 * The branch pull requests go to and a branch is kept up to date with: the repository's entry in team.yaml; else
 * `staging` when origin has it; else what origin/HEAD says; else `main`. One function for behind-the-target, the update
 * question and Create Pull Requests. Files only.
 */
export function targetOf(path: string, name: string): string {
  try {
    const t = teamTargetOf(readFileSync(join(path, TEAM_YAML), "utf8"), name);
    if (t) return t;
  } catch {
    /* no team.yaml here */
  }
  if (originHas(path, "staging")) return "staging";
  const common = commonDirOf(path);
  try {
    const head = common ? readFileSync(join(common, "refs", "remotes", "origin", "HEAD"), "utf8") : "";
    return /refs\/remotes\/origin\/(.+)/.exec(head)?.[1].trim() ?? "main";
  } catch {
    return "main";
  }
}

/** How far behind the target each repository is: one `git rev-list --count` after a HEAD change, then remembered until forget(). */
export class BehindMemo {
  private seen = new Map<string, Promise<number | undefined>>();
  constructor(private git: GitRun) {}

  behind(path: string, name: string): Promise<number | undefined> {
    const k = key(path);
    const had = this.seen.get(k);
    if (had) return had;
    const target = targetOf(path, name);
    const p = this.git(path, ["rev-list", "--count", `HEAD..origin/${target}`]).then(
      (out) => Number(out.trim()) || 0,
      () => undefined,
    );
    this.seen.set(k, p);
    return p;
  }

  /** HEAD of this repository moved (or everything: a refresh). */
  forget(path?: string): void {
    if (path) this.seen.delete(key(path));
    else this.seen.clear();
  }
}

/** The shape of one `aihub pr list --json` row that is used. */
export interface PrRow {
  id: number;
  repo: string;
  source: string;
  status: string;
  draft?: boolean;
  url: string;
  mergeStatus?: string;
  reviewers?: { vote: number; required: boolean }[];
}

/**
 * active | approved | failed | merged. approved: active, every required reviewer approved (10 or 5) and someone did.
 * failed: active but rejected (-10), waiting for the author (-5) or the merge check failed or has conflicts.
 * Abandoned pull requests are no pull request. A failed build is not in the list: that is `aihub pr show`.
 */
export function prStateOf(r: PrRow): BarPr["status"] | undefined {
  if (r.status === "completed") return "merged";
  if (r.status === "abandoned") return undefined;
  const votes = r.reviewers ?? [];
  if (votes.some((v) => v.vote <= -5) || r.mergeStatus === "conflicts" || r.mergeStatus === "failure" || r.mergeStatus === "rejectedByPolicy") return "failed";
  const required = votes.filter((v) => v.required);
  if (votes.some((v) => v.vote >= 5) && required.every((v) => v.vote >= 5)) return "approved";
  return "active";
}

/** The pull request of a branch: an open one first, else the newest merged one. */
export function prOfBranch(rows: PrRow[], repo: string, branch: string): BarPr | undefined {
  const mine = rows.filter((r) => r.repo.toLowerCase() === repo.toLowerCase() && r.source === branch);
  const best = mine.find((r) => r.status === "active") ?? mine.find((r) => r.status === "completed");
  const status = best && prStateOf(best);
  return best && status ? { id: best.id, status, url: best.url } : undefined;
}

export const PR_TTL_MS = 5 * 60_000;

/** One `aihub pr list` for the whole set, remembered for minutes; a failed call is remembered as long as a good one (no retry on every event). */
export class PrMemo {
  private rows: PrRow[] = [];
  private at = 0;
  private running?: Promise<void>;
  constructor(private fetch: () => Promise<PrRow[]>, private now: () => number = Date.now) {}

  get(): PrRow[] {
    return this.rows;
  }

  /** Reads again unless it was read less than PR_TTL_MS ago (`force`: the overview menu or a refresh asks). Never throws. */
  refresh(force = false): Promise<void> {
    if (this.running) return this.running;
    if (!force && this.at && this.now() - this.at < PR_TTL_MS) return Promise.resolve();
    this.running = this.fetch()
      .then((r) => void (this.rows = r))
      .catch(() => undefined)
      .finally(() => {
        this.at = this.now();
        this.running = undefined;
      });
    return this.running;
  }
}

/** A branch of the story: linked in the story's files or named after it (the story number first in the name). */
export const isStoryBranch = (story: number, branch: string, linked: string[]): boolean => !!story && (linked.includes(branch) || branchNamedForStory(branch, story));

