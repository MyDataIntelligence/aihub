import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { configHome } from "../configHome.js";
import type { Ctx } from "../context.js";
import { gitCommonDir } from "../storyWorktrees.js";
import { readSetFile } from "../setFile.js";
import { scanThisPc } from "../machineFolders.js";

/**
 * Where the test status of the criteria and the progress of a run are kept for one story: in the story's set folder
 * (next to the set file) when the work runs in a set, else in the repository's `.git/aihub/` (shared by its worktrees,
 * never committed), else in the user's config folder. Plain JSON files, so the bar can watch one of them.
 */

const SET_FILES = [".aihub-set.json", ".worktree-set.json"];

/** The set folder that holds `dir` (the folder itself or a parent), if any. No git process. */
export function setFolderOf(dir: string): string | undefined {
  let d = resolve(dir);
  for (let i = 0; i < 6; i++) {
    if (SET_FILES.some((f) => existsSync(join(d, f)))) return d;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return undefined;
}

export type StateKind = "criteria" | "run";

/** The set of this story: the set this runs in when it is the story's, else the story's set on this PC (cached scan). */
export function storySetFolder(ctx: Ctx, id: number): string | undefined {
  const here = setFolderOf(ctx.cwd);
  if (here && readSetFile(here)?.top.story === id) return here;
  try {
    return scanThisPc(ctx.env, ctx.cwd, { now: (ctx.now ?? Date.now)() }).sets.find((x) => x.story === id && x.repos.some((r) => r.exists))?.folder;
  } catch {
    return undefined;
  }
}

export function stateFile(ctx: Ctx, id: number, kind: StateKind, setFolder?: string): string {
  // the same file from every window: the story's set folder first, so the bar of another window reads what the agent wrote
  const set = setFolder ?? storySetFolder(ctx, id);
  if (set) return join(set, `.aihub-${kind}-${id}.json`);
  const common = gitCommonDir(ctx.cwd);
  if (common) return join(common, "aihub", `${kind}-${id}.json`);
  return join(configHome(ctx.env), "stories", `${kind}-${id}.json`);
}

export function readState<T>(file: string, empty: T): T {
  try {
    return { ...empty, ...(JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as T) };
  } catch {
    return empty;
  }
}

export function writeState(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}

// ---- test status per criterion ---------------------------------------------------------------------------------------

export type Result = "pass" | "fail" | "notrun";

export interface Record_ {
  n: number;
  text: string;
  result: Result;
  evidence?: string;
  reason?: string;
  at: string;
}

export interface CriteriaState {
  schema: 1;
  id: number;
  /** criterion key (criterionKey of its text) -> the last recorded result */
  records: Record<string, Record_>;
}

// ---- progress of a run -----------------------------------------------------------------------------------------------

export interface RunState {
  schema: 1;
  id: number;
  running: boolean;
  step: number;
  total: number;
  label: string;
  steps: string[];
  updatedAt: string;
  action?: string;
  /** the options of the run (planFirst, fabric, setActive; draft/anyway for story-pr), read by `prompt render` */
  options?: Record<string, boolean>;
  /** the user pressed Stop */
  stopped?: boolean;
  /** the agent waits for the user (set by the agent at a plan stop or before a question; cleared when the run goes on) */
  waiting?: boolean;
  /** what it waits for: the plan to approve, an answer, or an approval of an action */
  waitingFor?: "plan" | "input" | "approval";
  /** the plan file the agent wrote, when it waits for the plan */
  planFile?: string;
}
