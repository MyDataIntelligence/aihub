import { readFileSync } from "node:fs";
import { trace } from "./trace.js";
import type { AdoClient } from "./ado.js";
import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { cut, day, emit, encode, table, top, type Flags } from "./devops.js";
import { fetchItems, itemLine } from "./workitemAdmin.js";

/** The team whose iterations, boards and backlogs are read: --team, or the project's default team. */
export function teamClient(c: AdoClient, v: Flags): AdoClient {
  return c.forTeam(typeof v.team === "string" && v.team ? v.team : `${c.remote.project} Team`);
}

// ---- queries -------------------------------------------------------------------------------------------

async function runWiql(c: AdoClient, wiql: string, limit: number): Promise<number[]> {
  const r = await c.request<{ workItems?: { id: number }[]; workItemRelations?: { target?: { id: number } }[] }>("POST", "wit/wiql", { body: { query: wiql }, query: { $top: limit, "api-version": "7.1" } });
  const ids = r.data.workItems?.map((x) => x.id) ?? (r.data.workItemRelations ?? []).map((x) => x.target?.id).filter((x): x is number => !!x);
  return [...new Set(ids)];
}

const MINE = "SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.State] NOT IN ('Done','Closed','Removed','Resolved') AND [System.TeamProject] = @Project ORDER BY [System.ChangedDate] DESC";

async function savedQuery(c: AdoClient, ref: string): Promise<{ id: string; name: string; wiql?: string; path?: string }> {
  const path = /^[0-9a-f-]{36}$/i.test(ref) ? ref : ref.includes("/") ? ref : `Shared Queries/${ref}`;
  try {
    return await c.get(`wit/queries/${encode(path).replace(/%2F/g, "/")}`, { $expand: "wiql" });
  } catch (e) {
    if (e instanceof AihubError && /\(404\)/.test(e.message) && !ref.includes("/")) return c.get(`wit/queries/${encode(`My Queries/${ref}`).replace(/%2F/g, "/")}`, { $expand: "wiql" });
    throw e;
  }
}

export async function queryRun(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  let wiql = typeof v.wiql === "string" ? v.wiql : "";
  if (typeof v["query-file"] === "string") {
    try {
      wiql = readFileSync(v["query-file"], "utf8");
    } catch (e) {
      throw new AihubError(`cannot read ${v["query-file"]}: ${(e as Error).message}`);
    }
  }
  if (typeof v.saved === "string") wiql = (await savedQuery(c, v.saved)).wiql ?? "";
  if (v.mine) wiql = MINE;
  if (!wiql.trim()) throw new AihubError("give --wiql \"<query>\", --query-file <file>, --saved <name> or --mine");
  if (!/^\s*select\b/i.test(wiql)) throw new AihubError("a WIQL query starts with SELECT");
  const ids = (await runWiql(c, wiql, top(v, 100))).slice(0, top(v, 100));
  const items = ids.length ? await fetchItems(c, ids) : [];
  const order = new Map(ids.map((id, i) => [id, i]));
  items.sort((a, b) => (order.get(Number(a["System.Id"])) ?? 0) - (order.get(Number(b["System.Id"])) ?? 0));
  emit(ctx, v, items.map((f) => ({ id: f["System.Id"], type: f["System.WorkItemType"], state: f["System.State"], title: f["System.Title"], assignedTo: f["System.AssignedTo"]?.displayName, iteration: f["System.IterationPath"] })), items.length ? [`${ids.length} work item(s)`, ...items.map(itemLine)].join("\n") : "the query returns no work items");
}

interface QueryNode {
  id: string;
  name: string;
  path?: string;
  isFolder?: boolean;
  children?: QueryNode[];
}

export async function queryList(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const r = await c.get<{ value?: QueryNode[] }>("wit/queries", { $depth: 2, $expand: "none" });
  const lines: string[] = [];
  const flat: { path?: string; id: string }[] = [];
  const walk = (n: QueryNode, depth: number) => {
    if (!n.isFolder) flat.push({ path: n.path, id: n.id });
    lines.push(`${"  ".repeat(depth)}${n.name}${n.isFolder ? "/" : ""}`);
    (n.children ?? []).forEach((k) => walk(k, depth + 1));
  };
  (r.value ?? []).forEach((n) => walk(n, 0));
  emit(ctx, v, flat, lines.join("\n") || "no queries");
}

export async function queryShow(c: AdoClient, ctx: Ctx, v: Flags, ref: string): Promise<void> {
  const q = await savedQuery(c, ref);
  emit(ctx, v, q, `${q.path ?? q.name}\n${q.wiql ?? "(folder)"}`);
}

export async function queryCreate(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const name = typeof v.name === "string" ? v.name : "";
  const wiql = typeof v["query-file"] === "string" ? readFileSync(v["query-file"], "utf8") : typeof v.wiql === "string" ? v.wiql : "";
  if (!name || !wiql) throw new AihubError("aihub boards query create needs --name and --wiql \"...\" (or --query-file)");
  const folder = typeof v.folder === "string" ? v.folder : "Shared Queries";
  const made = await c.post<{ id?: string }>(`wit/queries/${encode(folder).replace(/%2F/g, "/")}`, { name, wiql });
  emit(ctx, v, { name, folder, id: made.id }, `${trace.dryRun ? "dry-run: would create" : "created"} query ${folder}/${name}`);
}

export async function queryDelete(c: AdoClient, ctx: Ctx, v: Flags, ref: string): Promise<void> {
  const q = await savedQuery(c, ref);
  if (!q.id) throw new AihubError(`query '${ref}' not found`);
  if (!v.yes && !trace.dryRun) throw new AihubError(`deleting query '${q.path ?? q.name}' needs --yes (or --dry-run to see the call first)`);
  await c.del(`wit/queries/${q.id}`);
  emit(ctx, v, { query: q.path ?? q.name, deleted: !trace.dryRun }, `${trace.dryRun ? "dry-run: would delete" : "deleted"} query ${q.path ?? q.name}`);
}

// ---- sprints and capacity ------------------------------------------------------------------------------------

interface Iteration {
  id: string;
  name: string;
  path: string;
  attributes?: { startDate?: string; finishDate?: string; timeFrame?: string };
}

async function iterations(t: AdoClient, timeframe?: string): Promise<Iteration[]> {
  return t.list<Iteration>("work/teamsettings/iterations", timeframe ? { $timeframe: timeframe } : {});
}

async function pickIteration(t: AdoClient, v: Flags): Promise<Iteration> {
  const all = await iterations(t);
  const ref = typeof v.sprint === "string" ? v.sprint : "";
  const hit = ref ? all.find((i) => i.name.toLowerCase() === ref.toLowerCase() || i.id === ref) : all.find((i) => i.attributes?.timeFrame === "current");
  if (!hit) throw new AihubError(ref ? `sprint '${ref}' not found; see: aihub boards sprint list` : "this team has no current sprint; give --sprint <name>");
  return hit;
}

export async function sprintList(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const all = await iterations(teamClient(c, v));
  const rows = all.map((i) => ({ id: i.id, name: i.name, path: i.path, start: day(i.attributes?.startDate), finish: day(i.attributes?.finishDate), timeFrame: i.attributes?.timeFrame }));
  emit(ctx, v, rows, rows.length ? table([["sprint", "start", "finish", ""], ...rows.map((r) => [r.name, r.start, r.finish, r.timeFrame === "current" ? "current" : r.timeFrame ?? ""])]) : "this team has no sprints");
}

export async function sprintItems(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const t = teamClient(c, v);
  const it = await pickIteration(t, v);
  const r = await t.get<{ workItemRelations?: { target?: { id: number } }[] }>(`work/teamsettings/iterations/${it.id}/workitems`);
  const ids = [...new Set((r.workItemRelations ?? []).map((x) => x.target?.id).filter((x): x is number => !!x))];
  const items = ids.length ? await fetchItems(c, ids.slice(0, top(v, 200))) : [];
  emit(ctx, v, { sprint: it.name, items: items.map((f) => ({ id: f["System.Id"], type: f["System.WorkItemType"], state: f["System.State"], title: f["System.Title"] })) }, items.length ? [`${it.name}: ${ids.length} work item(s)`, ...items.map(itemLine)].join("\n") : `${it.name} has no work items`);
}

interface Capacity {
  teamMember?: { id?: string; displayName?: string };
  activities?: { capacityPerDay?: number; name?: string }[];
  daysOff?: { start?: string; end?: string }[];
}

export async function capacityShow(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const t = teamClient(c, v);
  const it = await pickIteration(t, v);
  const r = await t.get<{ teamMembers?: Capacity[]; totalCapacityPerDay?: number; totalDaysOff?: number }>(`work/teamsettings/iterations/${it.id}/capacities`);
  const rows = (r.teamMembers ?? []).map((m) => ({ id: m.teamMember?.id, name: m.teamMember?.displayName, perDay: (m.activities ?? []).reduce((a, x) => a + (x.capacityPerDay ?? 0), 0), daysOff: (m.daysOff ?? []).length }));
  emit(ctx, v, { sprint: it.name, totalCapacityPerDay: r.totalCapacityPerDay, members: rows }, rows.length ? [`${it.name}: ${r.totalCapacityPerDay ?? 0} h/day in total`, ...rows.map((m) => `  ${String(m.name).padEnd(24)} ${m.perDay} h/day${m.daysOff ? `, ${m.daysOff} day-off range(s)` : ""}`)].join("\n") : `${it.name} has no capacity set`);
}

export async function capacitySet(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const t = teamClient(c, v);
  const it = await pickIteration(t, v);
  const member = typeof v.member === "string" ? v.member : "";
  const perDay = Number(v["per-day"]);
  if (!member || !Number.isFinite(perDay) || perDay < 0) throw new AihubError("capacity set needs --member <name|id> and --per-day <hours>");
  const cur = await t.get<{ teamMembers?: Capacity[] }>(`work/teamsettings/iterations/${it.id}/capacities`);
  const m = (cur.teamMembers ?? []).find((x) => x.teamMember?.id === member || x.teamMember?.displayName?.toLowerCase() === member.toLowerCase());
  if (!m?.teamMember?.id) throw new AihubError(`'${member}' is not in the capacity list of ${it.name}; members: ${(cur.teamMembers ?? []).map((x) => x.teamMember?.displayName).join(", ")}`);
  await t.patch(`work/teamsettings/iterations/${it.id}/capacities/${m.teamMember.id}`, { activities: [{ capacityPerDay: perDay, name: typeof v.activity === "string" ? v.activity : m.activities?.[0]?.name ?? "Development" }], daysOff: m.daysOff ?? [] });
  emit(ctx, v, { member: m.teamMember.displayName, perDay }, `${trace.dryRun ? "dry-run: would set" : "set"} ${m.teamMember.displayName} to ${perDay} h/day in ${it.name}`);
}

// ---- classification nodes (areas, iterations) -----------------------------------------------------------------------

interface Node {
  id?: number;
  name: string;
  path?: string;
  attributes?: { startDate?: string; finishDate?: string };
  children?: Node[];
}

export async function nodesList(c: AdoClient, ctx: Ctx, v: Flags, kind: "areas" | "iterations"): Promise<void> {
  const r = await c.get<Node>(`wit/classificationnodes/${kind}`, { $depth: 4 });
  const lines: string[] = [];
  const walk = (n: Node, depth: number) => {
    lines.push(`${"  ".repeat(depth)}${n.name}${kind === "iterations" && n.attributes?.startDate ? `  ${day(n.attributes.startDate)} .. ${day(n.attributes.finishDate)}` : ""}`);
    (n.children ?? []).forEach((k) => walk(k, depth + 1));
  };
  walk(r, 0);
  emit(ctx, v, r, lines.join("\n"));
}

export async function nodesCreate(c: AdoClient, ctx: Ctx, v: Flags, kind: "areas" | "iterations"): Promise<void> {
  const name = typeof v.name === "string" ? v.name : "";
  if (!name) throw new AihubError(`--name is required (and --parent <path under the root> for a nested ${kind === "areas" ? "area" : "iteration"})`);
  const parent = typeof v.parent === "string" ? `/${v.parent.replace(/^\/+|\/+$/g, "")}` : "";
  const body: any = { name };
  if (kind === "iterations") {
    if (typeof v.start === "string") body.attributes = { startDate: v.start, finishDate: typeof v.finish === "string" ? v.finish : v.start };
  }
  await c.post(`wit/classificationnodes/${kind}${parent.split("/").map((s) => (s ? `/${encode(s)}` : "")).join("")}`, body);
  emit(ctx, v, { kind, name, parent: v.parent }, `${trace.dryRun ? "dry-run: would create" : "created"} ${kind === "areas" ? "area" : "iteration"} ${v.parent ? `${v.parent}/` : ""}${name}`);
}

// ---- board, backlog, tags -------------------------------------------------------------------------------------------

export async function boardShow(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const t = teamClient(c, v);
  const boards = await t.list<{ id: string; name: string }>("work/boards");
  if (typeof v.board !== "string") return emit(ctx, v, boards, boards.length ? boards.map((b) => b.name).join("\n") : "no boards");
  const b = boards.find((x) => x.name.toLowerCase() === String(v.board).toLowerCase());
  if (!b) throw new AihubError(`board '${v.board}' not found; boards: ${boards.map((x) => x.name).join(", ")}`);
  const full = await t.get<{ columns?: { name: string; itemLimit?: number; stateMappings?: Record<string, string>; columnType?: string }[]; rows?: { name?: string }[] }>(`work/boards/${b.id}`);
  const cols = (full.columns ?? []).map((x) => ({ name: x.name, limit: x.itemLimit, states: Object.values(x.stateMappings ?? {}).join("/") }));
  emit(ctx, v, { board: b.name, columns: cols, swimlanes: (full.rows ?? []).map((r) => r.name || "(default)") }, [`${b.name}`, ...cols.map((x) => `  ${x.name}${x.limit ? ` (WIP ${x.limit})` : ""}${x.states ? ` [${x.states}]` : ""}`), `  swimlanes ${(full.rows ?? []).map((r) => r.name || "(default)").join(", ")}`].join("\n"));
}

export async function backlog(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const t = teamClient(c, v);
  const levels = await t.list<{ id: string; name: string; workItemTypes?: { name: string }[] }>("work/backlogs");
  if (typeof v.level !== "string") return emit(ctx, v, levels, levels.map((l) => `${l.name}: ${(l.workItemTypes ?? []).map((w) => w.name).join(", ")}`).join("\n"));
  const lv = levels.find((l) => l.name.toLowerCase() === String(v.level).toLowerCase() || l.id === v.level);
  if (!lv) throw new AihubError(`backlog level '${v.level}' not found; levels: ${levels.map((l) => l.name).join(", ")}`);
  const r = await t.get<{ workItems?: { target?: { id: number } }[] }>(`work/backlogs/${encode(lv.id)}/workItems`);
  const ids = (r.workItems ?? []).map((x) => x.target?.id).filter((x): x is number => !!x).slice(0, top(v, 100));
  const items = ids.length ? await fetchItems(c, ids) : [];
  emit(ctx, v, { level: lv.name, items: items.map((f) => ({ id: f["System.Id"], state: f["System.State"], title: f["System.Title"] })) }, items.length ? [`${lv.name}: ${ids.length} item(s)`, ...items.map(itemLine)].join("\n") : `${lv.name} backlog is empty`);
}

export async function tagList(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const r = await c.get<{ value?: { name: string }[] }>("wit/tags", { "api-version": "7.1-preview.1" });
  const f = typeof v.filter === "string" ? v.filter.toLowerCase() : "";
  const names = (r.value ?? []).map((t) => t.name).filter((n) => !f || n.toLowerCase().includes(f));
  emit(ctx, v, names, names.length ? cut(names.join(", "), 4000) : "no tags");
}
