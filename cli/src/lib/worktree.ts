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
import { MAKER_SET, readJsonText, readSetFile, repoBranch, writeSetFile, type SetMeta } from "./setFile.js";
import { checkExisting, moveExisting, readWhenExists, recreateExisting, type WhenExists } from "./existingWorktree.js";

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
  /** a branch whose worktree is elsewhere: move, reuse or recreate it (else the personal preference, else ask) */
  existing?: Exclude<WhenExists, "ask">;
  discardLocalWork?: boolean;
  /** the command to repeat with --existing in the question */
  again?: string;
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
    ? (JSON.parse(readJsonText(metaPath)) as SetMeta)
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

  // what each repository becomes; a branch with a worktree elsewhere is asked about before anything is created
  const todo = dirs.filter((d) => !meta.repos.some((r) => r.name === d.name)).map((d) => {
    const own = o.branches?.[d.name] ?? branch;
    return { d, own, path: worktreePathFor({ root: setsRoot, storyId: o.story, repo: d.name, branch: own, storyFolders: [basename(folder)], exists: existsSync }) };
  });
  const again = o.again ?? `aihub worktree create --story ${o.story} --repos ${o.repos.join(",")} --branch ${branch}`;
  const policy = o.existing ?? readWhenExists(ctx.env);
  const lists = checkExisting(todo.map((t) => ({ repo: t.d.name, source: t.d.dir, branch: t.own, target: t.path })), { folder, policy, again });
  mkdirSync(folder, { recursive: true });
  const lines: string[] = [];
  for (const d of dirs) if (meta.repos.some((r) => r.name === d.name)) lines.push(`${d.name}: already in the set`);
  for (const { d, own, path } of todo) {
    const busy = (lists.get(d.dir) ?? listWorktrees(d.dir)).find((w) => w.branch === own);
    if (busy?.main) {
      throw new AihubError(`branch '${own}' is already checked out in ${busy.path}; switch that checkout to another branch first (nothing was changed)`);
    }
    if (busy) {
      // the question was asked (checkExisting); here the answer: reuse it there, move it here, or recreate it here
      const how = policy === "ask" ? "reuse" : policy;
      const inside = samePath(dirname(busy.path), folder);
      if (inside || how === "reuse") {
        meta.repos.push({ name: d.name, source: d.dir, path: busy.path, ...(own !== branch ? { branch: own } : {}) });
        lines.push(`${d.name}: worktree ${busy.path} on '${own}' reused`);
        writeFileSync(metaPath, JSON.stringify(meta, null, 2));
        continue;
      }
      const p = how === "move" ? moveExisting(d.dir, own, busy.path, path, again) : recreateExisting(d.dir, own, busy.path, path, { discard: o.discardLocalWork, again });
      if (!p.ok) throw new AihubError(`${d.name}: ${p.note}`);
      meta.repos.push({ name: d.name, source: d.dir, path, ...(own !== branch ? { branch: own } : {}) });
      lines.push(`${d.name}: ${p.note}`);
      writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      continue;
    }
    fetchOrigin(d.dir);
    const base = await baseFor(d.dir, clientForDir(ctx, d.dir), team, o.base);
    const e = ensureBranch(d.dir, own, base);
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

/**
 * One worktree of a set removed, never with work in it: uncommitted changes, unpushed commits or a folder that is not
 * a worktree of its source keep it (removed false, the reason in the line). Folder links (a node_modules junction) go
 * first: git would empty the folder they point to. The branch stays.
 */
export function removeWorktreeSafely(r: { name: string; source: string; path: string }, branch: string): { removed: boolean; line: string } {
  if (!existsSync(r.path)) {
    tryGit(r.source, ["worktree", "prune"]);
    return { removed: true, line: `${r.name}: worktree already gone` };
  }
  const listed = listWorktrees(r.source);
  // a set entry that IS the main clone (a story branch that was checked out there and reused): never removable, it only leaves the set
  if (listed.some((w) => w.main && samePath(w.path, r.path))) return { removed: true, line: `${r.name}: the main clone ${r.path} stays where it is; it is no longer part of the set` };
  const known = listed.some((w) => samePath(w.path, r.path));
  const links = known ? findDirLinks(r.path) : [];
  const linkSet = new Set(links.map((l) => l.rel.replace(/\\/g, "/")));
  const dirty = known && tryGit(r.path, ["status", "--porcelain"]).out.split("\n").filter(Boolean).some((l) => !linkSet.has(l.slice(3).replace(/\/$/, "")));
  const unpushed = unpushedCount(r.path);
  if (!known || dirty || unpushed) return { removed: false, line: `${r.name}: kept, ${!known ? "not a worktree of its source repository" : dirty ? "uncommitted changes" : `${unpushed} unpushed commit(s)`}` };
  for (const l of links) removeDirLink(join(r.path, l.rel));
  mustGit(r.source, ["worktree", "remove", r.path]);
  return { removed: true, line: `${r.name}: worktree removed (branch '${branch}' kept)` };
}

export function removeSet(ctx: Ctx, o: { story?: number; branch?: string; root?: string; folder?: string; json?: boolean }): string {
  const root = repoRoot(ctx.cwd);
  const setsRoot = resolve(o.root ?? defaultSetsRoot(root));
  // a story branch opened with `worktree open` lives in its story folder, next to the other sets of that story
  const storyId = o.story ?? (o.branch ? storyIdFromBranch(o.branch) : undefined);
  const byBranch = join(setsRoot, slugOfBranch(o.branch ?? ""));
  // --folder names the set folder itself (the menus know it from the scan); else it is found from the story or the branch
  const folder = o.folder ? resolve(o.folder) : o.story ? setFolder(setsRoot, o.story) : storyId && !existsSync(join(byBranch, META)) ? setFolder(setsRoot, storyId, o.branch) : byBranch;
  // the extension's own format (.worktree-set.json) is a set too: same checks, same result
  const maker = !existsSync(join(folder, META)) && readSetFile(folder)?.kind === "maker";
  const metaPath = join(folder, maker ? MAKER_SET : META);
  if (!existsSync(metaPath)) throw new AihubError(o.folder ? `no worktree set in ${folder}` : `no worktree set for ${o.story ? `story ${o.story}` : `branch '${o.branch}'`} under ${setsRoot}`);
  const top = maker ? readSetFile(folder)!.top : (JSON.parse(readJsonText(metaPath)) as SetMeta);
  const all = [{ ...top, others: undefined }, ...(top.others ?? [])];
  // naming a branch or a story that is not in this folder (anymore) removes nothing: never "the top set instead"
  const named = o.branch ? (s: SetMeta) => s.branch === o.branch : o.story ? (s: SetMeta) => s.story === o.story : undefined;
  const meta = named ? all.find(named) : all[0];
  if (!meta) throw new AihubError(`no worktree set for ${o.branch ? `branch '${o.branch}'` : `story ${o.story}`} in ${folder}${all.length ? ` (it holds: ${all.map((s) => `'${s.branch}'`).join(", ")})` : ""}; nothing was removed`);
  const rest = all.filter((s) => s !== meta);
  const lines: string[] = [];
  const left: SetMeta["repos"] = [];
  for (const r of meta.repos) {
    // one failing repository (a locked worktree, a submodule) keeps only itself in the set; the others are still handled
    let x: { removed: boolean; line: string };
    try {
      x = removeWorktreeSafely(r, repoBranch(meta, r));
    } catch (e) {
      x = { removed: false, line: `${r.name}: kept, ${(e as Error).message.split("\n")[0]}` };
    }
    if (!x.removed) left.push(r);
    lines.push(x.line);
  }
  const write = (sets: SetMeta[]) => maker ? writeSetFile(folder, "maker", sets[0]) : writeFileSync(metaPath, JSON.stringify({ ...sets[0], ...(sets.length > 1 ? { others: sets.slice(1) } : {}) }, null, 2));
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
