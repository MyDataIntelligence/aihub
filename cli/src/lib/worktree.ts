import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { ensureBranch, findStoryBranchName } from "./branches.js";
import { repoClient, type Ctx } from "./context.js";
import { repoRoot } from "./git.js";
import { AihubError } from "./errors.js";
import { isDirty, listWorktrees, mustGit, refSha, samePath, tryGit, unpushedCount } from "./gitx.js";
import { clientForDir, fetchOrigin, resolveRepoDirs } from "./repos.js";
import { findSet } from "./setInfo.js";
import { baseFor } from "./story-flow.js";
import { loadTeam } from "./team.js";
import { getWorkItem, storyBranchName } from "./workitems.js";
import { storyFolderFor, storyIdFromBranch, worktreePathFor } from "./storyWorktrees.js";
import { findDirLinks, removeDirLink } from "./safeWorktree.js";
import { readSetFile, repoBranch, type SetMeta } from "./setFile.js";

const META = ".aihub-set.json";

export { writeSetMeta, type SetMeta } from "./setFile.js";

export function defaultSetsRoot(repoRoot: string): string {
  return join(dirname(repoRoot), "worktrees");
}

export const slugOfBranch = (branch: string) => branch.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || "branch";

/** The folder of a story under the sets root: an older `story-<id>` folder, else `<id>-<slug>` (story-worktrees layout). */
export function setFolder(root: string, story: number, branch = ""): string {
  const legacy = join(root, `story-${story}`);
  if (existsSync(legacy)) return legacy;
  const folders = existsSync(root) ? readdirSync(root) : [];
  return storyFolderFor({ root, storyId: story, branch, storyFolders: folders });
}

export interface CreateSetOpts {
  story: number;
  repos: string[];
  root?: string;
  branch?: string;
  /** a repository's own branch (`--branch-for b=feature/2-y`), else `branch` */
  branches?: Record<string, string>;
  base?: string;
  json?: boolean;
}

export async function createSet(ctx: Ctx, o: CreateSetOpts): Promise<string> {
  if (!o.repos.length) throw new AihubError("--repos needs at least one repository name");
  const { root, client } = repoClient(ctx);
  const team = loadTeam(root);
  const setsRoot = resolve(o.root ?? defaultSetsRoot(root));
  const dirs = resolveRepoDirs(o.repos, root, team);
  let folder = setFolder(setsRoot, o.story, o.branch ?? "");
  let metaPath = join(folder, META);
  const meta: SetMeta = existsSync(metaPath)
    ? (JSON.parse(readFileSync(metaPath, "utf8")) as SetMeta)
    : { story: o.story, branch: o.branch ?? "", repos: [] };

  let branch = o.branch ?? meta.branch;
  if (!branch) {
    for (const d of dirs) {
      branch = findStoryBranchName(d.dir, o.story) ?? "";
      if (branch) break;
    }
  }
  if (!branch) {
    const wi = await getWorkItem(client, o.story);
    if (!wi.title) throw new AihubError(`work item ${o.story} not found; pass --branch <name>`);
    branch = storyBranchName(team, o.story, wi.title);
  }
  meta.branch = branch;
  if (!existsSync(metaPath)) {
    // the folder name takes the slug of the branch now that it is known
    folder = setFolder(setsRoot, o.story, branch);
    metaPath = join(folder, META);
  }

  mkdirSync(folder, { recursive: true });
  const lines: string[] = [];
  for (const d of dirs) {
    if (meta.repos.some((r) => r.name === d.name)) {
      lines.push(`${d.name}: already in the set`);
      continue;
    }
    const own = o.branches?.[d.name] ?? branch;
    const path = worktreePathFor({ root: setsRoot, storyId: o.story, repo: d.name, branch: own, storyFolders: [basename(folder)], exists: existsSync });
    fetchOrigin(d.dir);
    const base = await baseFor(d.dir, clientForDir(ctx, d.dir), team, o.base);
    const e = ensureBranch(d.dir, own, base);
    const busy = listWorktrees(d.dir).find((w) => w.branch === own);
    if (busy) {
      throw new AihubError(`branch '${own}' is already checked out in ${busy.path}; switch that checkout to another branch first (nothing was changed)`);
    }
    mustGit(d.dir, ["worktree", "add", path, own]);
    meta.repos.push({ name: d.name, source: d.dir, path, ...(own !== branch ? { branch: own } : {}) });
    lines.push(`${d.name}: worktree ${path} on '${own}'${e.created ? ` (new, from ${base})` : ""}`);
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  lines.unshift(`set for story ${o.story}: ${folder}`);
  return o.json ? JSON.stringify({ folder, ...meta }) : lines.join("\n");
}

/** The sets under a root: `.aihub-set.json` and the extension's `.worktree-set.json`. */
export function readSets(setsRoot: string): { folder: string; meta: SetMeta }[] {
  if (!existsSync(setsRoot)) return [];
  const out: { folder: string; meta: SetMeta }[] = [];
  for (const e of readdirSync(setsRoot, { withFileTypes: true })) {
    const f = e.isDirectory() ? readSetFile(join(setsRoot, e.name)) : undefined;
    if (f) out.push({ folder: join(setsRoot, e.name), meta: f.top });
  }
  return out;
}

function status(path: string): string {
  if (!existsSync(path)) return "missing";
  const parts: string[] = [];
  if (isDirty(path)) parts.push("dirty");
  const n = unpushedCount(path);
  if (n) parts.push(`${n} unpushed`);
  return parts.join(", ") || "clean";
}

export function listSets(ctx: Ctx, o: { root?: string; json?: boolean }): string {
  const root = repoRoot(ctx.cwd);
  const here = o.root ? undefined : findSet(ctx.cwd);
  const sets = readSets(resolve(o.root ?? (here ? dirname(here.folder) : defaultSetsRoot(root))));
  if (o.json) return JSON.stringify(sets.map((s) => ({ folder: s.folder, ...s.meta, status: s.meta.repos.map((r) => ({ name: r.name, branch: repoBranch(s.meta, r), status: status(r.path) })) })));
  if (!sets.length) return "no worktree sets";
  return sets
    .map((s) => `story ${s.meta.story} '${s.meta.branch}' ${s.folder}\n` + s.meta.repos.map((r) => `  ${r.name}${repoBranch(s.meta, r) !== s.meta.branch ? ` on '${repoBranch(s.meta, r)}'` : ""}: ${status(r.path)}`).join("\n"))
    .join("\n");
}

export function removeSet(ctx: Ctx, o: { story?: number; branch?: string; root?: string; json?: boolean }): string {
  const root = repoRoot(ctx.cwd);
  const setsRoot = resolve(o.root ?? defaultSetsRoot(root));
  // a story branch opened with `worktree open` lives in its story folder, next to the other sets of that story
  const storyId = o.story ?? (o.branch ? storyIdFromBranch(o.branch) : undefined);
  const byBranch = join(setsRoot, slugOfBranch(o.branch ?? ""));
  const folder = o.story ? setFolder(setsRoot, o.story) : storyId && !existsSync(join(byBranch, META)) ? setFolder(setsRoot, storyId, o.branch) : byBranch;
  const metaPath = join(folder, META);
  if (!existsSync(metaPath)) throw new AihubError(`no worktree set for ${o.story ? `story ${o.story}` : `branch '${o.branch}'`} under ${setsRoot}`);
  const top = JSON.parse(readFileSync(metaPath, "utf8")) as SetMeta;
  const all = [{ ...top, others: undefined }, ...(top.others ?? [])];
  const meta = all.find((s) => (o.branch ? s.branch === o.branch : s.story === o.story)) ?? all[0];
  const rest = all.filter((s) => s !== meta);
  const lines: string[] = [];
  const left: SetMeta["repos"] = [];
  for (const r of meta.repos) {
    if (!existsSync(r.path)) {
      tryGit(r.source, ["worktree", "prune"]);
      lines.push(`${r.name}: worktree already gone`);
      continue;
    }
    const known = listWorktrees(r.source).some((w) => samePath(w.path, r.path));
    const links = known ? findDirLinks(r.path) : [];
    const linkSet = new Set(links.map((l) => l.rel.replace(/\\/g, "/")));
    const dirty = known && tryGit(r.path, ["status", "--porcelain"]).out.split("\n").filter(Boolean).some((l) => !linkSet.has(l.slice(3).replace(/\/$/, "")));
    const unpushed = unpushedCount(r.path);
    if (!known || dirty || unpushed) {
      left.push(r);
      lines.push(`${r.name}: kept, ${!known ? "not a worktree of its source repository" : dirty ? "uncommitted changes" : `${unpushed} unpushed commit(s)`}`);
      continue;
    }
    // folder links (a node_modules junction) go first: git would empty the folder they point to
    for (const l of links) removeDirLink(join(r.path, l.rel));
    mustGit(r.source, ["worktree", "remove", r.path]);
    lines.push(`${r.name}: worktree removed (branch '${repoBranch(meta, r)}' kept)`);
  }
  const write = (sets: SetMeta[]) => writeFileSync(metaPath, JSON.stringify({ ...sets[0], ...(sets.length > 1 ? { others: sets.slice(1) } : {}) }, null, 2));
  if (left.length) {
    write([{ ...meta, repos: left }, ...rest]);
    lines.push(`set kept: ${left.length} worktree(s) need attention`);
  } else {
    if (meta.workspace) rmSync(meta.workspace, { force: true });
    if (rest.length) write(rest);
    else {
      rmSync(metaPath);
      try {
        rmdirSync(folder);
      } catch {
        lines.push(`folder ${folder} not removed: it holds other files`);
      }
    }
    lines.push(`set ${o.story ? `for story ${o.story}` : `'${meta.branch}'`} removed`);
  }
  return o.json ? JSON.stringify({ story: o.story ?? 0, branch: meta.branch, lines, kept: left.map((r) => r.name) }) : lines.join("\n");
}

export { refSha };
