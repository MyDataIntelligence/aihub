import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gitDirFor, headBranchOf } from "../../../cli/src/lib/machineScan";
import { headSha, refSha } from "./behind";
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
    /** fires when the status of the repository changed (a commit, a pull, a saved file) */
    onDidChange?: (listener: () => void) => { dispose(): void };
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
export const TEAM_YAML = ".agents/skills/_shared/references/team.yaml";

/**
 * `defaultTarget` of the repository `name` in the text of team.yaml: the item of `repositories:` with that name, or the only
 * item when it has no name. A line reader for this one key, so the extension needs no yaml parser.
 */
export function teamTargetOf(text: string, name: string): string | undefined {
  const items: { name?: string; target?: string }[] = [];
  let inRepos = false;
  let itemIndent = -1;
  let keyIndent = -1;
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
    const indent = raw.length - raw.trimStart().length;
    // a list or a map nested inside an item (reviewers, branches...) is not another item and its keys are not the item's
    if (dash) {
      if (itemIndent === -1) itemIndent = indent;
      if (indent !== itemIndent) continue;
      keyIndent = -1;
    } else {
      if (keyIndent === -1) keyIndent = indent;
      if (indent !== keyIndent) continue;
    }
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

/** What `[branch "<b>"]` in the clone's config says it merges with (the upstream), without `refs/heads/`. */
function configMerge(common: string, branch: string): string | undefined {
  try {
    let inBranch = false;
    for (const line of readFileSync(join(common, "config"), "utf8").split(/\r?\n/)) {
      const sec = /^\s*\[\s*([^\]]+?)\s*\]/.exec(line);
      if (sec) {
        inBranch = sec[1].toLowerCase() === `branch "${branch}"`.toLowerCase();
        continue;
      }
      const kv = inBranch ? /^\s*merge\s*=\s*(\S+)/i.exec(line) : null;
      if (kv) return kv[1].replace(/^refs\/heads\//, "");
    }
  } catch {
    /* no config */
  }
  return undefined;
}

/**
 * The branch this one was cut from, from local files only (the same signals as the CLI: the upstream, "branch: Created
 * from X" in the branch's own reflog, "checkout: moving from X to <b>" in the HEAD reflog), taken only when origin has it.
 * A hotfix branch cut from main is thereby never measured against staging.
 */
export function derivedTarget(path: string, branch: string): string | undefined {
  const common = commonDirOf(path);
  if (!common || !branch) return undefined;
  const ok = (c: string | undefined) => (c && c !== branch && c !== "HEAD" && !/^[0-9a-f]{7,40}$/.test(c) && originHas(path, c) ? c : undefined);
  const upstream = ok(configMerge(common, branch));
  if (upstream) return upstream;
  const read = (rel: string): string[] => {
    try {
      return readFileSync(join(common, ...rel.split("/")), "utf8").split(/\r?\n/).filter(Boolean);
    } catch {
      return [];
    }
  };
  const msg = (l: string) => l.slice(l.indexOf("\t") + 1);
  const created = read(`logs/refs/heads/${branch}`).map(msg).map((m) => /^branch: Created from (\S+)$/.exec(m)?.[1]).find(Boolean);
  const fromCreated = ok(created?.replace(/^(refs\/remotes\/)?origin\//, "").replace(/^refs\/heads\//, ""));
  if (fromCreated) return fromCreated;
  const esc = branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const moved = read("logs/HEAD").slice(-500).map(msg).map((m) => new RegExp(`^checkout: moving from (\\S+) to ${esc}$`).exec(m)?.[1]).filter(Boolean).pop();
  return ok(moved);
}

/** The base the set file names for a repository (the extension's `.worktree-set.json`: `repos[].base`, else the set's `base`). */
export function setBaseOf(setFolder: string | undefined, name: string): string | undefined {
  if (!setFolder) return undefined;
  try {
    const j = JSON.parse(readFileSync(join(setFolder, ".worktree-set.json"), "utf8").replace(/^﻿/, "")) as { base?: unknown; repos?: { name?: unknown; base?: unknown }[] };
    const own = j.repos?.find((r) => typeof r.name === "string" && r.name.toLowerCase() === name.toLowerCase())?.base;
    const v = typeof own === "string" && own ? own : typeof j.base === "string" && j.base ? j.base : undefined;
    return v?.replace(/^origin\//, "");
  } catch {
    return undefined;
  }
}

export interface TargetInfo {
  target: string;
  /** named by team.yaml or by the set file: safe to pass as --target; else the CLI is left to derive its own */
  sure: boolean;
}

/**
 * The branch a repository is kept up to date with and pull requests go to: team.yaml; the base of the set file; the branch
 * it was cut from (local files); else `staging` when origin has it; else what origin/HEAD says; else `main`. One function for
 * behind-the-target, the update question and Create Pull Requests. Files only.
 */
export function targetInfo(path: string, name: string, o: { setFolder?: string } = {}): TargetInfo {
  try {
    const t = teamTargetOf(readFileSync(join(path, TEAM_YAML), "utf8"), name);
    if (t) return { target: t, sure: true };
  } catch {
    /* no team.yaml here */
  }
  const base = setBaseOf(o.setFolder, name);
  if (base) return { target: base, sure: true };
  const cut = derivedTarget(path, headBranchOf(path));
  if (cut) return { target: cut, sure: false };
  if (originHas(path, "staging")) return { target: "staging", sure: false };
  const common = commonDirOf(path);
  try {
    const head = common ? readFileSync(join(common, "refs", "remotes", "origin", "HEAD"), "utf8") : "";
    return { target: /refs\/remotes\/origin\/(.+)/.exec(head)?.[1].trim() ?? "main", sure: false };
  } catch {
    return { target: "main", sure: false };
  }
}

export const targetOf = (path: string, name: string, o: { setFolder?: string } = {}): string => targetInfo(path, name, o).target;

/** How far behind the target each repository is: one `git rev-list --count` after a HEAD change, then remembered until forget(). */
export class BehindMemo {
  private seen = new Map<string, { at: string; n: Promise<number | undefined>; failed?: boolean }>();
  constructor(private git: GitRun) {}

  /**
   * The count is remembered for the pair of commits it was made at (HEAD and origin/<target>, read from the files, no
   * process): a commit, a merge or a pull in a terminal, or a fetch, changes the pair and the next question counts again.
   */
  behind(path: string, name: string): Promise<number | undefined> {
    const k = key(path);
    const target = targetOf(path, name);
    const at = `${headSha(path)}|${refSha(path, `refs/remotes/origin/${target}`)}|${target}`;
    const had = this.seen.get(k);
    if (had && had.at === at) return had.n;
    const p = this.git(path, ["rev-list", "--count", `HEAD..origin/${target}`]).then(
      (out) => Number(out.trim()) || 0,
      () => undefined,
    );
    const entry: { at: string; n: Promise<number | undefined>; failed?: boolean } = { at, n: p };
    void p.then((v) => void (entry.failed = v === undefined));
    this.seen.set(k, entry);
    return p;
  }

  /**
   * One repository forgets its count. Without a path only the counts that failed are dropped: a good count is tied to the pair
   * of commits it was made at, so a fetch, an update or an action changes the pair by itself and nothing is counted again for nothing.
   */
  forget(path?: string): void {
    if (path) this.seen.delete(key(path));
    else for (const [k, e] of this.seen) if (e.failed) this.seen.delete(k);
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
  build?: "succeeded" | "failed" | "running";
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
  if (r.build === "failed" || votes.some((v) => v.vote <= -5) || r.mergeStatus === "conflicts" || r.mergeStatus === "failure" || r.mergeStatus === "rejectedByPolicy") return "failed";
  const required = votes.filter((v) => v.required);
  if (votes.some((v) => v.vote >= 5) && required.every((v) => v.vote >= 5)) return "approved";
  return "active";
}

/** The pull request of a branch: an open one first, else the newest merged one. */
export function prOfBranch(rows: PrRow[], repo: string, branch: string): BarPr | undefined {
  const mine = rows.filter((r) => r.repo.toLowerCase() === repo.toLowerCase() && r.source === branch);
  const best = mine.find((r) => r.status === "active") ?? mine.find((r) => r.status === "completed");
  const status = best && prStateOf(best);
  return best && status ? { id: best.id, status, url: best.url, ...(best.build ? { build: best.build } : {}) } : undefined;
}

export const PR_TTL_MS = 5 * 60_000;

/** One `aihub pr list` for the whole set, remembered for minutes; a failed call is remembered as long as a good one (no retry on every event). */
export class PrMemo {
  private rows: PrRow[] = [];
  private at = 0;
  private running?: Promise<void>;
  constructor(private fetch: (builds: boolean) => Promise<PrRow[]>, private now: () => number = Date.now) {}

  get(): PrRow[] {
    return this.rows;
  }

  /** Reads again unless it was read less than PR_TTL_MS ago (`force`: the overview menu or a refresh asks). Never throws. Resolves true when it read, false when the memory was still fresh (nothing changed, nobody needs telling). */
  refresh(force = false): Promise<boolean> {
    if (this.running) return this.running.then(() => false);
    if (!force && this.at && this.now() - this.at < PR_TTL_MS) return Promise.resolve(false);
    // the build policies cost one read per active pull request: only when asked for (the overview menu, Create Pull Requests), never when a set opens
    this.running = this.fetch(force)
      .then((r) => void (this.rows = r))
      .catch(() => undefined)
      .finally(() => {
        this.at = this.now();
        this.running = undefined;
      });
    const run = this.running;
    return run.then(() => true);
  }
}

/** A branch of the story: linked in the story's files or named after it (the story number first in the name). */
export const isStoryBranch = (story: number, branch: string, linked: string[]): boolean => !!story && (linked.includes(branch) || branchNamedForStory(branch, story));


/** `branches.protected` of team.yaml (an inline list or a block list): branches nothing here pushes. Files only. */
export function protectedBranches(path: string): string[] {
  try {
    const lines = readFileSync(join(path, TEAM_YAML), "utf8").replace(/\r\n/g, "\n").split("\n");
    const i = lines.findIndex((l) => /^\s+protected:/.test(l));
    if (i < 0) return [];
    const inline = /^\s+protected:\s*\[(.*)\]/.exec(lines[i]);
    if (inline) return inline[1].split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    const out: string[] = [];
    for (let k = i + 1; k < lines.length; k++) {
      const m = /^\s+-\s+(\S+)/.exec(lines[k]);
      if (!m) break;
      out.push(m[1].replace(/^["']|["']$/g, ""));
    }
    return out;
  } catch {
    return [];
  }
}
