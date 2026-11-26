import type { GitRun } from "./ownWindow";

/** The tracked files with local changes (what would be in the way of a switch); untracked files do not count. No vscode here. */
export async function dirtyFiles(git: GitRun, path: string): Promise<string[]> {
  const out = await git(path, ["-c", "core.quotepath=false", "status", "--porcelain=v1", "-uno"]).catch(() => "");
  return out.split("\n").map((l) => l.slice(3).trim().replace(/^.* -> /, "")).filter(Boolean);
}

/** "a.txt, b.txt, c.txt and 4 more": at most five names. */
export const fileList = (files: string[], max = 5): string => (files.length <= max ? files.join(", ") : `${files.slice(0, max).join(", ")} and ${files.length - max} more`);

/**
 * PyCharm's Smart Checkout: the local changes are put aside (stash), the switch runs, the changes come back on the new branch. When they
 * conflict there, everything goes back as it was: the branch you were on, your changes in place, nothing lost (the stash is kept until
 * it was applied somewhere). `run` does the switch and says whether it happened.
 */
export async function smartCheckout(git: GitRun, o: { path: string; oldBranch: string; run: () => Promise<boolean> }): Promise<{ ok: boolean; problem?: string }> {
  const mark = "aihub smart checkout";
  const before = (await git(o.path, ["stash", "list"]).catch(() => "")).split("\n").filter(Boolean).length;
  await git(o.path, ["stash", "push", "-m", mark]).catch((e: Error) => {
    throw new Error(`the changes could not be put aside: ${e.message.split("\n")[0]}`);
  });
  const stashed = (await git(o.path, ["stash", "list"]).catch(() => "")).split("\n").filter(Boolean).length > before;
  if (!stashed) return { ok: (await o.run()) };
  const back = async () => void (await git(o.path, ["stash", "pop"]));
  let switched = false;
  try {
    switched = await o.run();
  } catch (e) {
    await back().catch(() => undefined);
    throw e;
  }
  if (!switched) {
    await back().catch(() => undefined);
    return { ok: false, problem: "the switch did not happen; your changes are back where they were" };
  }
  try {
    await back();
    return { ok: true };
  } catch {
    // a conflict on the new branch: back to the old branch with your changes, nothing lost
    await git(o.path, ["reset", "--hard"]).catch(() => undefined);
    await git(o.path, ["switch", o.oldBranch]).catch(() => undefined);
    await back().catch(() => undefined);
    return { ok: false, problem: `your changes do not fit on the other branch; ${o.oldBranch} is checked out again with your changes in place` };
  }
}
