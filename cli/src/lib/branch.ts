import { repoDefaultBranch } from "./ado.js";
import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { currentBranch, fetchBranch, git, gitRaw, originDefaultBranch, withTempWorktree } from "./git.js";
import { defaultTargetFor, isProtected, loadTeam } from "./team.js";

export interface UpdateBranchOpts {
  branch?: string;
  target?: string;
  rebase?: boolean;
  json?: boolean;
}

export interface UpdateResult {
  branch: string;
  target: string;
  result: "updated" | "up-to-date" | "conflict";
  detail: string;
}

/** Bring a branch up to date with its target (merge by default, --rebase to rebase); conflicts change nothing. */
export async function branchUpdate(ctx: Ctx, o: UpdateBranchOpts): Promise<string> {
  const { root, client } = repoClient(ctx);
  const team = loadTeam(root);
  const checkedOut = currentBranchOrEmpty(root);
  const branch = o.branch ?? checkedOut;
  if (!branch) throw new AihubError("detached HEAD; pass --branch <name>");
  const target =
    o.target ?? defaultTargetFor(team, client.remote.repo) ?? (originDefaultBranch(root) || undefined) ?? (await repoDefaultBranch(client)) ?? "main";
  if (branch === target) throw new AihubError(`'${branch}' is the target itself; nothing to update`);
  if (isProtected(team, branch)) throw new AihubError(`'${branch}' is a protected branch; the CLI does not change it`);
  if (!fetchBranch(root, target)) throw new AihubError(`target branch '${target}' not found on origin`);
  const remoteBranchKnown = fetchBranch(root, branch);

  const here = branch === checkedOut;
  let res: UpdateResult;
  if (here) {
    if (git(root, ["status", "--porcelain", "--untracked-files=no"]) !== "") throw new AihubError("uncommitted changes in this checkout; commit or stash them first");
    res = doUpdate(root, branch, target, !!o.rebase, "HEAD");
  } else {
    if (!remoteBranchKnown) throw new AihubError(`branch '${branch}' not found on origin`);
    res = await withTempWorktree(root, `origin/${branch}`, (wt) => doUpdate(wt, branch, target, !!o.rebase, "HEAD"));
  }
  if (o.json) return JSON.stringify(res);
  return `${res.branch} <- ${res.target}: ${res.result} (${res.detail})`;
}

function currentBranchOrEmpty(root: string): string {
  try {
    return currentBranch(root);
  } catch {
    return "";
  }
}

function doUpdate(dir: string, branch: string, target: string, rebase: boolean, pushFrom: string): UpdateResult {
  const upstream = `origin/${target}`;
  const behind = Number(git(dir, ["rev-list", "--count", `HEAD..${upstream}`]));
  if (behind === 0) return { branch, target, result: "up-to-date", detail: "already contains the target" };
  const before = git(dir, ["rev-parse", "HEAD"]);
  const r = rebase ? gitRaw(dir, ["rebase", upstream]) : gitRaw(dir, ["merge", "--no-edit", upstream]);
  if (r.status !== 0) {
    const files = gitRaw(dir, ["diff", "--name-only", "--diff-filter=U"]).stdout.split("\n").filter(Boolean);
    gitRaw(dir, rebase ? ["rebase", "--abort"] : ["merge", "--abort"]);
    if (!files.length) throw new AihubError(`${rebase ? "rebase" : "merge"} failed: ${r.stderr.split("\n")[0]}`);
    return { branch, target, result: "conflict", detail: `conflict in ${files.join(", ")}; nothing changed or pushed` };
  }
  const push = gitRaw(dir, [
    "push",
    "--quiet",
    ...(rebase ? [`--force-with-lease=refs/heads/${branch}:${git(dir, ["rev-parse", `origin/${branch}`], { allowFail: true }) || before}`] : []),
    "origin",
    `${pushFrom}:refs/heads/${branch}`,
  ]);
  if (push.status !== 0) {
    gitRaw(dir, ["reset", "--hard", before]);
    throw new AihubError(`push of '${branch}' rejected (someone pushed meanwhile?); local branch restored: ${push.stderr.split("\n").pop()}`);
  }
  return { branch, target, result: "updated", detail: `${behind} commit(s) from ${target} ${rebase ? "rebased onto" : "merged into"} ${branch}, pushed` };
}
