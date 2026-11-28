import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { aihubDir } from "../aihubDir.js";
import { AihubError } from "../errors.js";
import { gitRaw } from "../git.js";
import { looseName } from "../findClone.js";
import { resolveRepoDirs } from "../repos.js";
import type { TeamConfig } from "../team.js";

/**
 * The sources directory preflight runs in, never the user's working tree: `<git common dir>/aihub/preflight/s/<repo>`
 * is a detached worktree at a snapshot commit of the working tree (uncommitted and untracked-but-not-ignored files
 * included, made through a temporary index), and `s/<source repo>` is the source repository at origin/<ref>. This is the
 * layout of an Azure Pipelines multi-checkout ($(Build.SourcesDirectory)/<repo>). Steps may write there freely; each run
 * resets both checkouts (ignored files such as a virtual environment stay).
 */
export interface Checkout {
  name: string;
  dir: string;
  commit: string;
}

export interface Sources {
  /** <common>/aihub/preflight (Pipeline.Workspace) */
  base: string;
  /** base/s (Build.SourcesDirectory) */
  sourcesDir: string;
  work: Checkout & { head: string };
  source: Checkout & { ref: string; fetched: boolean; fetchedAt?: string; sameAsWork: boolean; warning?: string };
}

const must = (cwd: string, args: string[], env?: Record<string, string>): string => {
  const r = gitRaw(cwd, args, env);
  if (r.status !== 0) throw new AihubError(`git ${args.join(" ")} failed: ${r.stderr.split("\n")[0]}`);
  return r.stdout.trim();
};

export const preflightBase = (root: string): string => aihubDir(root, "preflight");

/** A commit of the working tree as it is now, made with a temporary index: the user's index and files are not touched. */
export function snapshotCommit(root: string, base: string): { commit: string; head: string } {
  const head = gitRaw(root, ["rev-parse", "HEAD"]).stdout.trim();
  if (!head) throw new AihubError("this repository has no commit yet: commit once, then run aihub preflight");
  mkdirSync(base, { recursive: true });
  const index = join(base, "snapshot.index");
  rmSync(index, { force: true });
  const env = { GIT_INDEX_FILE: index };
  try {
    // a copy of the real index keeps its file stats, so `git add` only hashes what changed; the real index is never written
    const real = gitRaw(root, ["rev-parse", "--git-path", "index"]).stdout.trim();
    if (real && existsSync(resolve(root, real))) copyFileSync(resolve(root, real), index);
    else must(root, ["read-tree", "HEAD"], env);
    must(root, ["add", "-A", "--", "."], env);
    const tree = must(root, ["write-tree"], env);
    if (tree === must(root, ["rev-parse", "HEAD^{tree}"])) return { commit: head, head };
    const who = { GIT_AUTHOR_NAME: "aihub preflight", GIT_AUTHOR_EMAIL: "preflight@aihub.invalid", GIT_COMMITTER_NAME: "aihub preflight", GIT_COMMITTER_EMAIL: "preflight@aihub.invalid" };
    return { commit: must(root, ["commit-tree", tree, "-p", head, "-m", "aihub preflight snapshot (working tree)"], who), head };
  } finally {
    rmSync(index, { force: true });
  }
}

const commonOf = (dir: string): string | undefined => {
  const r = gitRaw(dir, ["rev-parse", "--git-common-dir"]);
  return r.status === 0 ? resolve(dir, r.stdout.trim()).toLowerCase() : undefined;
};

/** A detached worktree of `repo` at `commit` in `dir`, reused between runs (reset and cleaned, ignored files kept). */
export function checkoutAt(repo: string, dir: string, commit: string): void {
  if (existsSync(join(dir, ".git")) && commonOf(dir) === commonOf(repo)) {
    must(dir, ["checkout", "--quiet", "--force", "--detach", commit]);
    must(dir, ["clean", "-fdq"]);
    return;
  }
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  gitRaw(repo, ["worktree", "prune"]);
  mkdirSync(resolve(dir, ".."), { recursive: true });
  must(repo, ["worktree", "add", "--quiet", "--detach", dir, commit]);
}

export interface SourceOpts {
  root: string;
  repoName: string;
  team: TeamConfig;
  source?: string;
  ref: string;
  fetch: boolean;
  env: NodeJS.ProcessEnv;
  now: () => number;
}

export function prepareSources(o: SourceOpts): Sources {
  const base = preflightBase(o.root);
  const sourcesDir = join(base, "s");
  const snap = snapshotCommit(o.root, base);
  const workDir = join(sourcesDir, o.repoName);
  checkoutAt(o.root, workDir, snap.commit);
  const work = { name: o.repoName, dir: workDir, commit: snap.commit, head: snap.head };
  if (!o.source || looseName(o.source) === looseName(o.repoName)) {
    return { base, sourcesDir, work, source: { ...work, ref: o.ref, fetched: false, sameAsWork: true } };
  }
  const [hit] = resolveRepoDirs([o.source], o.root, o.team, [], o.env);
  const clone = hit.dir;
  let fetched = false;
  let warning: string | undefined;
  if (o.fetch) {
    const r = gitRaw(clone, ["fetch", "--quiet", "origin", `+refs/heads/${o.ref}:refs/remotes/origin/${o.ref}`]);
    fetched = r.status === 0;
    if (!fetched) warning = `git fetch of ${o.source} failed (${r.stderr.split("\n")[0]}); using the origin/${o.ref} this clone already has`;
  }
  const commit = gitRaw(clone, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${o.ref}^{commit}`]).stdout.trim();
  if (!commit) throw new AihubError(`${o.source} has no origin/${o.ref} in ${clone}: check preflight.source.ref in team.yaml${o.fetch ? "" : ", or run without --no-fetch"}`);
  let fetchedAt: string | undefined = fetched ? new Date(o.now()).toISOString() : undefined;
  if (!fetchedAt) {
    try {
      const out = gitRaw(clone, ["rev-parse", "--git-path", "FETCH_HEAD"]).stdout.trim();
      const f = out ? resolve(clone, out) : "";
      if (f && existsSync(f)) fetchedAt = statSync(f).mtime.toISOString();
    } catch {
      /* unknown */
    }
  }
  const dir = join(sourcesDir, hit.name);
  checkoutAt(clone, dir, commit);
  return { base, sourcesDir, work, source: { name: hit.name, dir, commit, ref: o.ref, fetched, fetchedAt, sameAsWork: false, warning } };
}

const SETUP_FILES = /^(pyproject\.toml|setup\.py|setup\.cfg|requirements[^/]*\.txt|poetry\.lock|uv\.lock|Pipfile\.lock|package\.json|package-lock\.json)$/i;

/** A hash of the dependency files at the root of a checkout and the setup commands: setup runs again when it changes. */
export function setupFingerprint(dir: string, commands: string[]): string {
  const h = createHash("sha256").update(commands.join("\n"));
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => SETUP_FILES.test(n)).sort();
  } catch {
    /* empty */
  }
  for (const n of names) h.update(`\0${n}\0`).update(readFileSync(join(dir, n)));
  return h.digest("hex").slice(0, 16);
}
