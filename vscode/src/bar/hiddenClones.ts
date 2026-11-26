import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { configHome } from "../../../cli/src/lib/configHome";
import { pathKey } from "../../../cli/src/lib/recentUse";
import { writeAtomic } from "../../../cli/src/lib/setFile";

/** Clones the user took out of the list ("Remove from List"): only the list, the folder stays. Personal, in the aihub config home. No vscode here. */
const file = (env: NodeJS.ProcessEnv) => join(configHome(env), "hidden-clones.json");

export function readHiddenClones(env: NodeJS.ProcessEnv): string[] {
  try {
    const j = JSON.parse(readFileSync(file(env), "utf8")) as { paths?: unknown };
    return Array.isArray(j.paths) ? j.paths.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

export function hideClone(env: NodeJS.ProcessEnv, path: string): void {
  const paths = readHiddenClones(env);
  if (paths.some((p) => pathKey(p) === pathKey(path))) return;
  mkdirSync(configHome(env), { recursive: true });
  writeAtomic(file(env), JSON.stringify({ paths: [...paths, path] }, null, 2));
}

export function isHidden(hidden: string[], path: string): boolean {
  return hidden.some((p) => pathKey(p) === pathKey(path));
}

/** The clone to use for a repository from now on: the same file and format as `aihub repos prefer <name> <folder>` (repos.json). */
export function setPreferredClone(env: NodeJS.ProcessEnv, name: string, dir: string): void {
  const file = join(configHome(env), "repos.json");
  let all: { prefer?: Record<string, string> } = {};
  try {
    all = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    /* the first preference */
  }
  if (!existsSync(join(dir, ".git"))) throw new Error(`${dir} is not a git clone`);
  const prefer = { ...(all.prefer ?? {}) };
  for (const k of Object.keys(prefer)) if (k.toLowerCase() === name.toLowerCase()) delete prefer[k];
  prefer[name] = resolve(dir);
  mkdirSync(configHome(env), { recursive: true });
  writeAtomic(file, JSON.stringify({ ...all, prefer }, null, 2));
}
