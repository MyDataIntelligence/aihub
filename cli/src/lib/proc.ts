import * as cp from "node:child_process";
import { perfOn, recordChild } from "./perf.js";
import { isGitCommand, scrubGitOptions } from "./gitEnv.js";

/**
 * The only way aihub starts a child process. Every call gets `windowsHide: true`, so no console window ever appears or
 * takes focus on Windows (watchers, git polls, toast PowerShell, az, node). A caller can still pass
 * `windowsHide: false` when a window is the point (the terminal `aihub open` starts for the developer).
 */
export function withHidden(args: unknown[]): unknown[] {
  return hide(isGitCommand(args[0]) ? withGitEnvironment(args) : args);
}

/** A git process never inherits GIT_DIR and the other repository variables (see gitEnv.ts). */
function withGitEnvironment(args: unknown[]): unknown[] {
  const at = args.length > 1 && args[args.length - 1] && typeof args[args.length - 1] === "object" && !Array.isArray(args[args.length - 1]) ? args.length - 1 : -1;
  return at >= 0 ? [...args.slice(0, at), scrubGitOptions(args[at])] : [...args, scrubGitOptions(undefined)];
}

function hide(args: unknown[]): unknown[] {
  const last = args[args.length - 1];
  if (last && typeof last === "object" && !Array.isArray(last)) {
    const o = last as Record<string, unknown>;
    return [...args.slice(0, -1), o.windowsHide === undefined ? { ...o, windowsHide: true } : o];
  }
  return [...args, { windowsHide: true }];
}

const rawSync = cp.spawnSync as unknown as (...x: unknown[]) => unknown;
const rawSpawn = cp.spawn as unknown as (...x: unknown[]) => unknown;
type SpawnSyncFn = typeof cp.spawnSync;
type SpawnFn = typeof cp.spawn;

export const spawnSync: SpawnSyncFn = ((...a: unknown[]) => {
  if (!perfOn()) return rawSync(...withHidden(a));
  const t0 = performance.now();
  const r = rawSync(...withHidden(a)) as { status?: number | null };
  recordChild(a[0], a[1], performance.now() - t0, r?.status);
  return r;
}) as SpawnSyncFn;
export const spawn: SpawnFn = ((...a: unknown[]) => {
  const child = rawSpawn(...withHidden(a)) as cp.ChildProcess;
  if (perfOn()) {
    const t0 = performance.now();
    child.once("close", (code) => recordChild(a[0], a[1], performance.now() - t0, code));
  }
  return child;
}) as SpawnFn;
