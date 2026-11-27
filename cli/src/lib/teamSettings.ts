import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";
import type { Ctx } from "./context.js";
import { git, repoRoot } from "./git.js";
import { findSet } from "./setInfo.js";
import { readSetFile } from "./setFile.js";
import { readUtf8, TEAM_FILE, type TeamConfig } from "./team.js";
import { explainOf, nodeAt, schemaKeys, teamSchema, type SchemaNode } from "./teamSchema.js";
import { isTemplateKey } from "./teamValidate.js";
import { readCopy, repoLabel, teamRepoFor, writeCopy, type TeamCopy, type TeamRepo } from "./teamSource.js";

/**
 * `aihub team show --json`: everything the Team settings page shows, in ONE read: which team.yaml applies (the team
 * repository or the repository's own file, its commit), every key with its value, group and one-line explanation per
 * repository of the set, the values that differ per repository, and the templates with their path. The page switches
 * between repositories without a new read.
 */

export const STORY_TEMPLATE = ".agents/skills/_shared/assets/story-template.md";
export const BUG_TEMPLATE = ".agents/skills/_shared/assets/bug-template.md";
export const COMMIT_TEMPLATE = ".agents/skills/_shared/assets/commit-template.txt";
export const PR_TEMPLATE = ".azuredevops/pull_request_template.md";

export const GROUPS = [
  { id: "branches", title: "Branches & naming" },
  { id: "pullRequests", title: "Pull requests" },
  { id: "stories", title: "Stories & bugs" },
  { id: "tests", title: "Tests" },
  { id: "fabric", title: "Fabric", collapsed: true },
  { id: "general", title: "General", collapsed: true },
] as const;
export type GroupId = (typeof GROUPS)[number]["id"];

const GROUP_OF: Record<string, GroupId> = {
  branches: "branches",
  cherryPick: "branches",
  worktrees: "branches",
  repositories: "branches",
  pullRequest: "pullRequests",
  pipelines: "pullRequests",
  workItems: "stories",
  language: "stories",
  robot: "tests",
  tests: "tests",
  fabric: "fabric",
  dataChecks: "fabric",
};
/** keys first in their group, in this order; the rest follows in file order */
const ORDER = ["branches.feature", "branches.protected", "defaultTarget", "releaseBranches", "aliases", "cherryPick.groups", "pullRequest.title", "pullRequest.emptySection", "pipelines", "workItems.storyType", "workItems.states", "language"];
/** per-repository keys: from the repository's entry in `repositories` and its `pipelines` */
const REPO_KEYS = ["defaultTarget", "releaseBranches", "aliases", "path"];
const NONE = "–";

export interface KeyRow {
  key: string;
  group: GroupId;
  value: unknown;
  display: string;
  explain: string;
  /** set: the value holds for this repository only (its `repositories` entry, its pipelines, or its own team.yaml) */
  repo?: string;
}

export interface TemplateRow {
  kind: "pr" | "story" | "bug" | "commit";
  title: string;
  /** the team.yaml key that names it */
  key: string;
  path: string;
  /** false: not found where the team.yaml points; undefined: not checked (offline) */
  exists?: boolean;
}

export interface RepoRow {
  name: string;
  path: string;
  branch: string;
  /** own: the repository has its own team.yaml; teamRepo: the team repository's; none: generic defaults */
  uses: "own" | "teamRepo" | "none";
  teamFile: { exists: boolean; path: string; commit?: string; date?: string; sameAsSource?: boolean };
}

export interface SourceInfo {
  kind: "teamRepo" | "repo" | "none";
  /** the team's display name (teamName), else the repository's name */
  team: string;
  label: string;
  org?: string;
  project?: string;
  repo?: string;
  localPath?: string;
  branch?: string;
  path: string;
  commit?: string;
  short?: string;
  date?: string;
  schema?: number;
  readAt: string;
  /** the team repository could not be read now: the last copy is shown (or nothing) */
  readError?: string;
}

export interface TeamShow {
  scope: { kind: "set" | "repo"; folder: string; story?: number; title?: string; group?: string; current: string };
  source: SourceInfo;
  repos: RepoRow[];
  groups: { id: GroupId; title: string; collapsed?: boolean }[];
  /** per view: "*" = the whole set, else a repository name */
  views: Record<string, KeyRow[]>;
  overrides: { key: string; values: { repo: string; display: string }[] }[];
  templates: TemplateRow[];
  /** where aihub looked, for the "no team.yaml" page */
  looked: { what: string; found: boolean; note: string }[];
}

// ---- values --------------------------------------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const scalar = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);
const nameOf = (o: Record<string, unknown>) => String(o.name ?? o.repository ?? o.id ?? Object.values(o).find((x) => typeof x === "string") ?? "?");

export function display(v: unknown, key = ""): string {
  if (v === undefined || v === null || v === "") return NONE;
  if (scalar(v)) return String(v);
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    if (v.every(scalar)) return `[${v.map(String).join(", ")}]`;
    return v.map((x) => (isObj(x) ? nameOf(x) + (key === "pipelines" && x.required === true ? ", required" : "") : String(x))).join(", ");
  }
  if (isObj(v)) {
    const entries = Object.entries(v);
    if (entries.every(([, x]) => Array.isArray(x))) return entries.map(([k, x]) => `${k} (${(x as unknown[]).length})`).join(", ");
    if (entries.every(([, x]) => scalar(x)))
      return entries
        .map(([k, x]) => (x === true ? k : x === false ? "" : String(x)))
        .filter(Boolean)
        .join(", ");
    return entries.map(([k]) => k).join(", ");
  }
  return String(v);
}

/** The rows of one team.yaml, as one repository sees it (`repo`: its `repositories` entry and pipelines are folded in). */
export function flatten(team: TeamConfig, schema: SchemaNode, repo?: string): KeyRow[] {
  const rows: KeyRow[] = [];
  const add = (key: string, value: unknown, explainKey = key, marker?: string) => {
    if (isTemplateKey(key) || key === "workItems.templates") return; // in the Templates card
    const top = key.split(".")[0];
    rows.push({ key, group: GROUP_OF[REPO_KEYS.includes(key) ? "repositories" : top] ?? "general", value, display: display(value, key), explain: explainOf(schema, explainKey), ...(marker ? { repo: marker } : {}) });
  };
  const walk = (obj: Record<string, unknown>, path: string[]) => {
    for (const [k, v] of Object.entries(obj)) {
      const p = [...path, k];
      const key = p.join(".");
      if (!path.length && (k === "repositories" || k === "pipelines")) continue;
      const node = nodeAt(schema, p);
      if (isObj(v) && path.length >= 1) {
        const wild = node?.children.some((c) => c.key === "*");
        const vals = Object.values(v);
        if (wild && vals.some(isObj)) {
          for (const [ek, ev] of Object.entries(v)) add(`${key}.${ek}`, ev, `${key}.${ek}`);
          continue;
        }
        if (wild || vals.every((x) => scalar(x) || (Array.isArray(x) && x.every(scalar)))) {
          add(key, v);
          continue;
        }
      }
      if (isObj(v)) walk(v, p);
      else add(key, v);
    }
  };
  walk(team as Record<string, unknown>, []);
  const repos = (team.repositories ?? []) as Record<string, unknown>[];
  const entry = repo ? (repos.find((r) => String(r.name ?? "").toLowerCase() === repo.toLowerCase()) ?? (repos.length === 1 && !repos[0].name ? repos[0] : undefined)) : undefined;
  if (repo) {
    for (const k of REPO_KEYS) if (entry && entry[k] !== undefined) add(k, entry[k], `repositories[].${k}`, repo);
    const pipes = ((team.pipelines ?? []) as Record<string, unknown>[]).filter((p) => String(p.repository ?? "").toLowerCase() === repo.toLowerCase());
    if (team.pipelines) add("pipelines", pipes, "pipelines", pipes.length ? repo : undefined);
  } else {
    if (repos.length) add("repositories", repos, "repositories");
    if (team.pipelines) add("pipelines", team.pipelines, "pipelines");
  }
  return sortRows(rows);
}

const rank = (k: string) => (ORDER.includes(k) ? ORDER.indexOf(k) : ORDER.length);
const sortRows = (rows: KeyRow[]) =>
  rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r.key) - rank(b.r.key) || a.i - b.i)
    .map((x) => x.r);

export function templatesOf(team: TeamConfig): TemplateRow[] {
  return [
    { kind: "pr", title: "Pull request", key: "pullRequest.template", path: team.pullRequest?.template ?? PR_TEMPLATE },
    { kind: "story", title: "Story", key: "workItems.storyTemplate", path: team.workItems?.storyTemplate ?? STORY_TEMPLATE },
    { kind: "bug", title: "Bug", key: "workItems.templates.Bug", path: team.workItems?.templates?.Bug ?? BUG_TEMPLATE },
    { kind: "commit", title: "Commit rule", key: "commits.format", path: COMMIT_TEMPLATE },
  ];
}

// ---- reading -------------------------------------------------------------------------------------------------------

export const parseTeam = (text: string | undefined): TeamConfig => {
  if (!text) return {};
  try {
    return (parse(text) as TeamConfig) ?? {};
  } catch {
    return {};
  }
};
const norm = (s: string | undefined) => (s ?? "").replace(/\r\n/g, "\n").trim();

/** How the team repository's file is read: injectable for tests (the default reads Azure DevOps through `aihub browse`). */
export type ReadTeamRepo = (ctx: Ctx, r: TeamRepo, paths: (content: string) => string[]) => Promise<TeamCopy>;

export const COPY_MAX_AGE_MS = 10 * 60_000;

export async function readTeamRepo(ctx: Ctx, r: TeamRepo, paths: (content: string) => string[]): Promise<TeamCopy> {
  const now = new Date((ctx.now ?? Date.now)()).toISOString();
  if (r.localPath) {
    const file = join(r.localPath, TEAM_FILE);
    if (!existsSync(file)) throw new Error(`no team.yaml in ${r.localPath} (${TEAM_FILE})`);
    const content = readUtf8(file);
    const [commit = "", date] = git(r.localPath, ["log", "-1", "--format=%H%x09%cI", "--", TEAM_FILE], { allowFail: true }).split("\t");
    const files = Object.fromEntries(paths(content).map((p) => [p, existsSync(join(r.localPath!, p))]));
    return { content, commit, date, branch: git(r.localPath, ["branch", "--show-current"], { allowFail: true }) || "HEAD", path: TEAM_FILE, readAt: now, files };
  }
  const { browseOf } = await import("./browse/core.js");
  const { browseFile, readFileAt } = await import("./browse/read.js");
  const b = browseOf(ctx, { org: r.org, refresh: true });
  const f = await browseFile(b, { project: r.project!, repo: r.repo!, path: `/${TEAM_FILE}`, ref: r.branch });
  if (f.content === null) throw new Error(`${TEAM_FILE} in ${repoLabel(r)} cannot be read (binary or too large)`);
  const files: Record<string, boolean> = {};
  for (const p of paths(f.content)) {
    try {
      await readFileAt(b, r.project!, r.repo!, `/${p.replace(/^\/+/, "")}`, { name: f.ref.name, kind: "branch" });
      files[p] = true;
    } catch (e) {
      if (/notFound|404|not found|could not be found/i.test(String((e as { kind?: string }).kind ?? "") + String((e as Error).message))) files[p] = false;
    }
  }
  return { content: f.content, commit: f.ref.commit, date: f.lastCommit?.at ?? undefined, branch: f.ref.name, path: TEAM_FILE, readAt: f.readAt, files };
}

export const templatePaths = (content: string) => templatesOf(parseTeam(content)).map((t) => t.path);

export interface ShowOpts {
  refresh?: boolean;
  /** the repository the page shows first (default: the one of this folder) */
  repo?: string;
  read?: ReadTeamRepo;
}

export async function teamShow(ctx: Ctx, o: ShowOpts = {}): Promise<TeamShow> {
  const schema = teamSchema();
  const now = new Date((ctx.now ?? Date.now)()).toISOString();
  const set = findSet(ctx.cwd);
  let here: string | undefined;
  try {
    here = repoRoot(ctx.cwd);
  } catch {
    here = undefined;
  }
  const repoList = set?.repos.length ? set.repos : here ? [{ name: basename(here), path: here, branch: git(here, ["branch", "--show-current"], { allowFail: true }) }] : [];
  if (!repoList.length) throw new Error("not inside a repository or a worktree set: open a repository first");
  const byName = (n?: string) => (n ? repoList.find((r) => r.name.toLowerCase() === n.toLowerCase()) : undefined);
  const current = byName(o.repo)?.name ?? repoList.find((r) => here && r.path.toLowerCase() === here.toLowerCase())?.name ?? repoList[0].name;
  const title = set ? (readSetFile(set.folder)?.top as { storyTitle?: string } | undefined)?.storyTitle : undefined;

  // the team repository: the copy, read again when asked, missing or older than 10 minutes
  const teamRepo = teamRepoFor(ctx.env, set?.folder);
  let copy: TeamCopy | undefined;
  let readError: string | undefined;
  if (teamRepo) {
    const old = readCopy(ctx.env, teamRepo);
    if (old && !o.refresh && old.ageMs < COPY_MAX_AGE_MS) copy = old;
    else {
      try {
        copy = await (o.read ?? readTeamRepo)(ctx, teamRepo, templatePaths);
        writeCopy(ctx.env, teamRepo, copy);
      } catch (e) {
        readError = (e as Error).message.replace(/^aihub:\s*/, "");
        copy = old;
      }
    }
  }

  const own = repoList.map((r) => {
    const file = join(r.path, TEAM_FILE);
    const exists = existsSync(file);
    const text = exists ? readUtf8(file) : undefined;
    const [commit, date] = exists ? git(r.path, ["log", "-1", "--format=%h%x09%cI", "--", TEAM_FILE], { allowFail: true }).split("\t") : [];
    return { r, exists, text, commit: commit || undefined, date: date || undefined };
  });
  const firstOwn = own.find((x) => x.r.name === current && x.exists) ?? own.find((x) => x.exists);
  const sourceText = copy?.content ?? firstOwn?.text;
  const sourceTeam = parseTeam(sourceText);
  const kind: SourceInfo["kind"] = copy ? "teamRepo" : firstOwn ? "repo" : "none";
  const label = teamRepo ? (teamRepo.repo ?? repoLabel(teamRepo)) : (firstOwn?.r.name ?? current);
  const source: SourceInfo = {
    kind,
    team: String((sourceTeam as { teamName?: unknown }).teamName ?? "") || (kind === "none" ? "No team" : label),
    label,
    ...(teamRepo ? { org: teamRepo.org, project: teamRepo.project, repo: teamRepo.repo, localPath: teamRepo.localPath } : firstOwn ? { repo: firstOwn.r.name, localPath: firstOwn.r.path } : {}),
    branch: copy?.branch ?? firstOwn?.r.branch,
    path: TEAM_FILE,
    commit: copy?.commit ?? firstOwn?.commit,
    short: (copy?.commit ?? firstOwn?.commit)?.slice(0, 7),
    date: copy?.date ?? firstOwn?.date,
    schema: typeof sourceTeam.version === "number" ? sourceTeam.version : undefined,
    readAt: copy?.readAt ?? now,
    ...(readError ? { readError } : {}),
  };

  const repos: RepoRow[] = own.map((x) => ({
    name: x.r.name,
    path: x.r.path,
    branch: x.r.branch,
    uses: x.exists ? "own" : copy ? "teamRepo" : "none",
    teamFile: { exists: x.exists, path: TEAM_FILE, commit: x.commit, date: x.date, ...(x.exists && sourceText !== undefined ? { sameAsSource: norm(x.text) === norm(sourceText) } : {}) },
  }));

  // what each repository sees: its own file, else the team repository's, else nothing (generic defaults)
  const teamOf = (x: (typeof own)[number]): TeamConfig | undefined => (x.exists ? parseTeam(x.text) : copy ? sourceTeam : undefined);
  const views: Record<string, KeyRow[]> = {};
  for (const x of own) {
    const t = teamOf(x);
    if (!t) {
      views[x.r.name] = [];
      continue;
    }
    const rows = flatten(t, schema, x.r.name);
    if (x.exists && kind === "teamRepo") {
      const base = new Map(flatten(sourceTeam, schema, x.r.name).map((r) => [r.key, r.display]));
      for (const row of rows) if (!row.repo && base.get(row.key) !== row.display) row.repo = x.r.name;
    }
    views[x.r.name] = rows;
  }

  // keys whose value differs between the repositories of the set
  const withTeam = own.filter((x) => teamOf(x));
  const keys = [...new Set(withTeam.flatMap((x) => views[x.r.name].map((r) => r.key)))];
  const overrides =
    repoList.length > 1 && withTeam.length
      ? keys
          .map((key) => ({
            key,
            values: repoList.map((r) => ({ repo: r.name, display: views[r.name]?.find((k) => k.key === key)?.display ?? NONE })),
          }))
          .filter((o2) => new Set(o2.values.filter((v) => withTeam.some((x) => x.r.name === v.repo)).map((v) => v.display)).size > 1 || (REPO_KEYS.includes(o2.key) || o2.key === "pipelines" ? new Set(o2.values.map((v) => v.display)).size > 1 : false))
      : [];

  // the whole set: the shared value, or "per repository" when it differs
  const setRows = kind === "none" ? [] : flatten(sourceTeam, schema).filter((r) => !["repositories", "pipelines"].includes(r.key));
  if (kind !== "none") {
    for (const key of ["defaultTarget", "releaseBranches", "pipelines"]) {
      const first = withTeam.map((x) => views[x.r.name].find((r) => r.key === key)).find(Boolean);
      if (first && !setRows.some((r) => r.key === key)) setRows.push({ ...first, repo: undefined });
    }
  }
  for (const o2 of overrides) {
    const row = setRows.find((r) => r.key === o2.key);
    if (row) Object.assign(row, { display: "per repository", value: undefined, repo: undefined });
  }
  views["*"] = sortRows(setRows);

  const templates = templatesOf(sourceTeam).map((t) => ({
    ...t,
    exists: copy ? copy.files?.[t.path] : firstOwn ? existsSync(join(firstOwn.r.path, t.path)) : undefined,
  }));

  const groups = GROUPS.map((g) => ({ ...g, title: g.id === "tests" && sourceTeam.robot ? "Tests: Robot" : g.title })) as TeamShow["groups"];
  const cur = own.find((x) => x.r.name === current)!;
  const looked = [
    { what: `${current}/${TEAM_FILE}`, found: cur.exists, note: cur.exists ? "found" : "not found" },
    teamRepo
      ? { what: repoLabel(teamRepo), found: !!copy, note: copy ? (readError ? `last copy (${readError})` : "team repository") : `cannot be read: ${readError ?? "unknown"}` }
      : { what: "team repository", found: false, note: `no team repository is set${set ? (set.story ? ` for #${set.story}` : " for this set") : ""}` },
  ];
  const others = own.filter((x) => x.r.name !== current && x.exists);
  if (others.length)
    looked.push({
      what: others.map((x) => x.r.name).join(", "),
      found: true,
      note: `team.yaml found${kind === "teamRepo" && others.every((x) => repos.find((r) => r.name === x.r.name)?.teamFile.sameAsSource) ? `, same as ${label}` : ""}`,
    });

  return {
    scope: { kind: set ? "set" : "repo", folder: set?.folder ?? here!, story: set?.story || undefined, title, group: set?.group, current },
    source,
    repos,
    groups,
    views,
    overrides,
    templates,
    looked,
  };
}

/** What the editor's key help needs: every schema key with its explanation and the example block of each top-level key. */
export function schemaHelp(schemaText: string, schema: SchemaNode = teamSchema()): { keys: ReturnType<typeof schemaKeys>; examples: Record<string, string> } {
  const examples: Record<string, string> = {};
  let top = "";
  for (const line of schemaText.replace(/\r\n/g, "\n").split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const m = /^([A-Za-z][A-Za-z0-9]*):/.exec(line);
    if (m) top = m[1];
    if (!top) continue;
    const code = line.replace(/\s+#.*$/, "").trimEnd();
    examples[top] = examples[top] ? `${examples[top]}\n${code}` : code;
  }
  return { keys: schemaKeys(schema), examples };
}
