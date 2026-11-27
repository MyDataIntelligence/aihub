/**
 * "Add Repository…" in the window of a single repository: the window becomes a set. The repository of the window stays on its
 * branch in its own folder (the CLI reuses a branch that is checked out in the clone: no worktree, nothing moves); every added
 * repository gets its own worktree. Pure parts here (the choices and the CLI call), the dialogs in storyUi.ts. No vscode.
 */

export interface RepoPick {
  name: string;
  path: string;
  /** the branch its clone is on now */
  branch: string;
}

export type BranchKind = "same" | "target" | "new";

export interface BranchChoice {
  kind: BranchKind;
  label: string;
  description: string;
  /** undefined for "new": asked for */
  branch?: string;
}

/**
 * The branch an added repository joins on. First (the default) the branch of this window, so the set has one branch (made from
 * the repository's target when it does not have it); then its target branch; then a new branch. Every added repository gets a
 * worktree in the set folder (the branch its clone is on would leave it where it is, outside the set).
 */
export function branchChoices(setBranch: string, repo: RepoPick, target: string): BranchChoice[] {
  const out: BranchChoice[] = [{ kind: "same", label: setBranch, description: `the branch of this window (made from ${target} when ${repo.name} does not have it)`, branch: setBranch }];
  if (target && target !== setBranch) out.push({ kind: "target", label: target, description: "its target branch", branch: target });
  out.push({ kind: "new", label: "New Branch…", description: `a new branch in ${repo.name}` });
  return out;
}

/** The repositories that can be added: every repository on this PC except the one of this window (by folder and by name). */
export function addable<T extends RepoPick>(all: T[], current: RepoPick): T[] {
  const key = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
  return all.filter((r) => key(r.path) !== key(current.path) && r.name.toLowerCase() !== current.name.toLowerCase());
}

/**
 * `aihub worktree open` for the new set: the repository of this window on its own branch (reused where it is), each added one
 * on its chosen branch in a worktree of the set; with the story when one was chosen; the window is opened by the extension.
 * The added ones come first: the first folder of the set is then inside the set folder, where the extension and the CLI find
 * the set from (the repository of this window stays outside, in its own folder).
 */
export function singleToSetArgs(current: RepoPick, added: { name: string; path: string; branch: string }[], story?: number): string[] {
  const all = [...added, current];
  return [
    "worktree",
    "open",
    "--repos",
    all.map((r) => r.path).join(","),
    "--branch",
    current.branch,
    "--branch-for",
    all.map((r) => `${r.name}=${r.branch}`).join(","),
    ...(story ? ["--story", String(story)] : []),
    "--window",
    "none",
    "--json",
  ];
}

/** A branch name that git accepts (the input box checks it before anything runs). */
export const validBranchName = (v: string): boolean => {
  const s = v.trim();
  return !!s && /^[^\s~^:?*[\\]+$/.test(s) && !s.endsWith("/") && !s.endsWith(".") && !s.includes("..") && !s.startsWith("-");
};
