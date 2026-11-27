import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AdoClient } from "../ado.js";
import { browseOf, BrowseError, cached, cacheRead, cacheWrite, meOf, personOf, TTL, type Browse, type MeInfo, type Person, type ReadMeta } from "../browse/core.js";
import { configHome } from "../configHome.js";
import type { Ctx } from "../context.js";
import { repoRoot } from "../git.js";
import { remoteOf } from "../pipelineView.js";
import { loadTeam, type TeamConfig } from "../team.js";

/**
 * The story browser: Azure DevOps work items (lists, board, one item, edits) for the bar, always as JSON. It shares the
 * cache and the error kinds of the repository browser. Reads are cached in the user's config folder; a write bumps the
 * "generation" of the project so every cached list and item of that project is read again next time.
 */

export const STORY_TTL = { lists: 2 * 60_000, item: 60_000, settings: TTL.lists, types: TTL.lists } as const;

// ---- the saved choice per organisation -------------------------------------------------------------------------------

export interface StorySettings {
  project?: string;
  team?: string;
  areaPath?: string;
  iterationPath?: string;
}

const SETTINGS = "story-browser.json";

function readAll(env: NodeJS.ProcessEnv): Record<string, StorySettings> {
  try {
    const f = join(configHome(env), SETTINGS);
    if (!existsSync(f)) return {};
    return ((JSON.parse(readFileSync(f, "utf8")) as { byOrg?: Record<string, StorySettings> }).byOrg ?? {}) as Record<string, StorySettings>;
  } catch {
    return {};
  }
}

export const readSettings = (env: NodeJS.ProcessEnv, org: string): StorySettings => readAll(env)[org.toLowerCase()] ?? {};

export function saveSettings(env: NodeJS.ProcessEnv, org: string, s: StorySettings): StorySettings {
  const all = readAll(env);
  const clean: StorySettings = {};
  for (const k of ["project", "team", "areaPath", "iterationPath"] as const) if (typeof s[k] === "string" && s[k]!.trim()) clean[k] = s[k]!.trim();
  all[org.toLowerCase()] = clean;
  const dir = configHome(env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SETTINGS), JSON.stringify({ schema: 1, byOrg: all }, null, 2), "utf8");
  return clean;
}

// ---- the context of one call -----------------------------------------------------------------------------------------

export interface Stories {
  b: Browse;
  project: string;
  team: string;
  settings: StorySettings;
  /** client of the project */
  c: AdoClient;
  /** client of the team (work/ APIs) */
  tc: AdoClient;
  /** the repository this runs in (team.yaml, templates), when it runs inside a clone */
  root?: string;
  teamCfg: TeamConfig;
}

export interface StoriesOpts {
  org?: string;
  project?: string;
  team?: string;
  refresh?: boolean;
}

function rootOf(ctx: Ctx): string | undefined {
  try {
    return repoRoot(ctx.cwd);
  } catch {
    return undefined;
  }
}

/** The project: --project, else the saved one, else the project of the clone this runs in. */
export function storiesOf(ctx: Ctx, o: StoriesOpts, needProject = true): Stories {
  const b = browseOf(ctx, { org: o.org, refresh: o.refresh });
  const settings = readSettings(ctx.env, b.org);
  const root = rootOf(ctx);
  let project = o.project || settings.project || "";
  if (!project && root) {
    try {
      // the project of this clone, read from .git/config (no git process)
      project = remoteOf(root).project.trim();
    } catch {
      /* not an Azure DevOps clone */
    }
  }
  if (!project && needProject) throw new BrowseError("needsSetting", "which project? choose one in the story browser settings (aihub stories settings --save --project P --team T)");
  const sameProject = !o.project || !settings.project || o.project.toLowerCase() === settings.project.toLowerCase();
  const team = o.team || (sameProject ? settings.team : undefined) || `${project} Team`;
  const c = b.client.forProject(project);
  return { b, project, team, settings: sameProject ? settings : {}, c, tc: c.forTeam(team), root, teamCfg: root ? loadTeam(root) : {} };
}

// ---- cache generation ------------------------------------------------------------------------------------------------

const genKey = (s: Stories) => `stories-gen|${s.b.org}|${s.project}`;

export const generation = (s: Stories): number => cacheRead<number>(s.b.env, genKey(s), TTL.forever, 0)?.data ?? 0;

/** After a write: every cached list and item of the project is stale. */
export function bumpGeneration(s: Stories): void {
  cacheWrite(s.b.env, genKey(s), generation(s) + 1, 0);
}

/** A read of the project through the cache; the key carries the generation, so a write makes it stale. */
export function read<T>(s: Stories, key: string, ttl: number, work: () => Promise<T>): Promise<{ data: T; meta: ReadMeta }> {
  return cached(s.b, `stories|${s.b.org}|${s.project}|g${generation(s)}|${key}`, ttl, work);
}

/** A read that does not change with writes (types, states, teams): no generation in the key. */
export function readStable<T>(s: Stories, key: string, ttl: number, work: () => Promise<T>): Promise<{ data: T; meta: ReadMeta }> {
  return cached(s.b, `stories|${s.b.org}|${s.project}|${key}`, ttl, work);
}

export const me = (s: Stories): Promise<MeInfo> => meOf(s.b);

// ---- fields, types and states ----------------------------------------------------------------------------------------

export const F = {
  id: "System.Id",
  rev: "System.Rev",
  type: "System.WorkItemType",
  title: "System.Title",
  state: "System.State",
  assignedTo: "System.AssignedTo",
  area: "System.AreaPath",
  iteration: "System.IterationPath",
  priority: "Microsoft.VSTS.Common.Priority",
  severity: "Microsoft.VSTS.Common.Severity",
  tags: "System.Tags",
  parent: "System.Parent",
  changed: "System.ChangedDate",
  systemInfo: "Microsoft.VSTS.TCM.SystemInfo",
  history: "System.History",
  storyPoints: "Microsoft.VSTS.Scheduling.StoryPoints",
  effort: "Microsoft.VSTS.Scheduling.Effort",
  size: "Microsoft.VSTS.Scheduling.Size",
} as const;

/** The estimate field of the process: StoryPoints (Agile), Effort (Scrum, Basic), Size (CMMI). */
export async function pointsField(s: Stories): Promise<string> {
  const t = (await storyTypeOf(s)).toLowerCase();
  return t === "product backlog item" || t === "issue" ? F.effort : t === "requirement" ? F.size : F.storyPoints;
}

export const ROW_FIELDS = [F.id, F.rev, F.type, F.title, F.state, F.assignedTo, F.area, F.iteration, F.priority, F.severity, F.tags, F.parent, F.changed];

export type StateCategory = "Proposed" | "InProgress" | "Resolved" | "Completed" | "Removed" | "";

export interface TypeState {
  name: string;
  category: StateCategory;
}

/** The states of a work item type, in their order, with their category (kept 4 hours). */
export async function statesOf(s: Stories, type: string): Promise<TypeState[]> {
  return (
    await readStable(s, `states|${type.toLowerCase()}`, STORY_TTL.types, async () => {
      const r = await s.c.get<{ value?: { name: string; category?: string }[] }>(`wit/workitemtypes/${encodeURIComponent(type)}/states`);
      return (r.value ?? []).map((x) => ({ name: x.name, category: (x.category ?? "") as StateCategory }));
    })
  ).data;
}

/** The fields of a work item type (reference names) and the allowed values of the ones the browser offers (kept 4 hours). */
export async function typeFieldsOf(s: Stories, type: string): Promise<{ fields: string[]; allowed: Record<string, string[]> }> {
  return (
    await readStable(s, `fields|${type.toLowerCase()}`, STORY_TTL.types, async () => {
      const r = await s.c.get<{ value?: { referenceName?: string; allowedValues?: string[] }[] }>(`wit/workitemtypes/${encodeURIComponent(type)}/fields`, { $expand: "allowedValues" });
      const fields = (r.value ?? []).map((f) => f.referenceName ?? "").filter(Boolean);
      const allowed: Record<string, string[]> = {};
      for (const f of r.value ?? []) if (f.referenceName && f.allowedValues?.length && [F.severity, F.priority].includes(f.referenceName as never)) allowed[f.referenceName] = f.allowedValues.map(String);
      return { fields, allowed };
    })
  ).data;
}

/** The work item types of the project (kept 4 hours). */
export async function projectTypes(s: Stories): Promise<string[]> {
  return (
    await readStable(s, "types", STORY_TTL.types, async () => {
      const r = await s.c.get<{ value?: { name: string; isDisabled?: boolean }[] }>("wit/workitemtypes");
      return (r.value ?? []).filter((t) => !t.isDisabled).map((t) => t.name);
    })
  ).data;
}

const STORY_TYPES = ["User Story", "Product Backlog Item", "Requirement", "Issue"];

/** The story type: team.yaml, else the first backlog type the process has (User Story, Product Backlog Item, Requirement, Issue). */
export async function storyTypeOf(s: Stories): Promise<string> {
  if (s.teamCfg.workItems?.storyType) return s.teamCfg.workItems.storyType;
  try {
    const all = (await projectTypes(s)).map((t) => t.toLowerCase());
    return STORY_TYPES.find((t) => all.includes(t.toLowerCase())) ?? "User Story";
  } catch {
    return "User Story";
  }
}

/** The types the lists show by default: the story type, and Bug when the process has it. */
export async function defaultTypes(s: Stories): Promise<string[]> {
  const story = await storyTypeOf(s);
  try {
    const all = await projectTypes(s);
    return all.some((t) => t.toLowerCase() === "bug") ? [story, "Bug"] : [story];
  } catch {
    return [story, "Bug"];
  }
}

/** "Story" / "story" means the story type of the project. */
export async function resolveTypeName(s: Stories, type: string | undefined): Promise<string> {
  const t = (type ?? "").trim();
  if (!t || /^(story|user ?story)$/i.test(t)) return storyTypeOf(s);
  try {
    const hit = (await projectTypes(s)).find((x) => x.toLowerCase() === t.toLowerCase());
    if (hit) return hit;
  } catch {
    /* keep the name as given */
  }
  return t;
}

// ---- rows ------------------------------------------------------------------------------------------------------------

export interface LocalLinks {
  set?: { folder: string; name: string };
  branches: { repo: string; branch: string; worktree?: string }[];
}

export interface ItemRow {
  id: number;
  rev: number;
  type: string;
  title: string;
  state: string;
  stateCategory: StateCategory;
  assignedTo: Person | null;
  areaPath: string;
  iterationPath: string;
  priority?: number;
  severity?: string;
  storyPoints?: number;
  tags: string[];
  parent?: number;
  changedDate: string;
  url: string;
  local: LocalLinks;
}

export const tagsOf = (t: unknown): string[] =>
  String(t ?? "")
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean);

export function personOrNull(v: unknown, m: MeInfo): Person | null {
  if (!v) return null;
  if (typeof v === "string") {
    const em = /<([^>]+)>/.exec(v)?.[1] ?? (v.includes("@") ? v : "");
    return personOf({ displayName: v.replace(/\s*<[^>]+>\s*$/, ""), uniqueName: em }, m);
  }
  return personOf(v as { displayName?: string; uniqueName?: string; id?: string }, m);
}

export function rowOf(s: Stories, f: Record<string, any>, m: MeInfo, cat: (type: string, state: string) => StateCategory, local: LocalLinks = { branches: [] }): ItemRow {
  const id = Number(f[F.id]);
  const pr = f[F.priority];
  return {
    id,
    rev: Number(f[F.rev] ?? 0),
    type: String(f[F.type] ?? ""),
    title: String(f[F.title] ?? ""),
    state: String(f[F.state] ?? ""),
    stateCategory: cat(String(f[F.type] ?? ""), String(f[F.state] ?? "")),
    assignedTo: personOrNull(f[F.assignedTo], m),
    areaPath: String(f[F.area] ?? ""),
    iterationPath: String(f[F.iteration] ?? ""),
    ...(pr !== undefined && pr !== null && pr !== "" ? { priority: Number(pr) } : {}),
    ...(f[F.severity] ? { severity: String(f[F.severity]) } : {}),
    ...([F.storyPoints, F.effort, F.size].map((k) => f[k]).find((x) => x !== undefined && x !== null && x !== "") !== undefined ? { storyPoints: Number([F.storyPoints, F.effort, F.size].map((k) => f[k]).find((x) => x !== undefined && x !== null && x !== "")) } : {}),
    tags: tagsOf(f[F.tags]),
    ...(f[F.parent] ? { parent: Number(f[F.parent]) } : {}),
    changedDate: String(f[F.changed] ?? ""),
    url: s.c.workItemUrl(id),
    local,
  };
}

/** The category of a state, for every type in `types` (one states read per type, cached). */
export async function categorizer(s: Stories, types: string[]): Promise<(type: string, state: string) => StateCategory> {
  const map = new Map<string, TypeState[]>();
  for (const t of [...new Set(types.map((x) => x.toLowerCase()))]) {
    try {
      map.set(t, await statesOf(s, t));
    } catch {
      map.set(t, []);
    }
  }
  return (type, state) => map.get(type.toLowerCase())?.find((x) => x.name.toLowerCase() === state.toLowerCase())?.category ?? "";
}

/** Fields of up to 200 work items per call, in the order of `ids` (missing ones left out). */
export async function fetchFields(s: Stories, ids: number[], given?: string[]): Promise<Record<string, any>[]> {
  const fields = given ?? [...ROW_FIELDS, await pointsField(s)];
  const out: Record<string, any>[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    const r = await s.c.post<{ value?: { id: number; fields?: Record<string, any> }[] }>("wit/workitemsbatch", { ids: part, fields, errorPolicy: "omit" });
    for (const w of r.value ?? []) if (w && w.fields) out.push({ ...w.fields, [F.id]: w.id ?? w.fields[F.id] });
  }
  const pos = new Map(ids.map((id, i) => [id, i]));
  return out.sort((a, b) => (pos.get(Number(a[F.id])) ?? 0) - (pos.get(Number(b[F.id])) ?? 0));
}

export async function wiql(s: Stories, query: string, top: number, team = false): Promise<number[]> {
  const client = team ? s.tc : s.c;
  const r = await client.request<{ workItems?: { id: number }[] }>("POST", "wit/wiql", { body: { query }, query: { $top: top } });
  return [...new Set((r.data.workItems ?? []).map((w) => w.id))];
}

export const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
