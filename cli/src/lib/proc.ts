import * as cp from "node:child_process";

/**
 * The only way aihub starts a child process. Every call gets `windowsHide: true`, so no console window ever appears or
 * takes focus on Windows (watchers, git polls, toast PowerShell, az, node). A caller can still pass
 * `windowsHide: false` when a window is the point (the terminal `aihub open` starts for the developer).
 */
export function withHidden(args: unknown[]): unknown[] {
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

export const spawnSync: SpawnSyncFn = ((...a: unknown[]) => rawSync(...withHidden(a))) as SpawnSyncFn;
export const spawn: SpawnFn = ((...a: unknown[]) => rawSpawn(...withHidden(a))) as SpawnFn;
