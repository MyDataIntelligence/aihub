import { existsSync } from "node:fs";
import { join } from "node:path";
import { remoteOf } from "../../../cli/src/lib/machineScan";
import { repoNameOfUrl } from "../../../cli/src/lib/repoName";
import { setRepoSourceInPlace } from "../../../cli/src/lib/setFile";
import type { GitRun } from "./ownWindow";

/**
 * The source clone of a worktree of a set is gone (moved, deleted). `newSource` is the folder of a clone of the same repository:
 * accepted only when its remote names the repository, then `git worktree repair` links the worktree to it and the set file
 * points at it. No vscode here. One sentence when it cannot be done, and nothing changed.
 */
export async function relinkWorktree(git: GitRun, o: { setFolder: string; worktree: string; repo: string; newSource: string }): Promise<{ problem?: string }> {
  if (!existsSync(join(o.newSource, ".git"))) return { problem: `${o.newSource} is not a git clone` };
  const name = repoNameOfUrl(remoteOf(join(o.newSource, ".git")));
  if (!name || name.toLowerCase() !== o.repo.toLowerCase()) return { problem: `that folder is a clone of ${name ?? "a repository without a remote"}, not of ${o.repo}` };
  try {
    await git(o.newSource, ["worktree", "repair", o.worktree]);
  } catch (e) {
    return { problem: `the worktree could not be linked to that clone: ${(e as Error).message.split("\n")[0]}` };
  }
  setRepoSourceInPlace(o.setFolder, o.worktree, o.newSource);
  return {};
}
