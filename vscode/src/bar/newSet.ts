/**
 * New Set… (the left menu) and Open as Set… (several repositories ticked in the left menu or the repository browser): a set of
 * repositories the user picks, on one new feature branch or on an existing branch per repository, with a story or without.
 * Pure parts here (the CLI call, which remote repositories can be cloned); the dialogs in storyUi.ts. No vscode.
 */

export interface SetPick {
  name: string;
  /** the clone */
  path: string;
  /** the branch the clone is on now */
  current: string;
  /** the branch it joins the set on */
  branch: string;
}

/** A repository whose clone is on the chosen branch is used where it is (the CLI reuses it); every other one gets a worktree. */
export const reusedInPlace = (p: SetPick): boolean => p.branch === p.current;

/**
 * `aihub worktree open` for a new set (`--new-set`: never a switch in the set of the window it runs from). The repositories that
 * get a worktree come first, so the first folder of the set is inside the set folder (where the CLI and the extension find the
 * set from); `--branch` is the new feature branch, or the first repository's branch.
 */
export function newSetArgs(picks: SetPick[], setBranch: string, story?: number): string[] {
  const ordered = [...picks.filter((p) => !reusedInPlace(p)), ...picks.filter(reusedInPlace)];
  return [
    "worktree",
    "open",
    "--repos",
    ordered.map((p) => p.path).join(","),
    "--branch",
    setBranch,
    "--branch-for",
    ordered.map((p) => `${p.name}=${p.branch}`).join(","),
    ...(story ? ["--story", String(story)] : []),
    "--new-set",
    "--window",
    "none",
    "--json",
  ];
}

/** The Azure DevOps repositories that are not on this PC yet (by name), sorted, for "Clone from Azure DevOps…". */
export function notOnThisPc<T extends { name: string }>(remote: T[], local: { name: string }[]): T[] {
  const have = new Set(local.map((l) => l.name.toLowerCase()));
  return remote.filter((r) => !have.has(r.name.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name));
}

/** The paths of `{ repos }` (Open as Set… from the left menu or the repository browser), as keys to tick. */
export function preTicked(arg: unknown): Set<string> {
  const repos = arg && typeof arg === "object" && Array.isArray((arg as { repos?: unknown }).repos) ? ((arg as { repos: unknown[] }).repos.filter((p) => typeof p === "string") as string[]) : [];
  return new Set(repos.map((p) => p.replace(/[\\/]+$/, "").toLowerCase()));
}
