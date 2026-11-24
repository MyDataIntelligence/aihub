import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isMap, isScalar, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from "yaml";
import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { repoRoot } from "./git.js";
import { configHome } from "./notifyPolicy.js";
import { resolveRepoDirs, type RepoDir } from "./repos.js";
import { loadTeam, TEAM_FILE, type TeamConfig } from "./team.js";

/**
 * Repository groups: a name for several clones that are opened together on one branch. They live in the user's own
 * config (`<config home>/groups.json`, e.g. ~/.config/aihub), never in a work repository; team.yaml can also tag
 * `repositories[]` entries with `groups: [name]`.
 */
export interface GroupRepo {
  name: string;
  path: string;
}
export interface Group {
  name: string;
  repos: GroupRepo[];
  source: "user" | "team";
}

const file = (env: NodeJS.ProcessEnv) => join(configHome(env), "groups.json");

function readUser(env: NodeJS.ProcessEnv): Record<string, GroupRepo[]> {
  try {
    const j = JSON.parse(readFileSync(file(env), "utf8")) as { groups?: Record<string, GroupRepo[]> };
    return j.groups ?? {};
  } catch {
    return {};
  }
}

const gitFolder = (dir: string) => existsSync(join(dir, ".git"));

function teamGroups(team: TeamConfig, root: string | undefined): Group[] {
  const by = new Map<string, GroupRepo[]>();
  for (const r of (team.repositories ?? []) as { name?: string; path?: string; groups?: string[] }[]) {
    if (!r.name) continue;
    for (const g of r.groups ?? []) {
      let path = r.path && root ? resolve(root, r.path) : "";
      if (!path && root) path = join(resolve(root, ".."), r.name);
      by.set(g, [...(by.get(g) ?? []), { name: r.name, path }]);
    }
  }
  return [...by].map(([name, repos]) => ({ name, repos, source: "team" as const }));
}

function currentRoot(ctx: Ctx): string | undefined {
  try {
    return repoRoot(ctx.cwd);
  } catch {
    return undefined;
  }
}

export function listGroups(ctx: Ctx): Group[] {
  const user = Object.entries(readUser(ctx.env)).map(([name, repos]) => ({ name, repos, source: "user" as const }));
  const root = currentRoot(ctx);
  const team = root ? teamGroups(loadTeam(root), root) : [];
  return [...user, ...team.filter((t) => !user.some((u) => u.name === t.name))].sort((a, b) => a.name.localeCompare(b.name));
}

export function findGroup(ctx: Ctx, name: string): Group {
  const g = listGroups(ctx).find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!g) throw new AihubError(`no repo group '${name}'; save one with: aihub worktree groups save ${name} --repos a,b,c`);
  return g;
}

/** Repository names or absolute folders -> clones. Names are looked up next to the current repository and in team.yaml. */
export function resolveRepos(ctx: Ctx, specs: string[]): RepoDir[] {
  const root = currentRoot(ctx);
  const team = root ? loadTeam(root) : {};
  const out: RepoDir[] = [];
  const names: string[] = [];
  for (const s of specs) {
    if (isAbsolute(s) || /^[A-Za-z]:[\/]/.test(s)) {
      if (!gitFolder(s)) throw new AihubError(`${s} is not a git clone`);
      out.push({ name: basename(s), dir: resolve(s) });
    } else names.push(s);
  }
  if (names.length) {
    if (!root) throw new AihubError(`repositories ${names.join(", ")} are looked up next to the current repository; run this inside a clone, or pass absolute folders`);
    out.push(...resolveRepoDirs(names, root, team as TeamConfig));
  }
  return specs.map((s) => out.find((o) => o.name === s || resolve(o.dir) === resolve(s)) ?? out.find((o) => o.name.toLowerCase() === s.toLowerCase())!).filter(Boolean);
}

export function saveGroup(ctx: Ctx, name: string, specs: string[]): Group {
  if (!/^[\w.-]+$/.test(name)) throw new AihubError("a group name uses letters, digits, '.', '-' and '_'");
  if (!specs.length) throw new AihubError("--repos needs at least one repository name or folder");
  const repos = resolveRepos(ctx, specs).map((r) => ({ name: r.name, path: r.dir }));
  const all = readUser(ctx.env);
  all[name] = repos;
  mkdirSync(configHome(ctx.env), { recursive: true });
  writeFileSync(file(ctx.env), JSON.stringify({ groups: all }, null, 2), "utf8");
  return { name, repos, source: "user" };
}

export function removeGroup(ctx: Ctx, name: string): boolean {
  const all = readUser(ctx.env);
  const key = Object.keys(all).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!key) return false;
  delete all[key];
  writeFileSync(file(ctx.env), JSON.stringify({ groups: all }, null, 2), "utf8");
  return true;
}

/** The clones of a group; a repo whose folder is gone is reported by name. */
export function groupDirs(ctx: Ctx, g: Group): { dirs: RepoDir[]; missing: string[] } {
  const dirs: RepoDir[] = [];
  const missing: string[] = [];
  for (const r of g.repos) if (r.path && gitFolder(r.path)) dirs.push({ name: r.name, dir: r.path });
  for (const r of g.repos) if (!(r.path && gitFolder(r.path))) missing.push(r.name);
  return { dirs, missing };
}

/**
 * Saves a group in the team.yaml of the current repository (for the whole team), keeping its comments: every
 * repository gets the group in `repositories[].groups`; one that is not next to this repository gets its `path`
 * (relative to the repository). The file is changed in the working tree only: commit it like any other change.
 */
export function saveTeamGroup(ctx: Ctx, name: string, specs: string[]): Group & { file: string } {
  if (!/^[\w.-]+$/.test(name)) throw new AihubError("a group name uses letters, digits, '.', '-' and '_'");
  const root = currentRoot(ctx);
  if (!root) throw new AihubError("a team group is saved in the team.yaml of a repository: run this inside a clone");
  const repos = resolveRepos(ctx, specs).map((r) => ({ name: r.name, path: r.dir }));
  const file = join(root, TEAM_FILE);
  const doc = existsSync(file) ? parseDocument(readFileSync(file, "utf8")) : parseDocument("");
  if (!doc.contents || !isMap(doc.contents)) doc.contents = doc.createNode({}) as never;
  let seq = doc.get("repositories");
  if (!isSeq(seq)) {
    doc.set("repositories", doc.createNode([]));
    seq = doc.get("repositories");
  }
  const items = (seq as YAMLSeq).items as YAMLMap[];
  for (const r of repos) {
    let entry = items.find((m) => isMap(m) && String(m.get("name") ?? "").toLowerCase() === r.name.toLowerCase());
    if (!entry) {
      const next = resolve(dirname(root), r.name).toLowerCase() === resolve(r.path).toLowerCase();
      entry = doc.createNode(next ? { name: r.name } : { name: r.name, path: relative(root, r.path).split("\\").join("/") }) as YAMLMap;
      (seq as YAMLSeq).add(entry);
    }
    const groups = entry.get("groups");
    if (isSeq(groups)) {
      if (!groups.items.some((g) => String(isScalar(g) ? g.value : g) === name)) groups.add(name);
    } else entry.set("groups", doc.createNode([name]));
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, doc.toString(), "utf8");
  return { name, repos, source: "team", file };
}
