import type { Git } from "./worktrees/git";
import { listBranches } from "./worktrees/branches";

/**
 * The general branch actions of the old extension's Branch menu, as plain git. No vscode import: the glue asks the
 * user (quick picks, confirm dialogs) and calls these. Destructive steps are separate calls so the glue can confirm first.
 */

const first = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
const lines = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

export interface Step {
  ok: boolean;
  message: string;
}

export const ok = (message: string): Step => ({ ok: true, message });
export const fail = (message: string): Step => ({ ok: false, message });

async function exists(git: Git, cwd: string, ref: string): Promise<boolean> {
  return (await git(["rev-parse", "--verify", "--quiet", ref], cwd)).code === 0;
}

/** origin/staging, else origin/main (the team's integration branches), else origin/master; undefined when none exists. */
export async function defaultTarget(git: Git, cwd: string, remote = "origin"): Promise<string | undefined> {
  for (const b of ["staging", "main", "master"]) if (await exists(git, cwd, `refs/remotes/${remote}/${b}`)) return `${remote}/${b}`;
  return undefined;
}

export async function currentBranch(git: Git, cwd: string): Promise<string | undefined> {
  const r = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

export async function mergeBase(git: Git, cwd: string, target: string): Promise<string | undefined> {
  const r = await git(["merge-base", "HEAD", target], cwd);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

export async function isDirty(git: Git, cwd: string): Promise<boolean> {
  const r = await git(["status", "--porcelain"], cwd);
  return r.code === 0 && r.stdout.trim().length > 0;
}

// ---- Reset to Branch or Commit ---------------------------------------------------------------

/** Refs worth offering: the default targets first, then local and remote branches. */
export async function refChoices(git: Git, cwd: string, remote = "origin"): Promise<string[]> {
  const out: string[] = [];
  for (const b of ["staging", "main"]) if (await exists(git, cwd, `refs/remotes/${remote}/${b}`)) out.push(`${remote}/${b}`);
  const { local, remote: rem } = await listBranches(git, cwd, remote);
  for (const b of [...local, ...rem.map((r) => `${remote}/${r}`)]) if (!out.includes(b)) out.push(b);
  return out;
}

export async function refExists(git: Git, cwd: string, ref: string): Promise<boolean> {
  return exists(git, cwd, `${ref}^{commit}`);
}

/** Files that differ from `ref` (these would change): shown in the confirm dialog before the reset. */
export async function filesDifferingFrom(git: Git, cwd: string, ref: string, paths: string[]): Promise<string[]> {
  const r = await git(["diff", "--name-only", ref, "--", ...paths], cwd);
  return r.code === 0 ? lines(r.stdout) : [];
}

/** Resets the paths (working tree and index) to their state at `ref`. Files that do not exist at `ref` are removed. */
export async function resetPathsToRef(git: Git, cwd: string, ref: string, paths: string[]): Promise<Step> {
  const missing: string[] = [];
  const present: string[] = [];
  for (const p of paths) ((await git(["cat-file", "-e", `${ref}:${p.replace(/\\/g, "/")}`], cwd)).code === 0 ? present : missing).push(p);
  if (present.length) {
    const r = await git(["checkout", ref, "--", ...present], cwd);
    if (r.code !== 0) return fail(first(r.stderr) || "git checkout failed.");
  }
  if (missing.length) {
    const r = await git(["rm", "-rf", "--ignore-unmatch", "--", ...missing], cwd);
    if (r.code !== 0) return fail(first(r.stderr) || "git rm failed.");
  }
  return ok(`Reset ${paths.length} file(s) to ${ref}.`);
}

// ---- Check for Merge Conflicts ---------------------------------------------------------------

export interface ConflictResult {
  clean: boolean;
  files: string[];
  message: string;
}

/** Parses `git merge-tree --write-tree` output: "CONFLICT (content): Merge conflict in <file>" lines. */
export function parseConflicts(output: string): string[] {
  const files = new Set<string>();
  for (const l of lines(output)) {
    const m = l.match(/^CONFLICT \([^)]*\):.*?(?:Merge conflict in|in) (.+)$/) ?? l.match(/^CONFLICT \([^)]*\): (.+?) (?:deleted|added|renamed|modified)/);
    if (m) files.add(m[1].trim());
  }
  return [...files];
}

/** A merge of `target` into HEAD without touching the working tree (git merge-tree). */
export async function checkConflicts(git: Git, cwd: string, target: string): Promise<ConflictResult> {
  const r = await git(["merge-tree", "--write-tree", "--name-only", "--no-messages", "HEAD", target], cwd);
  if (r.code === 0) return { clean: true, files: [], message: `No conflicts with ${target}.` };
  if (r.code === 1) {
    // with --name-only the conflicted file names follow the tree id, one per line, before the empty line
    const names = lines(r.stdout.split(/\r?\n\r?\n/)[0] ?? "").slice(1);
    const files = names.length ? names : parseConflicts(`${r.stdout}\n${r.stderr}`);
    return { clean: false, files, message: `${files.length} file(s) would conflict with ${target}.` };
  }
  if (/unknown option|usage: git merge-tree/i.test(r.stderr)) return legacyConflicts(git, cwd, target);
  return { clean: true, files: [], message: `Could not check against ${target}: ${first(r.stderr) || "git merge-tree failed"}.` };
}

/** Git before 2.38 has no --write-tree: merge in a throw-away way with the three-argument form. */
async function legacyConflicts(git: Git, cwd: string, target: string): Promise<ConflictResult> {
  const base = await mergeBase(git, cwd, target);
  if (!base) return { clean: true, files: [], message: `No common history with ${target}; nothing to check.` };
  const r = await git(["merge-tree", base, "HEAD", target], cwd);
  const files = new Set<string>();
  let current = "";
  for (const l of r.stdout.split(/\r?\n/)) {
    const h = l.match(/^(?:added in both|changed in both)$/);
    const f = l.match(/^\s+(?:our|their|base)\s+\d+ [0-9a-f]+ (.+)$/);
    if (h) current = "";
    if (f) current = f[1];
    if (l.startsWith("+<<<<<<<") && current) files.add(current);
  }
  return files.size ? { clean: false, files: [...files], message: `${files.size} file(s) would conflict with ${target}.` } : { clean: true, files: [], message: `No conflicts with ${target}.` };
}

// ---- Clean Up Unrelated Changes --------------------------------------------------------------

export interface ChangedFile {
  path: string;
  status: string;
}

/** The files this branch changes compared with where it left `target` (three-dot diff). */
export async function branchChangedFiles(git: Git, cwd: string, target: string): Promise<ChangedFile[]> {
  const r = await git(["diff", "--name-status", `${target}...HEAD`], cwd);
  if (r.code !== 0) return [];
  return lines(r.stdout).map((l) => {
    const [status, ...rest] = l.split("\t");
    return { status: status[0], path: rest[rest.length - 1] };
  });
}

/** Puts the chosen files back to their state on the merge base, so they drop out of the branch's diff after the next commit. */
export async function revertToMergeBase(git: Git, cwd: string, target: string, files: ChangedFile[]): Promise<Step> {
  const base = await mergeBase(git, cwd, target);
  if (!base) return fail(`No common history with ${target}.`);
  const added = files.filter((f) => f.status === "A").map((f) => f.path);
  const rest = files.filter((f) => f.status !== "A").map((f) => f.path);
  if (rest.length) {
    const r = await git(["checkout", base, "--", ...rest], cwd);
    if (r.code !== 0) return fail(first(r.stderr) || "git checkout failed.");
  }
  if (added.length) {
    const r = await git(["rm", "-rf", "--ignore-unmatch", "--", ...added], cwd);
    if (r.code !== 0) return fail(first(r.stderr) || "git rm failed.");
  }
  return ok(`Reset ${files.length} unrelated file(s) to ${target}. Commit to remove them from your branch.`);
}

// ---- Squash Branch Commits -------------------------------------------------------------------

export async function commitsAhead(git: Git, cwd: string, target: string): Promise<number> {
  const base = await mergeBase(git, cwd, target);
  if (!base) return 0;
  const r = await git(["rev-list", "--count", `${base}..HEAD`], cwd);
  return r.code === 0 ? parseInt(r.stdout.trim(), 10) || 0 : 0;
}

/** Subjects of the newest commits, to propose a message. */
export async function recentSubjects(git: Git, cwd: string, count: number): Promise<string[]> {
  const r = await git(["log", `-${count}`, "--format=%s"], cwd);
  return r.code === 0 ? lines(r.stdout) : [];
}

export async function pushedAlready(git: Git, cwd: string, remote = "origin"): Promise<boolean> {
  const b = await currentBranch(git, cwd);
  return !!b && (await exists(git, cwd, `refs/remotes/${remote}/${b}`));
}

/** Squashes the newest `count` commits of the branch (all of them since `target` when count is undefined) into one. The tree must be clean. */
export async function squashCommits(git: Git, cwd: string, target: string, message: string, count?: number): Promise<Step> {
  if (await isDirty(git, cwd)) return fail("There are uncommitted changes. Commit or stash them first.");
  const total = await commitsAhead(git, cwd, target);
  const n = count ?? total;
  if (n < 2) return fail(total < 2 ? "Nothing to squash: the branch has fewer than two commits." : "Choose at least two commits.");
  if (n > total) return fail(`The branch has only ${total} commit(s) since ${target}.`);
  const r = await git(["reset", "--soft", `HEAD~${n}`], cwd);
  if (r.code !== 0) return fail(first(r.stderr) || "git reset failed.");
  const c = await git(["commit", "-m", message], cwd);
  if (c.code !== 0) return fail(first(c.stderr) || first(c.stdout) || "git commit failed.");
  return ok(`Squashed ${n} commits into one.`);
}

// ---- Switch branch ---------------------------------------------------------------------------

export interface BranchChoice {
  name: string;
  /** Only on the remote: switching creates a tracking branch. */
  remoteOnly: boolean;
}

export async function switchChoices(git: Git, cwd: string, remote = "origin"): Promise<BranchChoice[]> {
  await git(["fetch", "--prune", remote], cwd);
  const { local, remote: rem } = await listBranches(git, cwd, remote);
  return [...local.map((name) => ({ name, remoteOnly: false })), ...rem.filter((r) => !local.includes(r) && r !== "HEAD").map((name) => ({ name, remoteOnly: true }))];
}

export async function switchBranch(git: Git, cwd: string, choice: BranchChoice, remote = "origin"): Promise<Step> {
  const r = choice.remoteOnly ? await git(["switch", "--track", `${remote}/${choice.name}`], cwd) : await git(["switch", choice.name], cwd);
  if (r.code === 0) return ok(`Switched to ${choice.name}.`);
  return fail(/would be overwritten|local changes/i.test(r.stderr) ? "Your uncommitted changes would be overwritten. Commit or stash them first." : first(r.stderr) || "git switch failed.");
}
