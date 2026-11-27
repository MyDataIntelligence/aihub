/**
 * New Set… (the left menu) and Open as Set… (repositories ticked in the left menu): the questions — which repositories, which
 * branch, which story. The work is aihub.bar.openReposAsSet (clone what is not on this PC, one story is one set, the set in a
 * new window, Undo); this file builds its argument. No vscode.
 */
import type { OpenReposArg, SetRepoArg } from "./openReposAsSet";

/** A repository of the set as the questions know it: on this PC (its clone), or on Azure DevOps (to clone). */
export interface NewSetRepo {
  name: string;
  /** its clone folder; undefined when it is cloned first */
  path?: string;
  project?: string;
  remoteUrl?: string;
}

/**
 * The argument of aihub.bar.openReposAsSet. `all`: one new branch for every repository (made from each one's target branch);
 * else an existing branch per repository (`branches`, by name). The set opens in a new window.
 */
export function openReposArgOf(repos: NewSetRepo[], choice: { all: string } | { branches: Record<string, string> }, story?: number): OpenReposArg {
  const one = (r: NewSetRepo): SetRepoArg => ({ name: r.name, ...(r.project ? { project: r.project } : {}), ...(r.remoteUrl && !r.path ? { remoteUrl: r.remoteUrl } : {}), ...("branches" in choice ? { branch: choice.branches[r.name] } : {}) });
  return { repos: repos.map(one), ...("all" in choice ? { newBranch: choice.all } : {}), ...(story ? { story } : {}), window: "new" };
}

/** The Azure DevOps repositories that are not on this PC yet (by name), sorted, for "Clone from Azure DevOps…". */
export function notOnThisPc<T extends { name: string }>(remote: T[], local: { name: string }[]): T[] {
  const have = new Set(local.map((l) => l.name.toLowerCase()));
  return remote.filter((r) => !have.has(r.name.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name));
}

/** The paths of `{ repos }` (Open as Set… from the left menu), as keys to tick. */
export function preTicked(arg: unknown): Set<string> {
  const repos = arg && typeof arg === "object" && Array.isArray((arg as { repos?: unknown }).repos) ? ((arg as { repos: unknown[] }).repos.filter((p) => typeof p === "string") as string[]) : [];
  return new Set(repos.map((p) => p.replace(/[\\/]+$/, "").toLowerCase()));
}
