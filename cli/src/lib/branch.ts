import { basename } from "node:path";
import { parseRemote, repoDefaultBranch } from "./ado.js";
import { repoClientAt, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { currentBranch, fetchBranch, git, gitRaw, hasRef, originDefaultBranch, remoteUrl, repoRoot, withTempWorktree } from "./git.js";
import { isProtected, loadTeam } from "./team.js";
import { targetFor } from "./baseBranch.js";

export interface UpdateBranchOpts {
  branch?: string;
  target?: string;
  rebase?: boolean;
  /** merge or rebase here and leave the push to the user (the extension's buttons never publish by themselves) */
  noPush?: boolean;
  json?: boolean;
}

export interface UpdateResult {
  branch: string;
  target: string;
  result: "updated" | "up-to-date" | "conflict";
  detail: string;
  /** why this target: "given with --target", "from team.yaml", "the branch it was cut from", "origin's default branch", ... */
  targetReason?: string;
  /** a hint when the target may not be what was meant (origin/staging exists while another branch was chosen) */
  hint?: string;
}

/** The repository name for team.yaml: the Azure DevOps name when the remote is one, else the last part of the remote URL. */
function repoNameOf(root: string): string {
  let url = "";
  try {
    url = remoteUrl(root);
  } catch {
    return basename(root);
  }
  try {
    return parseRemote(url).repo;
  } catch {
    return /([^/\\:]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1] ?? basename(root);
  }
}

/** True when origin is an Azure DevOps remote (only then the remote default branch can be asked over its API). */
function isAdoRemote(root: string): boolean {
  try {
    parseRemote(remoteUrl(root));
    return true;
  } catch {
    return false;
  }
}

const REASON: Record<string, string> = {
  "team.yaml": "from team.yaml",
  "branch point": "the branch it was cut from",
  "default branch": "origin's default branch",
};

/**
 * The target of an update and why: --target; team.yaml; the branch it was cut from; origin's default branch (origin/HEAD,
 * local); the Azure DevOps default branch (only for an Azure DevOps remote); else main. Plain git for any remote.
 */
export async function chooseTarget(ctx: Ctx, root: string, branch: string, given?: string): Promise<{ target: string; reason: string }> {
  if (given) return { target: given, reason: "given with --target" };
  const team = loadTeam(root);
  const t = targetFor(ctx, root, branch, team, repoNameOf(root));
  if (t) return { target: t.target, reason: REASON[t.how] ?? t.how };
  const def = originDefaultBranch(root);
  if (def) return { target: def, reason: "origin's default branch" };
  if (isAdoRemote(root)) {
    const ado = await repoDefaultBranch(repoClientAt(ctx, root).client).catch(() => undefined);
    if (ado) return { target: ado, reason: "the repository's default branch" };
  }
  return { target: "main", reason: "no other target found" };
}

/** One line under the result: origin/staging exists while another branch was chosen by itself (not given with --target). */
export function stagingHint(root: string, target: string, reason: string): string | undefined {
  if (target === "staging" || reason === "given with --target") return undefined;
  return hasRef(root, "origin/staging") ? `origin/staging exists; to update from it: aihub branch update --target staging` : undefined;
}

/** Bring a branch up to date with its target (merge by default, --rebase to rebase); conflicts change nothing. */
export async function branchUpdate(ctx: Ctx, o: UpdateBranchOpts): Promise<string> {
  // plain git: fetch and merge (or rebase) work with any remote; only pull requests need Azure DevOps
  const root = repoRoot(ctx.cwd);
  const team = loadTeam(root);
  const checkedOut = currentBranchOrEmpty(root);
  const branch = o.branch ?? checkedOut;
  if (!branch) throw new AihubError("detached HEAD; pass --branch <name>");
  const { target, reason } = await chooseTarget(ctx, root, branch, o.target);
  if (branch === target) throw new AihubError(`'${branch}' is the target itself; nothing to update`);
  if (isProtected(team, branch)) throw new AihubError(`'${branch}' is a protected branch; the CLI does not change it`);
  if (!fetchBranch(root, target)) throw new AihubError(`target branch '${target}' not found on origin`);
  const remoteBranchKnown = fetchBranch(root, branch);

  const here = branch === checkedOut;
  let res: UpdateResult;
  if (here) {
    if (git(root, ["status", "--porcelain", "--untracked-files=no"]) !== "") throw new AihubError("uncommitted changes in this checkout; commit or stash them first");
    res = doUpdate(root, branch, target, !!o.rebase, "HEAD", !!o.noPush);
  } else {
    if (!remoteBranchKnown) throw new AihubError(`branch '${branch}' not found on origin`);
    res = await withTempWorktree(root, `origin/${branch}`, (wt) => doUpdate(wt, branch, target, !!o.rebase, "HEAD", !!o.noPush));
    if (o.noPush) throw new AihubError(`'${branch}' is not checked out here; without a push the update would be lost: check it out, or update without --no-push`);
  }
  res = { ...res, targetReason: reason, ...(stagingHint(root, target, reason) ? { hint: stagingHint(root, target, reason) } : {}) };
  if (o.json) return JSON.stringify(res);
  const head = res.result === "up-to-date" ? `${res.branch}: already up to date with ${res.target}` : `${res.branch} <- ${res.target}: ${res.result} (${res.detail})`;
  return [`${head} · target ${res.target} (${reason})`, ...(res.hint ? [`hint: ${res.hint}`] : [])].join("\n");
}

function currentBranchOrEmpty(root: string): string {
  try {
    return currentBranch(root);
  } catch {
    return "";
  }
}

function doUpdate(dir: string, branch: string, target: string, rebase: boolean, pushFrom: string, noPush = false): UpdateResult {
  const upstream = `origin/${target}`;
  const behind = Number(git(dir, ["rev-list", "--count", `HEAD..${upstream}`]));
  if (behind === 0) return { branch, target, result: "up-to-date", detail: `already contains ${target}` };
  const before = git(dir, ["rev-parse", "HEAD"]);
  const r = rebase ? gitRaw(dir, ["rebase", upstream]) : gitRaw(dir, ["merge", "--no-edit", upstream]);
  if (r.status !== 0) {
    const files = gitRaw(dir, ["diff", "--name-only", "--diff-filter=U"]).stdout.split("\n").filter(Boolean);
    gitRaw(dir, rebase ? ["rebase", "--abort"] : ["merge", "--abort"]);
    if (!files.length) throw new AihubError(`${rebase ? "rebase" : "merge"} failed: ${r.stderr.split("\n")[0]}`);
    return { branch, target, result: "conflict", detail: `conflict in ${files.join(", ")}; nothing changed or pushed` };
  }
  const made = git(dir, ["rev-parse", "HEAD"]);
  if (noPush) return { branch, target, result: "updated", detail: `${behind} commit(s) from ${target} ${rebase ? "rebased onto" : "merged into"} ${branch}, not pushed` };
  const push = gitRaw(dir, [
    "push",
    "--quiet",
    ...(rebase ? [`--force-with-lease=refs/heads/${branch}:${git(dir, ["rev-parse", `origin/${branch}`], { allowFail: true }) || before}`] : []),
    "origin",
    `${pushFrom}:refs/heads/${branch}`,
  ]);
  if (push.status !== 0) {
    // put the branch back only when it is still exactly what this update made, and keep what was saved meanwhile (--keep, never --hard)
    const stillMine = git(dir, ["rev-parse", "HEAD"], { allowFail: true }) === made;
    const back = stillMine && gitRaw(dir, ["reset", "--keep", before]).status === 0;
    throw new AihubError(`push of '${branch}' rejected (someone pushed meanwhile?); ${back ? "local branch restored" : "the local branch was left as it is (it changed meanwhile)"}: ${push.stderr.split("\n").pop()}`);
  }
  return { branch, target, result: "updated", detail: `${behind} commit(s) from ${target} ${rebase ? "rebased onto" : "merged into"} ${branch}, pushed` };
}
