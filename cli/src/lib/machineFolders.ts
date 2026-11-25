import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { lookInFolders, MAX_DEPTH, readLookIn, scanMachine, type Scan } from "./machineScan.js";
import { pathKey, readRecentUse } from "./recentUse.js";
import { readSetFile } from "./setFile.js";
import { findSet } from "./setInfo.js";

/**
 * Which folders to look in for repositories and sets, for the extension and for the CLI alike: the personal list
 * (`aihub` config home, `lookin.json`) when there is one, else the parents of what is known: the folder in use, the
 * recent items and where the sets' clones are. Node only: the VS Code extension bundles this file as it is.
 */

/** Where a set lives: its own folder and the clones its worktrees come from (their parent is where the repositories are). */
export function setPlaces(folder: string): string[] {
  const f = readSetFile(folder);
  return [folder, ...(f ? [f.top, ...(f.top.others ?? [])].flatMap((m) => m.repos.map((r) => r.source)) : [])];
}

/** The nearest folder up from `dir` (at most 6 levels) with a `.git`; undefined when none. */
export function repoRootOf(dir: string): string | undefined {
  let d = dir;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(d, ".git"))) return d;
    const up = dirname(d);
    if (up === d) return undefined;
    d = up;
  }
  return undefined;
}

/** Folders nested in another folder to look in, within the walk depth, are covered by it. */
export function prune(folders: string[]): string[] {
  return folders.filter(
    (f) =>
      !folders.some((g) => {
        if (g === f) return false;
        const a = pathKey(f);
        const b = pathKey(g);
        return a.startsWith(b + "/") && a.slice(b.length + 1).split("/").length < MAX_DEPTH;
      }),
  );
}

/** Paths this PC is known to use: the folder in use (a set or a repository) and the recent items. */
export function knownPlaces(env: NodeJS.ProcessEnv, inUse?: string): string[] {
  const k: string[] = [];
  const set = inUse ? findSet(inUse) : undefined;
  if (set) k.push(...setPlaces(set.folder));
  else if (inUse) {
    const root = repoRootOf(inUse);
    if (root) k.push(root);
  }
  for (const r of readRecentUse(env)) k.push(...(r.kind === "set" ? setPlaces(dirname(r.id)) : [r.id]));
  return k;
}

export function machineFolders(env: NodeJS.ProcessEnv, inUse?: string): string[] {
  return readLookIn(env) ? lookInFolders(env, []) : prune(lookInFolders(env, knownPlaces(env, inUse)));
}

export function scanThisPc(env: NodeJS.ProcessEnv, inUse?: string, o: { refresh?: boolean; now?: number } = {}): Scan {
  return scanMachine(env, machineFolders(env, inUse), o);
}
