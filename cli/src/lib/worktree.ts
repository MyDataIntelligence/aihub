import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ensureBranch, findStoryBranchName } from "./branches.js";
import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { isDirty, listWorktrees, mustGit, refSha, samePath, tryGit, unpushedCount } from "./gitx.js";
import { clientForDir, fetchOrigin, resolveRepoDirs } from "./repos.js";
import { baseFor } from "./story-flow.js";
import { loadTeam } from "./team.js";
import { getWorkItem, storyBranchName } from "./workitems.js";

const META = ".aihub-set.json";

export interface SetMeta {
  story: number;
  branch: string;
  repos: { name: string; source: string; path: string }[];
}

export function defaultSetsRoot(repoRoot: string): string {
  return join(dirname(repoRoot), "worktrees");
}

export const setFolder = (root: string, story: number) => join(root, `story-${story}`);

export interface CreateSetOpts {
  story: number;
  repos: string[];
  root?: string;
  branch?: string;
  base?: string;
  json?: boolean;
}

export async function createSet(ctx: Ctx, o: CreateSetOpts): Promise<string> {
  if (!o.repos.length) throw new AihubError("--repos needs at least one repository name");
  const { root, client } = repoClient(ctx);
  const team = loadTeam(root);
  const setsRoot = resolve(o.root ?? defaultSetsRoot(root));
  const folder = setFolder(setsRoot, o.story);
  const dirs = resolveRepoDirs(o.repos, root, team);
  const metaPath = join(folder, META);
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

  mkdirSync(folder, { recursive: true });
  const lines: string[] = [];
  for (const d of dirs) {
    if (meta.repos.some((r) => r.name === d.name)) {
      lines.push(`${d.name}: already in the set`);
      continue;
    }
    const path = join(folder, d.name);
    if (existsSync(path)) throw new AihubError(`${path} already exists and is not part of this set`);
    fetchOrigin(d.dir);
    const base = await baseFor(d.dir, clientForDir(ctx, d.dir), team, o.base);
    const e = ensureBranch(d.dir, branch, base);
    const busy = listWorktrees(d.dir).find((w) => w.branch === branch);
    if (busy) {
      throw new AihubError(`branch '${branch}' is already checked out in ${busy.path}; switch that checkout to another branch first (nothing was changed)`);
    }
    mustGit(d.dir, ["worktree", "add", path, branch]);
    meta.repos.push({ name: d.name, source: d.dir, path });
    lines.push(`${d.name}: worktree ${path} on '${branch}'${e.created ? ` (new, from ${base})` : ""}`);
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  lines.unshift(`set for story ${o.story}: ${folder}`);
  return o.json ? JSON.stringify({ folder, ...meta }) : lines.join("\n");
}

export function readSets(setsRoot: string): { folder: string; meta: SetMeta }[] {
  if (!existsSync(setsRoot)) return [];
  const out: { folder: string; meta: SetMeta }[] = [];
  for (const e of readdirSync(setsRoot, { withFileTypes: true })) {
    const p = join(setsRoot, e.name, META);
    if (e.isDirectory() && existsSync(p)) {
      try {
        out.push({ folder: join(setsRoot, e.name), meta: JSON.parse(readFileSync(p, "utf8")) as SetMeta });
      } catch {
        /* ignore a broken set file */
      }
    }
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
  const { root } = repoClient(ctx);
  const sets = readSets(resolve(o.root ?? defaultSetsRoot(root)));
  if (o.json) return JSON.stringify(sets.map((s) => ({ folder: s.folder, ...s.meta, status: s.meta.repos.map((r) => ({ name: r.name, status: status(r.path) })) })));
  if (!sets.length) return "no worktree sets";
  return sets
    .map((s) => `story ${s.meta.story} '${s.meta.branch}' ${s.folder}\n` + s.meta.repos.map((r) => `  ${r.name}: ${status(r.path)}`).join("\n"))
    .join("\n");
}

export function removeSet(ctx: Ctx, o: { story: number; root?: string; json?: boolean }): string {
  const { root } = repoClient(ctx);
  const setsRoot = resolve(o.root ?? defaultSetsRoot(root));
  const folder = setFolder(setsRoot, o.story);
  const metaPath = join(folder, META);
  if (!existsSync(metaPath)) throw new AihubError(`no worktree set for story ${o.story} under ${setsRoot}`);
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as SetMeta;
  const lines: string[] = [];
  const left: SetMeta["repos"] = [];
  for (const r of meta.repos) {
    if (!existsSync(r.path)) {
      tryGit(r.source, ["worktree", "prune"]);
      lines.push(`${r.name}: worktree already gone`);
      continue;
    }
    const known = listWorktrees(r.source).some((w) => samePath(w.path, r.path));
    const dirty = isDirty(r.path);
    const unpushed = unpushedCount(r.path);
    if (!known || dirty || unpushed) {
      left.push(r);
      lines.push(`${r.name}: kept, ${!known ? "not a worktree of its source repository" : dirty ? "uncommitted changes" : `${unpushed} unpushed commit(s)`}`);
      continue;
    }
    mustGit(r.source, ["worktree", "remove", r.path]);
    lines.push(`${r.name}: worktree removed (branch '${meta.branch}' kept)`);
  }
  if (left.length) {
    meta.repos = left;
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    lines.push(`set kept: ${left.length} worktree(s) need attention`);
  } else {
    rmSync(metaPath);
    try {
      rmdirSync(folder);
    } catch {
      lines.push(`folder ${folder} not removed: it holds other files`);
    }
    lines.push(`set for story ${o.story} removed`);
  }
  return o.json ? JSON.stringify({ story: o.story, lines, kept: left.map((r) => r.name) }) : lines.join("\n");
}

export { refSha };
