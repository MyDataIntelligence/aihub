import type { SetMeta } from "../../../cli/src/lib/setFile";

/**
 * The set file changed by hand (the window's own set file): what it asks for, worked out before anything is done.
 * Pure. A file that cannot be read gives one problem line and no action: nothing is applied half.
 */
export type SetFileAction = { kind: "switch"; repo: string; branch: string } | { kind: "repair"; repos: string[] };

export interface SetFilePlan {
  /** why the file cannot be applied; when there is one, `actions` is empty */
  problem?: string;
  actions: SetFileAction[];
  /** things changed in the file that are left as they are, said in one line */
  notes: string[];
  /** repositories whose real HEAD differs from the file but whose entry did not change in the file: the real HEAD wins, the file is brought in line (no switch) */
  follow?: string[];
}

/** The branch each repository of a set file is on, as the file says (its own, else the set's). */
export const snapshotOf = (meta: Pick<SetMeta, "branch" | "repos">): Map<string, string> => new Map(meta.repos.map((r) => [r.name, r.branch || meta.branch]));

export interface ActualRepo {
  name: string;
  /** the worktree folder exists */
  exists: boolean;
  /** its checked-out branch ("" when unknown or detached) */
  branch: string;
}

/** The text of a set file as JSON, or the reason it is not. */
export function parseSetFile(text: string): { json?: unknown; problem?: string } {
  try {
    return { json: JSON.parse(text.replace(/^﻿/, "")) };
  } catch (e) {
    return { problem: `the set file is not valid JSON (${(e as Error).message.replace(/\s+/g, " ").slice(0, 90)})` };
  }
}

/** What is wrong with a parsed set (or fine): story, branch and repositories with names. */
export function checkMeta(meta: Partial<SetMeta> | undefined): string | undefined {
  if (!meta || typeof meta !== "object") return "the set file holds no set";
  if (typeof meta.branch !== "string" || !meta.branch.trim()) return "the set file has no branch";
  if (!Array.isArray(meta.repos) || !meta.repos.length) return "the set file lists no repositories";
  const names = meta.repos.map((r) => (r && typeof r.name === "string" ? r.name.trim() : ""));
  if (names.some((n) => !n)) return "a repository in the set file has no name";
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) return `${dup} is in the set file twice`;
  return undefined;
}

/**
 * A repository whose branch in the file differs from what is checked out is switched (the line "change this to switch");
 * a repository without a worktree is made (`aihub worktree repair`); a repository that left the file is only mentioned.
 */
export function planSetFile(meta: Pick<SetMeta, "branch" | "repos">, actual: ActualRepo[], previous?: Map<string, string>): SetFilePlan {
  const problem = checkMeta(meta);
  if (problem) return { problem, actions: [], notes: [] };
  const by = new Map(actual.map((a) => [a.name, a]));
  const actions: SetFileAction[] = [];
  const missing: string[] = [];
  const follow: string[] = [];
  for (const r of meta.repos) {
    const have = by.get(r.name);
    const want = r.branch || meta.branch;
    if (!have || !have.exists) missing.push(r.name);
    else if (have.branch && have.branch !== want) {
      // only what changed IN THE FILE since it was last read is an order; a difference in a repository whose entry did not change means HEAD moved (a switch outside aihub): HEAD wins
      if (previous?.has(r.name) && previous.get(r.name) !== want) actions.push({ kind: "switch", repo: r.name, branch: want });
      else follow.push(r.name);
    }
  }
  if (missing.length) actions.unshift({ kind: "repair", repos: missing });
  const inFile = new Set(meta.repos.map((r) => r.name));
  const left = actual.filter((a) => !inFile.has(a.name)).map((a) => a.name);
  const notes = left.length ? [`${left.join(", ")} ${left.length === 1 ? "is" : "are"} no longer in the set file; the worktree stays (Remove from Set takes it away)`] : [];
  return { actions, notes, ...(follow.length ? { follow } : {}) };
}

/** One line about what was done (or what was found). */
export function summarizePlan(done: string[], notes: string[]): string {
  return ["Set file: " + (done.length ? done.join("; ") : "matches the folders"), ...notes].join(". ");
}
