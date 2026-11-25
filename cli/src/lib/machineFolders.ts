import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { configHome } from "./configHome.js";
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

/** The usual places people keep repositories, the ones that exist (a first look when nothing is known yet). */
export function commonRoots(env: NodeJS.ProcessEnv = process.env, home = homedir(), exists: (p: string) => boolean = existsSync): string[] {
  // AIHUB_COMMON_ROOTS (a path list; folders that do not exist count for nothing, so "none" means none; Windows has no empty variables) replaces the usual places: tests and isolated profiles
  if (env.AIHUB_COMMON_ROOTS !== undefined) return env.AIHUB_COMMON_ROOTS.split(delimiter).filter((p) => p && exists(p));
  const rel = ["source/repos", "repos", "git", "code", "projects", "dev", "src", "work", "Documents/GitHub", "PycharmProjects"];
  const drives = process.platform === "win32" ? ["C:\\", "D:\\"].flatMap((d) => ["git", "work", "dev", "repos", "src", "code"].map((n) => join(d, n))) : [];
  return [...rel.map((r) => join(home, r)), ...drives].filter((p) => exists(p));
}

/** Clones the user's own aihub config names: repository groups and preferred clones (`groups.json`, `repos.json`). */
export function configuredClones(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  const read = (name: string): unknown => {
    try {
      return JSON.parse(readFileSync(join(configHome(env), name), "utf8"));
    } catch {
      return undefined;
    }
  };
  const groups = (read("groups.json") as { groups?: Record<string, { path?: string }[]> } | undefined)?.groups ?? {};
  for (const g of Object.values(groups)) for (const r of Array.isArray(g) ? g : []) if (typeof r?.path === "string") out.push(r.path);
  const prefer = (read("repos.json") as { prefer?: Record<string, string> } | undefined)?.prefer ?? {};
  for (const p of Object.values(prefer)) if (typeof p === "string") out.push(p);
  return out;
}

/** Paths this PC is known to use: the folder in use (a set or a repository), the recent items, the configured clones, `extra`. */
export function knownPlaces(env: NodeJS.ProcessEnv, inUse?: string, extra: string[] = []): string[] {
  // a workspace file stands for the set folder it is in (and the clones that set came from)
  const k: string[] = [...extra.flatMap((p) => (p.endsWith(".code-workspace") ? setPlaces(dirname(p)) : [p])), ...configuredClones(env)];
  const set = inUse ? findSet(inUse) : undefined;
  if (set) k.push(...setPlaces(set.folder));
  else if (inUse) {
    const root = repoRootOf(inUse);
    if (root) k.push(root);
  }
  for (const r of readRecentUse(env)) k.push(...(r.kind === "set" ? setPlaces(dirname(r.id)) : [r.id]));
  return k;
}

/** The personal list, else the parents of everything known plus the usual folders that exist; nested ones are covered by their parent. */
export function machineFolders(env: NodeJS.ProcessEnv, inUse?: string, extra: string[] = [], roots: string[] = commonRoots(env)): string[] {
  if (readLookIn(env)) return lookInFolders(env, []);
  return prune([...new Map([...lookInFolders(env, knownPlaces(env, inUse, extra)), ...roots].map((f) => [pathKey(f), f])).values()]);
}

export function scanThisPc(env: NodeJS.ProcessEnv, inUse?: string, o: { refresh?: boolean; now?: number } = {}): Scan {
  return scanMachine(env, machineFolders(env, inUse), o);
}
