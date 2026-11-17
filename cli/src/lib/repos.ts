import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { AdoClient, parseRemote } from "./ado.js";
import { makeAuth } from "./auth.js";
import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { remoteUrl } from "./git.js";
import { mustGit, refSha, tryGit } from "./gitx.js";
import type { TeamConfig } from "./team.js";
import { findStoryBranchName } from "./branches.js";

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
 * A name may be a repository name, a folder name or an alias from team.yaml.
 */
export function resolveRepoDirs(names: string[], currentRoot: string, team: TeamConfig, roots: string[] = []): RepoDir[] {
  const searchRoots = [...roots.map((r) => resolve(r)), dirname(currentRoot)];
  const aliasOf = (n: string): string[] => {
    const hit = (team.repositories ?? []).find((r) => r.name?.toLowerCase() === n.toLowerCase() || (r as { aliases?: string[] }).aliases?.some((a) => a.toLowerCase() === n.toLowerCase()));
    return hit?.name ? [n, hit.name] : [n];
  };
  const out: RepoDir[] = [];
  for (const n of names) {
    if (basename(currentRoot).toLowerCase() === n.toLowerCase()) {
      out.push({ name: n, dir: currentRoot });
      continue;
    }
    let found: string | undefined;
    for (const cand of aliasOf(n)) {
      for (const r of searchRoots) {
        const d = join(r, cand);
        if (existsSync(join(d, ".git"))) {
          found = d;
          break;
        }
      }
      if (found) break;
    }
    if (!found) throw new AihubError(`repository '${n}' not found next to ${currentRoot}; clone it there or pass --root <folder>`);
    out.push({ name: n, dir: found });
  }
  return out;
}

export function fetchOrigin(dir: string): void {
  tryGit(dir, ["fetch", "--quiet", "--prune", "origin"]);
}

export { findStoryBranchName, mustGit, refSha };
