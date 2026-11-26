import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { AdoClient, parseRemote } from "./ado.js";
import { makeAuth } from "./auth.js";
import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { remoteUrl } from "./git.js";
import { mustGit, refSha, tryGit } from "./gitx.js";
import type { TeamConfig } from "./team.js";
import { findStoryBranchName } from "./branches.js";
import { samePath } from "./cloneChoice.js";
import { remoteOf } from "./machineScan.js";
import { repoNameOfUrl } from "./repoName.js";
import { readPreferredClones } from "./repoPicker.js";

export interface RepoDir {
  name: string;
  dir: string;
}

export function clientForDir(ctx: Ctx, dir: string): AdoClient {
  const remote = parseRemote(remoteUrl(dir));
  return new AdoClient(remote, makeAuth({ env: ctx.env, exec: ctx.exec, cacheFile: ctx.tokenCache }), ctx.fetch);
}

/**
 * Finds the local clones of `names`: sibling folders of the current repository, or folders under `roots`.
 * A name may be a repository name, a folder name or an alias from team.yaml. A folder (absolute path of a clone) is used as given and
 * named by its remote. When a clone was preferred (`aihub repos prefer`), a name resolves to that clone: the same rule as the extension's list.
 */
export function resolveRepoDirs(names: string[], currentRoot: string, team: TeamConfig, roots: string[] = [], env: NodeJS.ProcessEnv = process.env): RepoDir[] {
  const prefer = readPreferredClones(env);
  const searchRoots = [...roots.map((r) => resolve(r)), dirname(currentRoot)];
  const aliasOf = (n: string): string[] => {
    const hit = (team.repositories ?? []).find((r) => r.name?.toLowerCase() === n.toLowerCase() || (r as { aliases?: string[] }).aliases?.some((a) => a.toLowerCase() === n.toLowerCase()));
    return hit?.name ? [n, hit.name] : [n];
  };
  const out: RepoDir[] = [];
  for (const n of names) {
    if (isAbsolute(n) || /^[A-Za-z]:[\\/]/.test(n)) {
      if (!existsSync(join(n, ".git"))) throw new AihubError(`${n} is not a git clone`);
      out.push({ name: repoNameOfUrl(remoteOf(join(resolve(n), ".git"))) ?? basename(n), dir: resolve(n) });
      continue;
    }
    const pref = Object.keys(prefer).find((p) => p.toLowerCase() === n.toLowerCase());
    if (pref && existsSync(join(prefer[pref], ".git")) && !samePath(prefer[pref], currentRoot)) {
      out.push({ name: n, dir: resolve(prefer[pref]) });
      continue;
    }
    if (basename(currentRoot).toLowerCase() === n.toLowerCase()) {
      out.push({ name: n, dir: currentRoot });
      continue;
    }
    let found: string | undefined;
    // team.yaml repositories[].path (absolute or relative to this repository) wins over the sibling search
    for (const cand of aliasOf(n)) {
      const hit = (team.repositories ?? []).find((r) => r.name?.toLowerCase() === cand.toLowerCase()) as { path?: string } | undefined;
      const d = hit?.path ? resolve(currentRoot, hit.path) : undefined;
      if (d && existsSync(join(d, ".git"))) {
        found = d;
        break;
      }
    }
    for (const cand of found ? [] : aliasOf(n)) {
      for (const r of searchRoots) {
        const d = join(r, cand);
        if (existsSync(join(d, ".git"))) {
          found = d;
          break;
        }
      }
      if (found) break;
    }
    if (!found) throw new AihubError(`repository '${n}' not found next to ${currentRoot}; clone it there, or set repositories[].path in team.yaml`);
    out.push({ name: n, dir: found });
  }
  return out;
}

export function fetchOrigin(dir: string): void {
  tryGit(dir, ["fetch", "--quiet", "--prune", "origin"]);
}

export { findStoryBranchName, mustGit, refSha };
