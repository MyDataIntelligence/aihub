import { promises as fsp, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ScanSet } from "../../../cli/src/lib/machineScan";
import { writeAtomic } from "../../../cli/src/lib/setFile";
import type { BarPr } from "./types";

/**
 * Clean-up facts about a set: how much disk it holds (measured in the background when the menu opens, remembered until
 * the set changes) and whether everything in it is merged and nothing would be lost. No vscode here.
 */

export interface Measured {
  bytes: number;
  /** the walk stopped at its time limit: the real size is at least this */
  lowerBound?: boolean;
}

/** Bytes in the folders, links not followed, measured without blocking: the walk gives the event loop a turn every 200 entries; after `limitMs` it stops and says so. */
export async function measureDirs(paths: string[], o: { yieldEvery?: number; limitMs?: number; now?: () => number } = {}): Promise<Measured> {
  const every = o.yieldEvery ?? 200;
  const now = o.now ?? Date.now;
  const stopAt = o.limitMs === undefined ? undefined : now() + o.limitMs;
  let total = 0;
  let seen = 0;
  const stack = [...paths];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else {
        try {
          total += (await fsp.lstat(p)).size;
        } catch {
          /* gone while measuring */
        }
      }
      if (++seen % every === 0) {
        await new Promise((r) => setImmediate(r));
        if (stopAt !== undefined && now() > stopAt) return { bytes: total, lowerBound: true };
      }
    }
  }
  return { bytes: total };
}

export const sizeOfDirs = async (paths: string[], o: { yieldEvery?: number } = {}): Promise<number> => (await measureDirs(paths, o)).bytes;

/** What makes a measured size stale before its day is over: the worktrees the set holds (an added or dropped repository). */
export function setKey(s: Pick<ScanSet, "folder" | "repos">): string {
  return s.repos.map((r) => `${r.path}:${r.exists ? 1 : 0}`).join(",");
}

export const SIZE_TTL_MS = 24 * 60 * 60 * 1000;
export const SIZE_LIMIT_MS = 20_000;

interface SizeRecord {
  key: string;
  bytes: number;
  at: number;
  lowerBound?: boolean;
}

/**
 * Sizes per set, measured one set after the other in the background. The result is kept in a file with its time (shared by
 * windows and restarts): a set is measured at most once a day, or when its repositories changed, or when the user asks.
 * A walk that takes longer than the limit stops and leaves a lower bound. Nothing is measured while the window has no focus.
 */
export class SizeMemo {
  private sizes?: Map<string, SizeRecord>;
  private running = false;
  private measure: (paths: string[], limitMs: number) => Promise<number | Measured>;
  constructor(
    measure?: (paths: string[], limitMs: number) => Promise<number | Measured>,
    private o: { file?: string; now?: () => number; ttlMs?: number; limitMs?: number; focused?: () => boolean } = {},
  ) {
    this.measure = measure ?? ((paths, limitMs) => measureDirs(paths, { limitMs }));
  }

  private load(): Map<string, SizeRecord> {
    if (this.sizes) return this.sizes;
    this.sizes = new Map();
    if (this.o.file) {
      try {
        const rec = JSON.parse(readFileSync(this.o.file, "utf8")) as Record<string, SizeRecord>;
        for (const [id, r] of Object.entries(rec)) if (r && typeof r.bytes === "number" && typeof r.at === "number" && typeof r.key === "string") this.sizes.set(id, r);
      } catch {
        /* no file yet, or unreadable: measured again */
      }
    }
    return this.sizes;
  }

  private save(): void {
    if (!this.o.file) return;
    try {
      mkdirSync(dirname(this.o.file), { recursive: true });
      writeAtomic(this.o.file, JSON.stringify(Object.fromEntries(this.load())));
    } catch {
      /* the size is shown anyway */
    }
  }

  /** The remembered size of the set (even an old one, with its time): undefined when it was never measured or its repositories changed. */
  get(id: string, key: string): { bytes: number; at: number; lowerBound?: boolean } | undefined {
    const had = this.load().get(id);
    return had && had.key === key ? { bytes: had.bytes, at: had.at, ...(had.lowerBound ? { lowerBound: true } : {}) } : undefined;
  }

  /**
   * Measures the sets without a size of today; `done` runs after each one (the state changes). One run at a time. `force`
   * (the user asked for it) measures every set again.
   */
  async measureAll(sets: { id: string; key: string; paths: string[] }[], done: () => void, o: { force?: boolean } = {}): Promise<void> {
    if (this.running) return;
    if (!o.force && this.o.focused && !this.o.focused()) return;
    this.running = true;
    const now = this.o.now ?? Date.now;
    try {
      const mem = this.load();
      for (const id of [...mem.keys()]) if (!sets.some((s) => s.id === id)) mem.delete(id);
      for (const s of sets) {
        const had = this.get(s.id, s.key);
        if (!o.force && had && now() - had.at < (this.o.ttlMs ?? SIZE_TTL_MS)) continue;
        const m = await this.measure(s.paths, this.o.limitMs ?? SIZE_LIMIT_MS);
        const r = typeof m === "number" ? { bytes: m } : m;
        mem.set(s.id, { key: s.key, bytes: r.bytes, at: now(), ...(r.lowerBound ? { lowerBound: true } : {}) });
        this.save();
        done();
      }
    } finally {
      this.running = false;
    }
  }
}

export interface MergedFacts {
  pr: (repo: string, branch: string) => BarPr | undefined;
  /** changed files of a worktree; undefined when it cannot say */
  changes: (path: string) => Promise<number | undefined>;
  /** commits that are on no remote; undefined when it cannot say */
  unpushed: (path: string) => Promise<number | undefined>;
}

/** Every repository of the set has a merged pull request for its branch (read from the one memory of pull requests; no call). */
export const allPrsMerged = (s: Pick<ScanSet, "repos">, pr: MergedFacts["pr"]): boolean => {
  const live = s.repos.filter((r) => r.exists);
  return live.length > 0 && live.every((r) => pr(r.name, r.branch)?.status === "merged");
};

/**
 * allMerged: every repository has a merged pull request AND nothing in the set would be lost: no uncommitted file and no
 * commit that is on no remote. Unknown counts as not merged (never offer to remove on a guess).
 */
export async function allMerged(s: Pick<ScanSet, "repos">, f: MergedFacts): Promise<boolean> {
  if (!allPrsMerged(s, f.pr)) return false;
  for (const r of s.repos.filter((x) => x.exists)) {
    const [changes, unpushed] = await Promise.all([f.changes(r.path), f.unpushed(r.path)]);
    if (changes !== 0 || unpushed !== 0) return false;
  }
  return true;
}
