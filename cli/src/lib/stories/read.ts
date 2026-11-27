import { BrowseError, cached, personOf, pool, TTL, type MeInfo, type Person } from "../browse/core.js";
import { scanThisPc } from "../machineFolders.js";
import type { Scan } from "../machineScan.js";
import { rememberStories } from "../storyCache.js";
import { branchNamedForStory } from "../storyWorktrees.js";
import { htmlToMd, mdToHtml } from "../story.js";
import {
  categorizer,
  defaultTypes,
  F,
  fetchFields,
  me,
  pointsField,
  q,
  read,
  ROW_FIELDS,
  readStable,
  rowOf,
  statesOf,
  STORY_TTL,
  storyTypeOf,
  typeFieldsOf,
  wiql,
  type ItemRow,
  type LocalLinks,
  type StateCategory,
  type Stories,
  type TypeState,
} from "./core.js";
import { sectionsOf, type ItemSection } from "./template.js";

// ---- settings lists --------------------------------------------------------------------------------------------------

export async function storyProjects(s: Pick<Stories, "b">): Promise<{ org: string; projects: { id: string; name: string }[] }> {
  const r = await cached(s.b, `stories|${s.b.org}|projects`, TTL.lists, async () => {
    const list = (await s.b.client.request<{ value?: { id: string; name: string }[] }>("GET", "projects", { orgLevel: true, query: { $top: 1000 } })).data.value ?? [];
    return list.map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name));
  });
  return { org: s.b.org, projects: r.data };
}

export async function storyTeams(s: Stories): Promise<{ project: string; teams: { id: string; name: string; isDefault: boolean }[] }> {
  const r = await readStable(s, "teams", STORY_TTL.settings, async () => {
    const teams = (await s.b.client.request<{ value?: { id: string; name: string }[] }>("GET", `projects/${encodeURIComponent(s.project)}/teams`, { orgLevel: true, query: { $top: 500 } })).data.value ?? [];
    const p = (await s.b.client.request<{ defaultTeam?: { id: string } }>("GET", `projects/${encodeURIComponent(s.project)}`, { orgLevel: true })).data;
    return teams.map((t) => ({ id: t.id, name: t.name, isDefault: t.id === p.defaultTeam?.id })).sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
  });
  return { project: s.project, teams: r.data };
}

export interface TeamAreas {
  defaultArea: string;
  areas: { path: string; includeChildren: boolean }[];
}

export async function teamAreas(s: Stories): Promise<TeamAreas> {
  return (
    await readStable(s, `areas|${s.team}`, STORY_TTL.settings, async () => {
      const r = await s.tc.get<{ defaultValue?: string; values?: { value: string; includeChildren?: boolean }[] }>("work/teamsettings/teamfieldvalues");
      return { defaultArea: r.defaultValue ?? s.project, areas: (r.values ?? []).map((v) => ({ path: v.value, includeChildren: !!v.includeChildren })) };
    })
  ).data;
}

/** The team's areas and every area path of the project (for a choice of a narrower one). */
export async function storyAreas(s: Stories): Promise<TeamAreas & { project: string; team: string; all: string[] }> {
  const t = await teamAreas(s);
  const all = (
    await readStable(s, "area-tree", STORY_TTL.settings, async () => {
      const root = await s.c.get<Node>("wit/classificationnodes/areas", { $depth: 10 });
      return flatten(root, "");
    })
  ).data;
  return { project: s.project, team: s.team, ...t, all };
}

interface Node {
  name: string;
  children?: Node[];
}

const flatten = (n: Node, prefix: string): string[] => {
  const path = prefix ? `${prefix}\\${n.name}` : n.name;
  return [path, ...(n.children ?? []).flatMap((c) => flatten(c, path))];
};

export interface Iteration {
  id: string;
  name: string;
  path: string;
  start?: string;
  finish?: string;
  timeFrame: "past" | "current" | "future" | "";
}

export async function teamIterations(s: Stories): Promise<Iteration[]> {
  return (
    await readStable(s, `iterations|${s.team}`, STORY_TTL.lists, async () => {
      const r = await s.tc.get<{ value?: { id: string; name: string; path: string; attributes?: { startDate?: string; finishDate?: string; timeFrame?: string } }[] }>("work/teamsettings/iterations");
      return (r.value ?? []).map((i) => ({ id: i.id, name: i.name, path: i.path, start: i.attributes?.startDate, finish: i.attributes?.finishDate, timeFrame: (i.attributes?.timeFrame ?? "") as Iteration["timeFrame"] }));
    })
  ).data;
}

export async function storyIterations(s: Stories): Promise<{ project: string; team: string; iterations: Iteration[]; current?: string }> {
  const iterations = await teamIterations(s);
  return { project: s.project, team: s.team, iterations, current: iterations.find((i) => i.timeFrame === "current")?.path };
}

/** The current sprint: the saved iteration when one is chosen, else the team's current one. */
export async function currentIteration(s: Stories): Promise<string | undefined> {
  if (s.settings.iterationPath) return s.settings.iterationPath;
  try {
    return (await teamIterations(s)).find((i) => i.timeFrame === "current")?.path;
  } catch {
    return undefined;
  }
}

// ---- local links (sets and branches on this PC) ----------------------------------------------------------------------

/** One scan of this PC per call (cached 5 minutes by the scanner): no git process. */
export function localIndex(s: Stories): (id: number) => LocalLinks {
  let scan: Scan | undefined;
  try {
    scan = scanThisPc(s.b.env, s.b.ctx.cwd, { now: s.b.now() });
  } catch {
    scan = undefined;
  }
  return (id) => {
    if (!scan) return { branches: [] };
    const set = scan.sets.find((x) => x.story === id && x.repos.some((r) => r.exists));
    const seen = new Set<string>();
    const branches: LocalLinks["branches"] = [];
    const add = (repo: string, branch: string, worktree?: string) => {
      const k = `${repo}\u0000${branch}`.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      branches.push({ repo, branch, ...(worktree ? { worktree } : {}) });
    };
    for (const r of set?.repos ?? []) if (r.exists) add(r.name, r.branch, r.path);
    for (const c of scan.checkouts ?? []) if (branchNamedForStory(c.branch, id)) add(c.repo, c.branch, c.path);
    for (const r of scan.refs ?? []) for (const b of r.branches) if (branchNamedForStory(b, id)) add(r.repo, b);
    return { ...(set ? { set: { folder: set.folder, name: set.folder.split(/[\\/]/).filter(Boolean).pop() ?? set.folder } } : {}), branches };
  };
}

// ---- lists -----------------------------------------------------------------------------------------------------------

export type View = "mine" | "sprint" | "backlog";

export interface ListOpts {
  view: View;
  types?: string[];
  search?: string;
  top?: number;
}

async function areaClause(s: Stories): Promise<string> {
  if (s.settings.areaPath) return `[System.AreaPath] UNDER ${q(s.settings.areaPath)}`;
  try {
    const a = await teamAreas(s);
    if (!a.areas.length) return `[System.AreaPath] UNDER ${q(s.project)}`;
    return `(${a.areas.map((x) => `[System.AreaPath] ${x.includeChildren ? "UNDER" : "="} ${q(x.path)}`).join(" OR ")})`;
  } catch {
    return `[System.AreaPath] UNDER ${q(s.project)}`;
  }
}

/** The state names that count as finished (Completed or Removed) for these types. */
async function closedStates(s: Stories, types: string[]): Promise<string[]> {
  const out = new Set<string>();
  for (const t of types) {
    try {
      for (const st of await statesOf(s, t)) if (st.category === "Completed" || st.category === "Removed") out.add(st.name);
    } catch {
      ["Closed", "Done", "Removed"].forEach((x) => out.add(x));
    }
  }
  return [...out];
}

export async function listWiql(s: Stories, o: ListOpts, types: string[], iteration?: string): Promise<string> {
  const where: string[] = [`[System.TeamProject] = ${q(s.project)}`, `[System.WorkItemType] IN (${types.map(q).join(", ")})`];
  const search = (o.search ?? "").trim().replace(/^(AB)?#/i, "");
  if (/^\d+$/.test(search)) return `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = ${q(s.project)} AND [System.Id] = ${Number(search)}`;
  if (search) where.push(`[System.Title] CONTAINS ${q(search)}`);
  const closed = await closedStates(s, types);
  let order = "[System.ChangedDate] DESC";
  if (o.view === "mine") {
    where.push("[System.AssignedTo] = @Me");
    if (closed.length) where.push(`[System.State] NOT IN (${closed.map(q).join(", ")})`);
  } else if (o.view === "sprint") {
    where.push(await areaClause(s));
    where.push(`[System.IterationPath] = ${q(iteration ?? "")}`);
    order = "[System.State] ASC, [System.ChangedDate] DESC";
  } else {
    where.push(await areaClause(s));
    if (closed.length) where.push(`[System.State] NOT IN (${closed.map(q).join(", ")})`);
    const scrum = (await storyTypeOf(s)).toLowerCase() === "product backlog item";
    order = `[${scrum ? "Microsoft.VSTS.Common.BacklogPriority" : "Microsoft.VSTS.Common.StackRank"}] ASC, [System.ChangedDate] DESC`;
  }
  return `SELECT [System.Id] FROM WorkItems WHERE ${where.join(" AND ")} ORDER BY ${order}`;
}

export async function rowsFor(s: Stories, ids: number[], m: MeInfo): Promise<ItemRow[]> {
  const fields = await fetchFields(s, ids);
  const cat = await categorizer(s, fields.map((f) => String(f[F.type] ?? "")));
  return fields.map((f) => rowOf(s, f, m, cat));
}

export async function storyList(s: Stories, o: ListOpts): Promise<{ view: View; project: string; team: string; types: string[]; iterationPath?: string; items: ItemRow[]; readAt: string; cached: boolean }> {
  if (!["mine", "sprint", "backlog"].includes(o.view)) throw new BrowseError("badInput", "--view is mine, sprint or backlog");
  const types = o.types?.length ? o.types : await defaultTypes(s);
  const iteration = o.view === "sprint" ? await currentIteration(s) : undefined;
  const top = Math.min(Math.max(o.top ?? 200, 1), 500);
  const m = await me(s);
  const r = await read(s, `list|${s.team}|${s.settings.areaPath ?? ""}|${o.view}|${types.join(",")}|${iteration ?? ""}|${o.search ?? ""}|${top}`, STORY_TTL.lists, async () => {
    if (o.view === "sprint" && !iteration && !/^\s*(AB)?#?\d+\s*$/i.test(o.search ?? "")) return [] as ItemRow[];
    const ids = await wiql(s, await listWiql(s, o, types, iteration), top);
    return rowsFor(s, ids, m);
  });
  const local = localIndex(s);
  const items = r.data.map((x) => ({ ...x, local: local(x.id) }));
  try {
    rememberStories(s.b.env, items.map((x) => ({ id: x.id, title: x.title, state: x.state })), s.b.now());
  } catch {
    /* the seen-stories list is a convenience */
  }
  return { view: o.view, project: s.project, team: s.team, types, ...(iteration ? { iterationPath: iteration } : {}), items, readAt: r.meta.readAt, cached: r.meta.cached };
}

// ---- board -----------------------------------------------------------------------------------------------------------

export interface BoardColumn {
  name: string;
  states: string[];
  category: string;
  isDone: boolean;
  wipLimit?: number;
  items: ItemRow[];
}

export interface AdoColumn {
  name: string;
  itemLimit?: number;
  columnType?: string;
  stateMappings?: Record<string, string>;
}

/** A board of the team with its columns and the field that holds an item's column (for columns that share a state). */
export interface BoardDef {
  name: string;
  columns: AdoColumn[];
  columnField?: string;
}

const STORY_BOARDS = /^(stories|backlog items|requirements|issues)$/i;

/** The board: --board, else the one that maps the story type, else the backlog board (Stories, Backlog items, Issues), else the first that is not Epics/Features. */
export async function boardOf(s: Stories, name?: string): Promise<BoardDef> {
  const get = async (n: string): Promise<BoardDef> => {
    const b = await s.tc.get<{ name?: string; columns?: AdoColumn[]; fields?: { columnField?: { referenceName?: string } } }>(`work/boards/${encodeURIComponent(n)}`);
    return { name: b.name ?? n, columns: b.columns ?? [], ...(b.fields?.columnField?.referenceName ? { columnField: b.fields.columnField.referenceName } : {}) };
  };
  if (name) return get(name);
  const storyType = (await storyTypeOf(s)).toLowerCase();
  const boards = (await s.tc.get<{ value?: { id: string; name: string }[] }>("work/boards")).value ?? [];
  const defs: BoardDef[] = [];
  for (const bd of boards) {
    const d = await get(bd.name);
    if (d.columns.some((x) => Object.keys(x.stateMappings ?? {}).some((t) => t.toLowerCase() === storyType))) return d;
    defs.push(d);
  }
  const pick = defs.find((d) => STORY_BOARDS.test(d.name)) ?? defs.find((d) => !/^(epics|features)$/i.test(d.name)) ?? defs[0];
  if (!pick) throw new BrowseError("notFound", `team ${s.team} has no board`);
  return pick;
}

export async function storyBoard(s: Stories, o: { board?: string; types?: string[] }): Promise<{ board: string; project: string; team: string; columnField?: string; columns: BoardColumn[]; readAt: string; cached: boolean }> {
  const m = await me(s);
  const r = await read(s, `board|${s.team}|${s.settings.areaPath ?? ""}|${o.board ?? ""}|${(o.types ?? []).join(",")}`, STORY_TTL.lists, async () => {
    const def = await boardOf(s, o.board);
    const cols = def.columns;
    const mapped = [...new Set(cols.flatMap((c) => Object.keys(c.stateMappings ?? {})))];
    const types = o.types?.length ? o.types.filter((t) => mapped.some((x) => x.toLowerCase() === t.toLowerCase())) : mapped;
    const closed = await closedStates(s, types);
    const where = [`[System.TeamProject] = ${q(s.project)}`, `[System.WorkItemType] IN (${types.map(q).join(", ")})`, await areaClause(s)];
    // the done column shows the last two weeks, like the board in Azure DevOps
    if (closed.length) where.push(`([System.State] NOT IN (${closed.map(q).join(", ")}) OR [System.ChangedDate] >= @Today - 14)`);
    const ids = types.length
      ? await wiql(s, `SELECT [System.Id] FROM WorkItems WHERE ${where.join(" AND ")} ORDER BY [Microsoft.VSTS.Common.StackRank] ASC, [System.ChangedDate] DESC`, 400).catch(() =>
          wiql(s, `SELECT [System.Id] FROM WorkItems WHERE ${where.join(" AND ")} ORDER BY [System.ChangedDate] DESC`, 400),
        )
      : [];
    const fields = await fetchFields(s, ids, [...ROW_FIELDS, await pointsField(s), ...(def.columnField ? [def.columnField] : [])]);
    const cat = await categorizer(s, fields.map((f) => String(f[F.type] ?? "")));
    const columns: BoardColumn[] = cols.map((c) => ({
      name: c.name,
      states: [...new Set(Object.values(c.stateMappings ?? {}))],
      category: c.columnType ?? "",
      isDone: c.columnType === "outgoing",
      ...(c.itemLimit ? { wipLimit: c.itemLimit } : {}),
      items: [],
    }));
    for (const f of fields) {
      const row = rowOf(s, f, m, cat);
      if (row.stateCategory === "Removed") continue;
      // the item's own board column first (several columns can share a state), else the first column of its state
      const own = def.columnField ? String(f[def.columnField] ?? "") : "";
      let col = own ? cols.findIndex((c) => c.name.toLowerCase() === own.toLowerCase()) : -1;
      if (col < 0) col = cols.findIndex((c) => Object.entries(c.stateMappings ?? {}).some(([t, st]) => t.toLowerCase() === row.type.toLowerCase() && st.toLowerCase() === row.state.toLowerCase()));
      if (col >= 0) columns[col].items.push(row);
    }
    return { board: def.name, columnField: def.columnField, columns };
  });
  const local = localIndex(s);
  return {
    board: r.data.board,
    project: s.project,
    team: s.team,
    ...(r.data.columnField ? { columnField: r.data.columnField } : {}),
    columns: r.data.columns.map((c) => ({ ...c, items: c.items.map((x) => ({ ...x, local: local(x.id) })) })),
    readAt: r.meta.readAt,
    cached: r.meta.cached,
  };
}

// ---- one work item ---------------------------------------------------------------------------------------------------

interface Relation {
  rel: string;
  url: string;
  attributes?: Record<string, unknown>;
}

export interface LinkedItem {
  id: number;
  type: string;
  title: string;
  state: string;
  url: string;
}

export interface TaskRow {
  id: number;
  rev: number;
  title: string;
  state: string;
  done: boolean;
  assignedTo: Person | null;
}

export interface Item extends ItemRow {
  allowedStates: TypeState[];
  severityValues?: string[];
  priorityValues?: string[];
  sections: ItemSection[];
  systemInfo?: { markdown: string; html: string };
  tasks: TaskRow[];
  parentItem: LinkedItem | null;
  related: LinkedItem[];
  children: LinkedItem[];
  development: {
    branches: { repo: string; branch: string; url: string }[];
    prs: { repo: string; id: number; title: string; status: string; isDraft: boolean; url: string }[];
    builds: { id: number; repo?: string; pipeline: string; number: string; status: string; result: string; url: string }[];
  };
  comments: { id: number; author: Person; date: string; markdown: string; html: string }[];
  template: string;
  readAt: string;
  cached: boolean;
}

const idOfUrl = (u: string) => Number(/(\d+)$/.exec(u)?.[1] ?? 0);

/** id -> name of the repositories of the project (kept 4 hours). */
export async function repoNames(s: Stories): Promise<Record<string, string>> {
  return (
    await readStable(s, "repos", STORY_TTL.settings, async () => {
      const list = await s.c.list<{ id: string; name: string }>("git/repositories");
      return Object.fromEntries(list.map((r) => [r.id.toLowerCase(), r.name]));
    })
  ).data;
}

export function artifactLinks(rels: Relation[]): { branches: { repoId: string; branch: string }[]; prs: { repoId: string; id: number }[]; builds: number[] } {
  const out = { branches: [] as { repoId: string; branch: string }[], prs: [] as { repoId: string; id: number }[], builds: [] as number[] };
  for (const r of rels) {
    if (r.rel !== "ArtifactLink") continue;
    const u = decodeURIComponent(r.url);
    let m: RegExpExecArray | null;
    if ((m = /^vstfs:\/\/\/Git\/Ref\/[^/]+\/([^/]+)\/GB(.+)$/i.exec(u))) out.branches.push({ repoId: m[1].toLowerCase(), branch: m[2] });
    else if ((m = /^vstfs:\/\/\/Git\/PullRequestId\/[^/]+\/([^/]+)\/(\d+)$/i.exec(u))) out.prs.push({ repoId: m[1].toLowerCase(), id: Number(m[2]) });
    else if ((m = /^vstfs:\/\/\/Build\/Build\/(\d+)$/i.exec(u))) out.builds.push(Number(m[1]));
  }
  return out;
}

export async function storyShow(s: Stories, id: number): Promise<Item> {
  const m = await me(s);
  const r = await read(s, `item|${id}`, STORY_TTL.item, () => readItem(s, id, m));
  return { ...r.data, local: localIndex(s)(id), readAt: r.meta.readAt, cached: r.meta.cached };
}

type ItemCore = Omit<Item, "readAt" | "cached">;

export async function readItem(s: Stories, id: number, m: MeInfo): Promise<ItemCore> {
  const w = await s.c.get<{ id: number; rev: number; fields: Record<string, any>; relations?: Relation[] }>(`wit/workitems/${id}`, { $expand: "relations" });
  const fields: Record<string, any> = { ...w.fields, [F.id]: w.id ?? id, [F.rev]: w.rev ?? w.fields[F.rev] };
  const type = String(fields[F.type] ?? "");
  const states = await statesOf(s, type).catch(() => [] as TypeState[]);
  const cat = (_t: string, st: string): StateCategory => states.find((x) => x.name.toLowerCase() === st.toLowerCase())?.category ?? "";
  const row = rowOf(s, fields, m, cat);
  const tf = await typeFieldsOf(s, type).catch(() => ({ fields: undefined as string[] | undefined, allowed: {} as Record<string, string[]> }));
  const sec = await sectionsOf(s, type, fields, tf.fields);
  const rels = w.relations ?? [];
  const parentId = rels.filter((x) => x.rel === "System.LinkTypes.Hierarchy-Reverse").map((x) => idOfUrl(x.url))[0];
  const childIds = rels.filter((x) => x.rel === "System.LinkTypes.Hierarchy-Forward").map((x) => idOfUrl(x.url));
  const relatedIds = rels.filter((x) => x.rel === "System.LinkTypes.Related").map((x) => idOfUrl(x.url));
  const linkedIds = [...new Set([...(parentId ? [parentId] : []), ...childIds, ...relatedIds])].filter(Boolean);
  const linked = linkedIds.length ? await fetchFields(s, linkedIds, [F.id, F.rev, F.type, F.title, F.state, F.assignedTo]) : [];
  const byId = new Map(linked.map((f) => [Number(f[F.id]), f]));
  const asLinked = (i: number): LinkedItem | undefined => {
    const f = byId.get(i);
    return f ? { id: i, type: String(f[F.type] ?? ""), title: String(f[F.title] ?? ""), state: String(f[F.state] ?? ""), url: s.c.workItemUrl(i) } : undefined;
  };
  const taskType = /^task$/i;
  const taskStates = childIds.some((c) => taskType.test(String(byId.get(c)?.[F.type] ?? ""))) ? await statesOf(s, "Task").catch(() => [] as TypeState[]) : [];
  const tasks: TaskRow[] = childIds
    .map((c) => byId.get(c))
    .filter((f): f is Record<string, any> => !!f && taskType.test(String(f[F.type] ?? "")))
    .map((f) => {
      const st = String(f[F.state] ?? "");
      const c = taskStates.find((x) => x.name.toLowerCase() === st.toLowerCase())?.category;
      return { id: Number(f[F.id]), rev: Number(f[F.rev] ?? 0), title: String(f[F.title] ?? ""), state: st, done: c === "Completed" || c === "Removed", assignedTo: personOrNullOf(f[F.assignedTo], m) };
    });
  const children = childIds.filter((c) => !taskType.test(String(byId.get(c)?.[F.type] ?? ""))).map(asLinked).filter((x): x is LinkedItem => !!x);
  const development = await developmentOf(s, rels);
  const comments = await commentsOf(s, id, m).catch(() => [] as Item["comments"]);
  const sysInfo = tf.fields?.some((f) => f.toLowerCase() === F.systemInfo.toLowerCase()) || fields[F.systemInfo] !== undefined;
  return {
    ...row,
    allowedStates: states,
    ...(tf.allowed[F.severity] ? { severityValues: tf.allowed[F.severity] } : {}),
    ...(tf.allowed[F.priority] ? { priorityValues: tf.allowed[F.priority] } : {}),
    sections: sec.sections,
    ...(sysInfo ? { systemInfo: { markdown: htmlToMd(String(fields[F.systemInfo] ?? "")), html: String(fields[F.systemInfo] ?? "") } } : {}),
    tasks,
    parentItem: parentId ? asLinked(parentId) ?? null : null,
    related: relatedIds.map(asLinked).filter((x): x is LinkedItem => !!x),
    children,
    development,
    comments,
    template: sec.template,
  };
}

const personOrNullOf = (v: unknown, m: MeInfo): Person | null => (v ? personOf(typeof v === "string" ? { displayName: v } : (v as { displayName?: string }), m) : null);

async function developmentOf(s: Stories, rels: Relation[]): Promise<Item["development"]> {
  const links = artifactLinks(rels);
  const names = links.branches.length || links.prs.length ? await repoNames(s).catch(() => ({}) as Record<string, string>) : {};
  const repo = (rid: string) => names[rid] ?? rid;
  const web = (rid: string) => `${s.c.remote.orgUrl}/${encodeURIComponent(s.project)}/_git/${encodeURIComponent(repo(rid))}`;
  const branches = links.branches.map((b) => ({ repo: repo(b.repoId), branch: b.branch, url: `${web(b.repoId)}?version=GB${encodeURIComponent(b.branch)}` }));
  const prs = (
    await pool(links.prs, 4, async (p) => {
      try {
        const pr = await s.c.get<{ pullRequestId: number; title: string; status: string; isDraft?: boolean; repository?: { name?: string } }>(`git/pullrequests/${p.id}`);
        return { repo: pr.repository?.name ?? repo(p.repoId), id: p.id, title: pr.title, status: pr.status, isDraft: !!pr.isDraft, url: `${web(p.repoId)}/pullrequest/${p.id}` };
      } catch {
        return { repo: repo(p.repoId), id: p.id, title: "", status: "unknown", isDraft: false, url: `${web(p.repoId)}/pullrequest/${p.id}` };
      }
    })
  ).filter(Boolean);
  let builds: Item["development"]["builds"] = [];
  if (links.builds.length) {
    try {
      const r = await s.c.get<{ value?: { id: number; buildNumber?: string; status?: string; result?: string; definition?: { name?: string }; repository?: { name?: string }; _links?: { web?: { href?: string } } }[] }>("build/builds", { buildIds: links.builds.join(",") });
      builds = (r.value ?? []).map((b) => ({ id: b.id, ...(b.repository?.name ? { repo: b.repository.name } : {}), pipeline: b.definition?.name ?? "", number: b.buildNumber ?? "", status: b.status ?? "", result: b.result ?? "", url: b._links?.web?.href ?? `${s.c.remote.orgUrl}/${encodeURIComponent(s.project)}/_build/results?buildId=${b.id}` }));
    } catch {
      builds = links.builds.map((id) => ({ id, pipeline: "", number: "", status: "unknown", result: "", url: `${s.c.remote.orgUrl}/${encodeURIComponent(s.project)}/_build/results?buildId=${id}` }));
    }
  }
  return { branches, prs, builds };
}

export const COMMENTS_API = "7.1-preview.4";

export async function commentsOf(s: Stories, id: number, m: MeInfo): Promise<Item["comments"]> {
  const r = await s.c.get<{ comments?: { id: number; text?: string; createdBy?: { displayName?: string; uniqueName?: string; id?: string }; createdDate?: string; isDeleted?: boolean }[] }>(`wit/workItems/${id}/comments`, { "api-version": COMMENTS_API, $top: 200, order: "asc" });
  return (r.comments ?? [])
    .filter((c) => !c.isDeleted)
    .map((c) => ({ id: c.id, author: personOf(c.createdBy, m), date: c.createdDate ?? "", markdown: htmlToMd(c.text ?? ""), html: c.text ?? "" }));
}

export { mdToHtml };
