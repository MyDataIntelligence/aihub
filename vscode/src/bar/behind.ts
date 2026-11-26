import { plainError } from "./plainError";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gitDirFor, headBranchOf } from "../../../cli/src/lib/machineScan";
import type { GitRaw, GitRun } from "./ownWindow";

/**
 * A repository that is behind its target branch: when to look (cheap, never without focus), what an update would do
 * (conflicts decided beforehand with `git merge-tree`, the working folder untouched), what to ask or do, and the update
 * itself through `aihub branch update`. No vscode here: the notifications and settings come in as functions.
 */
export type BehindMode = "ask" | "auto" | "off";

export const FETCH_FRESH_MS = 30 * 60_000;
export const FETCH_FAILED_MS = 10 * 60_000;

/** Fetches of the target branch: after each other, a failed one remembered 10 minutes, a fresh one (focus back) only after 30 minutes. */
export class FetchGate {
  private last = new Map<string, { ok: boolean; at: number }>();
  /** a fetch failed because there is no network: nothing is fetched until then (one quiet failure, not one per repository) */
  private offlineUntil = 0;
  constructor(
    private git: GitRun,
    private now: () => number = Date.now,
    /** the last fetch of each repository, kept in a file so a reload or a second window on the same set does not fetch again */
    private store?: FetchStore,
  ) {}

  private known(k: string): { ok: boolean; at: number } | undefined {
    const mine = this.last.get(k);
    const kept = this.store?.read()[k];
    return mine && kept ? (kept.at > mine.at ? kept : mine) : (mine ?? kept);
  }

  /** `reason`: "focus" is the cheap background trigger; the others fetch unless the same repository was fetched recently (by this window or another). */
  async fetch(path: string, target: string, reason: "open" | "own" | "menu" | "focus"): Promise<"fetched" | "skipped" | "failed"> {
    const k = path.toLowerCase();
    const had = this.known(k);
    const t = this.now();
    if (t < this.offlineUntil || (this.store?.read()["*offline"]?.at ?? 0) + FETCH_FAILED_MS > t) return "skipped";
    if (had && !had.ok && t - had.at < FETCH_FAILED_MS) return "skipped";
    if (had && had.ok && t - had.at < (reason === "focus" ? FETCH_FRESH_MS : reason === "own" ? 60_000 : 5 * 60_000)) return "skipped";
    try {
      await this.git(path, ["fetch", "--quiet", "origin", target]);
      this.remember(k, { ok: true, at: t });
      return "fetched";
    } catch (e) {
      this.remember(k, { ok: false, at: t });
      if (isOffline((e as Error).message)) {
        // no network: one failure is enough for all repositories, and it is not remembered per repository as a broken remote
        this.offlineUntil = t + FETCH_FAILED_MS;
        this.store?.write({ ...this.store.read(), "*offline": { ok: false, at: t } });
      }
      return "failed";
    }
  }

  private remember(k: string, v: { ok: boolean; at: number }): void {
    this.last.set(k, v);
    this.store?.write({ ...this.store.read(), [k]: v });
  }

  /** Was this repository fetched (successfully) by this window or an earlier one? Before that the count behind the target is not known and not asked. */
  has(path: string): boolean {
    return !!this.known(path.toLowerCase())?.ok;
  }

  /** When did the last successful fetch of any repository happen (for the focus trigger)? */
  lastOk(): number {
    const kept = Object.entries(this.store?.read() ?? {}).filter(([k, v]) => k !== "*offline" && v.ok).map(([, v]) => v.at);
    return Math.max(0, ...[...this.last.values()].filter((v) => v.ok).map((v) => v.at), ...kept);
  }
}

export interface FetchStore {
  read(): Record<string, { ok: boolean; at: number }>;
  write(rec: Record<string, { ok: boolean; at: number }>): void;
}

/** git's words for "there is no network" (not a broken remote or a missing branch). */
export const isOffline = (message: string): boolean => /could not resolve host|unable to access|network is unreachable|connection (timed out|refused|reset)|timed out|no route to host|temporary failure in name resolution|could not read from remote|early eof/i.test(message);

/** The first state of a window starts the look at the target branch only a few seconds after the window opened, never before. */
export const OPEN_CHECK_AFTER_MS = 5_000;
export function openCheckDelay(activatedAt: number, now: number, minMs = OPEN_CHECK_AFTER_MS): number {
  return Math.max(0, minMs - (now - activatedAt));
}

export interface BehindFacts {
  name: string;
  path: string;
  branch: string;
  target: string;
  /** commits the target has that the branch lacks */
  behind: number;
  /** the commit origin/<target> is at: the same stand is told once */
  targetSha: string;
  /** files that would conflict; "unknown" when this git cannot say (older than 2.38): then it is always asked */
  conflicts: string[] | "unknown";
  /** files the update changes that also have uncommitted changes */
  overlap: string[];
  /** the target is named by team.yaml or the set file: only then it is passed as --target (else the CLI derives its own) */
  sure: boolean;
  /** files with uncommitted changes to tracked files: while there are any, nothing is updated by itself */
  tracked: number;
  /** why nothing is done to this repository (merge or rebase running, detached HEAD, on the target itself) */
  blocked?: string;
  /** where HEAD was before, for Undo */
  head: string;
}

const gitDir = (path: string) => gitDirFor(path);

/** A merge, rebase, cherry-pick or revert in progress: never update in the middle of one. */
export function operationInProgress(path: string): string | undefined {
  const d = gitDir(path);
  if (!d) return undefined;
  for (const [file, what] of [["MERGE_HEAD", "a merge"], ["rebase-merge", "a rebase"], ["rebase-apply", "a rebase"], ["CHERRY_PICK_HEAD", "a cherry-pick"], ["REVERT_HEAD", "a revert"]] as const) if (existsSync(join(d, file))) return what;
  return undefined;
}

/** What an update of one repository would do. Reads only (merge-tree writes objects, never the working folder). Undefined: not behind, or nothing to say. */
export async function inspect(git: GitRun, raw: GitRaw, r: { name: string; path: string; branch?: string; changes?: number }, target: string, count?: (path: string, name: string) => Promise<number | undefined>, sure = false): Promise<BehindFacts | undefined> {
  if (!r.branch || r.branch === target) return undefined;
  // the count is one git call (shared with the state); the commits are read from the files
  const behind = (count ? await count(r.path, r.name) : Number((await git(r.path, ["rev-list", "--count", `HEAD..origin/${target}`]).catch(() => "0")).trim())) || 0;
  if (!behind) return undefined;
  const targetSha = refSha(r.path, `refs/remotes/origin/${target}`) ?? (await git(r.path, ["rev-parse", `origin/${target}`]).catch(() => "")).trim();
  const head = headSha(r.path) ?? (await git(r.path, ["rev-parse", "HEAD"]).catch(() => "")).trim();
  const base = { name: r.name, path: r.path, branch: r.branch, target, behind, targetSha, head, conflicts: [] as string[] | "unknown", overlap: [] as string[], tracked: 0, sure };
  const busy = operationInProgress(r.path);
  if (busy) return { ...base, blocked: `${busy} is in progress` };
  // conflicts beforehand, without touching the working folder
  const m = await raw(r.path, ["merge-tree", "--write-tree", "--name-only", "HEAD", `origin/${target}`]);
  if (m.code === 0) base.conflicts = [];
  else if (m.code === 1) {
    // the tree id, then the names of the conflicted files, then an empty line, then git's messages
    const lines = m.out.split(/\r?\n/).slice(1);
    const end = lines.indexOf("");
    base.conflicts = [...new Set((end === -1 ? lines : lines.slice(0, end)).map((l) => l.trim()).filter(Boolean))];
    if (!base.conflicts.length) base.conflicts = "unknown";
  } else base.conflicts = "unknown";
  // uncommitted work that the update would touch
  // uncommitted work, read the safe way (-z: renames, spaces, non-ASCII names, untracked folders): `tracked` decides whether
  // auto may update at all; the overlap only says in the question what would collide
  const st = r.changes === 0 ? { tracked: [] as string[], untracked: [] as string[] } : parseStatusZ(await git(r.path, ["-c", "core.quotepath=false", "status", "--porcelain=v1", "-z"]).catch(() => ""));
  base.tracked = st.tracked.length;
  if (st.tracked.length || st.untracked.length) {
    const changed = (await git(r.path, ["-c", "core.quotepath=false", "diff", "--name-only", "-z", `HEAD...origin/${target}`]).catch(() => "")).split("\0").filter(Boolean);
    const set = new Set(changed);
    base.overlap = [...st.tracked, ...st.untracked].filter((f) => (f.endsWith("/") ? changed.some((c) => c.startsWith(f)) : set.has(f)));
  }
  return base;
}

export type Decision = "none" | "auto" | "ask" | "ask-conflict";

/** off: nothing. Conflicts (or no way to check): the question, never by itself. auto: no conflicts and no changes to tracked files. Otherwise ask. */
export function decide(mode: BehindMode, f: BehindFacts): Decision {
  if (mode === "off" || f.blocked || f.behind === 0) return "none";
  if (f.conflicts === "unknown" || f.conflicts.length) return "ask-conflict";
  // by itself only when the working folder has no changes to tracked files; otherwise always the question
  if (mode === "auto" && f.tracked === 0 && f.overlap.length === 0) return "auto";
  return "ask";
}

const commits = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;
const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;

/** "repo-a is 14 commits behind staging · no conflicts" / "· 3 files will conflict" / "· your uncommitted changes touch 2 of them". */
export function behindMessage(f: BehindFacts): string {
  const tail = f.conflicts === "unknown" ? "cannot tell whether it conflicts" : f.conflicts.length ? `${files(f.conflicts.length)} will conflict` : f.overlap.length ? `no conflicts, but your uncommitted changes touch ${f.overlap.length} of the changed files` : f.tracked ? "no conflicts, but you have uncommitted changes" : "no conflicts";
  return `${f.name} is ${commits(f.behind)} behind ${f.target} · ${tail}`;
}

export const setMessage = (facts: BehindFacts[]) => `${facts.length} repositories are behind ${[...new Set(facts.map((f) => f.target))].join(", ")}`;

/** Remembers which stand was told (repository, branch, commit of the target): the same stand is never told twice. */
export class Told {
  private keys = new Set<string>();
  constructor(
    private load: () => string[] = () => [],
    private save: (keys: string[]) => void = () => undefined,
  ) {
    this.keys = new Set(load());
  }
  key = (f: BehindFacts) => `${f.path.toLowerCase()}|${f.branch}|${f.targetSha}`;
  has(f: BehindFacts): boolean {
    return this.keys.has(this.key(f));
  }
  add(f: BehindFacts): void {
    this.keys.add(this.key(f));
    this.save([...this.keys].slice(-200));
  }
}

export interface UpdateResult {
  name: string;
  ok: boolean;
  line: string;
  /** commit before the update: Undo puts the branch back there (only while nothing is pushed) */
  before?: string;
  /** the commit the update made: Undo only goes back while HEAD is exactly this one */
  after?: string;
}

/** The team's way (merge or rebase after team.yaml): `aihub branch update`, in that repository. */
export async function updateRepo(cli: (args: string[], cwd: string) => Promise<string>, git: GitRun, f: BehindFacts): Promise<UpdateResult> {
  try {
    await cli(["branch", "update", "--no-push", ...(f.sure ? ["--target", f.target] : [])], f.path);
    const now = headSha(f.path) ?? (await git(f.path, ["rev-parse", "HEAD"]).catch(() => "")).trim();
    return { name: f.name, ok: true, before: f.head, after: now, line: `${f.name} updated from ${f.target} (${commits(f.behind)})${now === f.head ? " (nothing changed)" : ""}` };
  } catch (e) {
    return { name: f.name, ok: false, line: `${f.name}: not updated, ${plainError((e as Error).message).text}` };
  }
}

/** Undo of an update: only while the new commits are not pushed; `git reset --keep` keeps what is uncommitted and refuses when that would be lost. */
export async function undoUpdate(git: GitRun, r: { name: string; path: string; branch: string; before: string; after: string }): Promise<{ problem?: string }> {
  // only this very update, on this very branch: never another branch, never a commit of the user
  if (!existsSync(r.path)) return { problem: `${r.name} is not there any more` };
  if (headBranchOf(r.path) !== r.branch) return { problem: `${r.name} is not on ${r.branch} any more; the update stays` };
  const busy = operationInProgress(r.path);
  if (busy) return { problem: `${busy} is in progress in ${r.name}; finish or abort it first` };
  if ((headSha(r.path) ?? (await git(r.path, ["rev-parse", "HEAD"]).catch(() => "")).trim()) !== r.after) return { problem: `${r.name} has new commits since the update; they would be lost, so the update stays` };
  const pushed = await git(r.path, ["merge-base", "--is-ancestor", "HEAD", `origin/${r.branch}`]).then(() => true, () => false);
  if (pushed) return { problem: `${r.name} is pushed since; the update stays` };
  try {
    await git(r.path, ["reset", "--keep", r.before]);
    return {};
  } catch (e) {
    return { problem: `${r.name} cannot go back without losing uncommitted work: ${(e as Error).message}` };
  }
}

/** The commit a ref points at, read from the files of the repository (loose ref, else packed-refs): no process. */
export function refSha(path: string, ref: string): string | undefined {
  const dir = gitDirFor(path);
  if (!dir) return undefined;
  const common = /[\\/]worktrees[\\/][^\\/]+$/.test(dir) ? join(dir, "..", "..") : dir;
  try {
    return readFileSync(join(common, ...ref.split("/")), "utf8").trim();
  } catch {
    try {
      return readFileSync(join(common, "packed-refs"), "utf8").split(/\r?\n/).find((l) => l.endsWith(` ${ref}`))?.split(" ")[0];
    } catch {
      return undefined;
    }
  }
}

/** The commit HEAD is at, from the files: follows `ref: refs/heads/x`; a detached HEAD holds the commit itself. */
export function headSha(path: string): string | undefined {
  const dir = gitDirFor(path);
  if (!dir) return undefined;
  try {
    const h = readFileSync(join(dir, "HEAD"), "utf8").trim();
    const m = /^ref:\s*(.+)$/.exec(h);
    return m ? refSha(path, m[1]) : h;
  } catch {
    return undefined;
  }
}

/** `git status --porcelain=v1 -z`: the tracked files with changes (a rename counts as its new name) and the untracked ones. */
export function parseStatusZ(out: string): { tracked: string[]; untracked: string[] } {
  const parts = out.split("\0");
  const tracked: string[] = [];
  const untracked: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    const name = e.slice(3);
    if (xy === "??") untracked.push(name);
    else if (xy !== "!!") tracked.push(name);
    // a rename or copy is followed by the old name as an entry of its own
    if (/[RC]/.test(xy)) i++;
  }
  return { tracked, untracked };
}
