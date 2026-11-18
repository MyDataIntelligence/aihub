import type { AdoClient } from "./ado.js";
import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { cut, emit, table, top, type Flags } from "./devops.js";

/** Azure DevOps search lives on almsearch.dev.azure.com; the queries are POSTs that only read. */
async function search(c: AdoClient, kind: "code" | "wiki" | "workitem", body: object): Promise<any> {
  return c.forService("almsearch").post<any>(`search/${kind}searchresults`, body, { "api-version": "7.1" });
}

function textOf(v: Flags): string {
  const t = typeof v.text === "string" ? v.text.trim() : "";
  if (!t) throw new AihubError("--text <search text> is required");
  return t;
}

export async function searchCode(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const filters: Record<string, string[]> = { Project: [c.remote.project] };
  if (v["all-repos"] !== true) filters.Repository = [typeof v.repo === "string" ? v.repo : c.remote.repo];
  if (typeof v.path === "string") filters.Path = v.path.split(",");
  if (typeof v.branch === "string") filters.Branch = v.branch.split(",");
  const r = await search(c, "code", { searchText: textOf(v), $skip: 0, $top: top(v, 25), filters, includeFacets: false });
  const rows = (r.results ?? []).map((x: any) => ({ repository: x.repository?.name, path: x.path, file: x.fileName, matches: Object.values(x.matches ?? {}).flat().length, branch: x.versions?.[0]?.branchName }));
  emit(ctx, v, { count: r.count ?? rows.length, results: rows }, rows.length ? [`${r.count ?? rows.length} file(s) match`, ...rows.map((x: any) => `${x.repository}${x.path} (${x.matches} match${x.matches === 1 ? "" : "es"})`)].join("\n") : "no code matches");
}

export async function searchWiki(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const r = await search(c, "wiki", { searchText: textOf(v), $skip: 0, $top: top(v, 25), filters: { Project: [c.remote.project] }, includeFacets: false });
  const rows = (r.results ?? []).map((x: any) => ({ wiki: x.wiki?.name, path: x.path, file: x.fileName, hits: (x.hits ?? []).flatMap((h: any) => h.highlights ?? []).length }));
  emit(ctx, v, { count: r.count ?? rows.length, results: rows }, rows.length ? [`${r.count ?? rows.length} wiki page(s) match`, ...rows.map((x: any) => `${x.wiki}: ${x.path}`)].join("\n") : "no wiki pages match");
}

export async function searchItems(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const filters: Record<string, string[]> = { "System.TeamProject": [c.remote.project] };
  if (typeof v.type === "string") filters["System.WorkItemType"] = v.type.split(",");
  if (typeof v.state === "string") filters["System.State"] = v.state.split(",");
  const r = await search(c, "workitem", { searchText: textOf(v), $skip: 0, $top: top(v, 25), filters, includeFacets: false });
  const rows = (r.results ?? []).map((x: any) => ({ id: Number(x.fields?.["system.id"]), type: x.fields?.["system.workitemtype"], state: x.fields?.["system.state"], title: x.fields?.["system.title"] }));
  emit(ctx, v, { count: r.count ?? rows.length, results: rows }, rows.length ? table([["id", "type", "state", "title"], ...rows.map((x: any) => [String(x.id), x.type ?? "", x.state ?? "", cut(x.title, 70)])]) : "no work items match");
}
