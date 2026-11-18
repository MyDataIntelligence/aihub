import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { trace } from "./trace.js";
import type { AdoClient } from "./ado.js";
import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { confirmDelete, cut, day, emit, encode, table, top, type Flags } from "./devops.js";

/** Short field names accepted by `workitem update --field name=value`. */
export const FIELD_ALIASES: Record<string, string> = {
  title: "System.Title",
  state: "System.State",
  reason: "System.Reason",
  "assigned-to": "System.AssignedTo",
  assignee: "System.AssignedTo",
  area: "System.AreaPath",
  iteration: "System.IterationPath",
  tags: "System.Tags",
  description: "System.Description",
  priority: "Microsoft.VSTS.Common.Priority",
  severity: "Microsoft.VSTS.Common.Severity",
  "story-points": "Microsoft.VSTS.Scheduling.StoryPoints",
  effort: "Microsoft.VSTS.Scheduling.Effort",
  "remaining-work": "Microsoft.VSTS.Scheduling.RemainingWork",
  "original-estimate": "Microsoft.VSTS.Scheduling.OriginalEstimate",
  acceptance: "Microsoft.VSTS.Common.AcceptanceCriteria",
  "repro-steps": "Microsoft.VSTS.TCM.ReproSteps",
};

const LINKS: Record<string, string> = {
  parent: "System.LinkTypes.Hierarchy-Reverse",
  child: "System.LinkTypes.Hierarchy-Forward",
  related: "System.LinkTypes.Related",
  predecessor: "System.LinkTypes.Dependency-Reverse",
  successor: "System.LinkTypes.Dependency-Forward",
  duplicate: "System.LinkTypes.Duplicate-Forward",
  "duplicate-of": "System.LinkTypes.Duplicate-Reverse",
  "tested-by": "Microsoft.VSTS.Common.TestedBy-Forward",
  tests: "Microsoft.VSTS.Common.TestedBy-Reverse",
};
const LINK_NAME = (rel: string) => Object.entries(LINKS).find(([, r]) => r === rel)?.[0] ?? rel;

const plain = (html: string | undefined) =>
  (html ?? "")
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const shown = (x: any): string => (x && typeof x === "object" ? who(x) || JSON.stringify(x) : String(x ?? ""));
const who = (x: any) => (typeof x === "string" ? x : x?.displayName ?? "");
const idOf = (url: string) => Number(/workItems\/(\d+)/i.exec(url)?.[1] ?? NaN);

interface Wi {
  id: number;
  rev?: number;
  fields?: Record<string, any>;
  relations?: { rel: string; url: string; attributes?: Record<string, any> }[];
}

async function getFull(c: AdoClient, id: number): Promise<Wi> {
  return c.get<Wi>(`wit/workitems/${id}`, { $expand: "all" });
}

export function fieldRef(name: string): string {
  return FIELD_ALIASES[name.toLowerCase()] ?? name;
}

export async function itemGet(c: AdoClient, ctx: Ctx, v: Flags, id: number): Promise<void> {
  const w = await getFull(c, id);
  const f = w.fields ?? {};
  const rels = (w.relations ?? []).filter((r) => /WorkItems\/\d+/i.test(r.url) || /Hierarchy|Related|Dependency|Duplicate|TestedBy/.test(r.rel));
  const links = rels.map((r) => ({ type: LINK_NAME(r.rel), id: idOf(r.url) }));
  const prs = (w.relations ?? []).filter((r) => r.rel === "ArtifactLink" && /PullRequestId/.test(decodeURIComponent(r.url))).map((r) => Number(decodeURIComponent(r.url).split("/").pop()));
  const attachments = (w.relations ?? []).filter((r) => r.rel === "AttachedFile").map((r) => r.attributes?.name);
  const data = {
    id,
    type: f["System.WorkItemType"],
    state: f["System.State"],
    title: f["System.Title"],
    assignedTo: who(f["System.AssignedTo"]),
    area: f["System.AreaPath"],
    iteration: f["System.IterationPath"],
    tags: f["System.Tags"] ?? "",
    priority: f["Microsoft.VSTS.Common.Priority"],
    description: plain(f["System.Description"]),
    acceptance: plain(f["Microsoft.VSTS.Common.AcceptanceCriteria"]),
    links,
    pullRequests: prs,
    attachments,
    url: c.workItemUrl(id),
  };
  const text = [
    `AB#${id} ${data.type} [${data.state}] ${data.title}`,
    `  assigned ${data.assignedTo || "-"}; area ${data.area}; iteration ${data.iteration}${data.tags ? `; tags ${data.tags}` : ""}`,
    ...(links.length ? [`  links ${links.map((l) => `${l.type} AB#${l.id}`).join(", ")}`] : []),
    ...(prs.length ? [`  pull requests ${prs.map((p) => `!${p}`).join(", ")}`] : []),
    ...(attachments.length ? [`  attachments ${attachments.join(", ")}`] : []),
    ...(data.description ? ["", cut(data.description, v.full ? 100000 : 600)] : []),
    ...(data.acceptance ? ["", "Acceptance:", cut(data.acceptance, v.full ? 100000 : 600)] : []),
  ].join("\n");
  emit(ctx, v, data, text);
}

export async function itemUpdate(c: AdoClient, ctx: Ctx, v: Flags, id: number, fields: string[]): Promise<void> {
  const ops: any[] = [];
  for (const f of fields) {
    const i = f.indexOf("=");
    if (i < 1) throw new AihubError(`--field takes name=value, got '${f}'`);
    const name = fieldRef(f.slice(0, i).trim());
    let value: string = f.slice(i + 1);
    if (value.startsWith("@")) {
      try {
        value = readFileSync(value.slice(1), "utf8");
      } catch (e) {
        throw new AihubError(`cannot read ${value.slice(1)}: ${(e as Error).message}`);
      }
    }
    ops.push({ op: "add", path: `/fields/${name}`, value });
  }
  if (!ops.length) throw new AihubError("give at least one --field name=value (names: " + Object.keys(FIELD_ALIASES).join(", ") + ", or a full reference name; value @file reads a file)");
  await c.jsonPatch("PATCH", `wit/workitems/${id}`, ops);
  emit(ctx, v, { id, changed: ops.map((o) => o.path.replace("/fields/", "")) }, `${trace.dryRun ? "dry-run: would update" : "updated"} AB#${id}: ${ops.map((o) => o.path.replace("/fields/", "")).join(", ")}`);
}

export async function itemDelete(c: AdoClient, ctx: Ctx, v: Flags, id: number): Promise<void> {
  confirmDelete(v, `work item ${id} (it goes to the recycle bin)`);
  await c.del(`wit/workitems/${id}`);
  emit(ctx, v, { id, deleted: !trace.dryRun }, `${trace.dryRun ? "dry-run: would move" : "moved"} AB#${id} to the recycle bin (restore: aihub workitem restore --id ${id})`);
}

export async function itemRestore(c: AdoClient, ctx: Ctx, v: Flags, id: number): Promise<void> {
  await c.patch(`wit/recyclebin/${id}`, { IsDeleted: false }, { "api-version": "7.1-preview.2" });
  emit(ctx, v, { id, restored: !trace.dryRun }, `${trace.dryRun ? "dry-run: would restore" : "restored"} AB#${id}`);
}

const COMMENTS = { "api-version": "7.1-preview.4" };

export async function commentAdd(c: AdoClient, ctx: Ctx, v: Flags, id: number): Promise<void> {
  const text = typeof v["text-file"] === "string" ? readFileSync(v["text-file"], "utf8") : typeof v.text === "string" ? v.text : "";
  if (!text.trim()) throw new AihubError("--text <comment> or --text-file <file> is required");
  await c.post(`wit/workItems/${id}/comments`, { text }, COMMENTS);
  emit(ctx, v, { id, commented: !trace.dryRun }, `${trace.dryRun ? "dry-run: would comment on" : "commented on"} AB#${id} (${text.length} chars)`);
}

export async function commentsList(c: AdoClient, ctx: Ctx, v: Flags, id: number): Promise<void> {
  const r = await c.get<{ comments?: { id: number; text: string; createdBy?: { displayName?: string }; createdDate?: string }[] }>(`wit/workItems/${id}/comments`, { ...COMMENTS, $top: top(v, 50) });
  const rows = (r.comments ?? []).map((x) => ({ id: x.id, by: x.createdBy?.displayName, date: day(x.createdDate), text: plain(x.text) }));
  emit(ctx, v, rows, rows.length ? rows.map((x) => `#${x.id} ${x.date} ${x.by}: ${cut(x.text, 300)}`).join("\n") : `AB#${id} has no comments`);
}

export async function history(c: AdoClient, ctx: Ctx, v: Flags, id: number): Promise<void> {
  const r = await c.get<{ value?: { rev: number; revisedBy?: { displayName?: string }; revisedDate?: string; fields?: Record<string, { oldValue?: any; newValue?: any }> }[] }>(`wit/workItems/${id}/updates`, { $top: top(v, 50) });
  const noise = /^System\.(Rev|AuthorizedDate|RevisedDate|ChangedDate|Watermark|AuthorizedAs|PersonId|ChangedBy|CommentCount|Id|AreaId|IterationId|NodeName|AreaLevel\d|IterationLevel\d|CreatedDate|CreatedBy|IsDeleted|TeamProject|StateChangeDate|Reason)$/;
  const rows = (r.value ?? [])
    .map((u) => ({
      rev: u.rev,
      by: u.revisedBy?.displayName,
      date: day(u.revisedDate),
      changes: Object.entries(u.fields ?? {})
        .filter(([k]) => !noise.test(k))
        .map(([k, x]) => `${k.replace(/^.*\./, "")}: ${cut(shown(x.oldValue), 30)} -> ${cut(shown(x.newValue), 40)}`),
    }))
    .filter((x) => x.changes.length > 0);
  const text = rows.map((x) => `r${x.rev} ${x.date} ${x.by} | ${x.changes.slice(0, 6).join("; ")}${x.changes.length > 6 ? `; ... ${x.changes.length - 6} more` : ""}`);
  emit(ctx, v, rows, text.length ? text.join("\n") : `AB#${id} has no history`);
}

export async function link(c: AdoClient, ctx: Ctx, v: Flags, id: number, add: boolean): Promise<void> {
  const type = String(v.type ?? "related");
  const rel = LINKS[type];
  if (!rel) throw new AihubError(`--type must be one of ${Object.keys(LINKS).join(", ")}`);
  const to = Number(String(v.to ?? "").replace(/^AB#/i, ""));
  if (!Number.isInteger(to) || to <= 0) throw new AihubError("--to <work item number> is required");
  const url = `${c.remote.orgUrl}/_apis/wit/workItems/${to}`;
  if (add) {
    await c.jsonPatch("PATCH", `wit/workitems/${id}`, [{ op: "add", path: "/relations/-", value: { rel, url, attributes: { comment: typeof v.comment === "string" ? v.comment : "" } } }]);
  } else {
    const w = await c.get<Wi>(`wit/workitems/${id}`, { $expand: "relations" });
    const i = (w.relations ?? []).findIndex((r) => r.rel === rel && idOf(r.url) === to);
    if (i < 0) throw new AihubError(`AB#${id} has no ${type} link to AB#${to}`);
    await c.jsonPatch("PATCH", `wit/workitems/${id}`, [{ op: "remove", path: `/relations/${i}` }]);
  }
  emit(ctx, v, { id, type, to, linked: add }, `${trace.dryRun ? "dry-run: would " : ""}${add ? "link" : "unlink"} AB#${id} ${type} AB#${to}`);
}

export async function tags(c: AdoClient, ctx: Ctx, v: Flags, id: number, add: boolean): Promise<void> {
  const want = typeof v.tags === "string" ? v.tags.split(/[;,]/).map((s) => s.trim()).filter(Boolean) : [];
  if (!want.length) throw new AihubError("--tags <a,b> is required");
  const w = await c.get<Wi>(`wit/workitems/${id}`, { fields: "System.Tags" });
  const have = String(w.fields?.["System.Tags"] ?? "").split(";").map((s) => s.trim()).filter(Boolean);
  const next = add ? [...have, ...want.filter((t) => !have.some((h) => h.toLowerCase() === t.toLowerCase()))] : have.filter((h) => !want.some((t) => t.toLowerCase() === h.toLowerCase()));
  await c.jsonPatch("PATCH", `wit/workitems/${id}`, [{ op: "add", path: "/fields/System.Tags", value: next.join("; ") }]);
  emit(ctx, v, { id, tags: next }, `${trace.dryRun ? "dry-run: would set" : "set"} tags of AB#${id}: ${next.join(", ") || "(none)"}`);
}

export async function attach(c: AdoClient, ctx: Ctx, v: Flags, id: number): Promise<void> {
  if (typeof v.file !== "string") throw new AihubError("--file <path> is required");
  let bytes: Buffer;
  try {
    bytes = readFileSync(v.file);
  } catch (e) {
    throw new AihubError(`cannot read ${v.file}: ${(e as Error).message}`);
  }
  if (bytes.length > 60 * 1024 * 1024) throw new AihubError("an attachment may be at most 60 MB");
  const name = typeof v.name === "string" ? v.name : basename(v.file);
  const up = await c.sendBytes<{ url?: string }>("POST", "wit/attachments", new Uint8Array(bytes), { fileName: name });
  if (!trace.dryRun && !up.url) throw new AihubError("Azure DevOps did not return the attachment address");
  await c.jsonPatch("PATCH", `wit/workitems/${id}`, [{ op: "add", path: "/relations/-", value: { rel: "AttachedFile", url: up.url ?? "", attributes: { comment: typeof v.comment === "string" ? v.comment : "", name } } }]);
  emit(ctx, v, { id, name, bytes: bytes.length }, `${trace.dryRun ? "dry-run: would attach" : "attached"} ${name} (${bytes.length} bytes) to AB#${id}`);
}

export async function attachments(c: AdoClient, ctx: Ctx, v: Flags, id: number): Promise<void> {
  const w = await c.get<Wi>(`wit/workitems/${id}`, { $expand: "relations" });
  const list = (w.relations ?? []).filter((r) => r.rel === "AttachedFile").map((r) => ({ name: String(r.attributes?.name ?? ""), url: r.url, size: Number(r.attributes?.resourceSize ?? 0) }));
  if (typeof v.download === "string") {
    const a = list.find((x) => x.name === v.download);
    if (!a) throw new AihubError(`AB#${id} has no attachment '${v.download}'; it has: ${list.map((x) => x.name).join(", ") || "none"}`);
    if (trace.dryRun) return emit(ctx, v, { name: a.name }, `dry-run: would download ${a.name}`);
    const out = resolve(typeof v.out === "string" ? v.out : ".");
    mkdirSync(out, { recursive: true });
    const bytes = await c.fetchBytes(a.url);
    const file = join(out, a.name.replace(/[^\w.-]/g, "_"));
    writeFileSync(file, bytes);
    return emit(ctx, v, { name: a.name, file, bytes: bytes.length }, `downloaded ${a.name} (${bytes.length} bytes) to ${file}`);
  }
  emit(ctx, v, list, list.length ? table([["attachment", "size"], ...list.map((a) => [a.name, a.size ? `${Math.round(a.size / 1024)} KB` : ""])]) : `AB#${id} has no attachments`);
}

export async function types(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const r = await c.get<{ value?: { name: string; description?: string; states?: { name: string; category?: string }[] }[] }>("wit/workitemtypes");
  const rows = (r.value ?? []).map((t) => ({ name: t.name, states: (t.states ?? []).map((s) => s.name) }));
  emit(ctx, v, rows, rows.map((t) => `${t.name}: ${t.states.join(" > ")}`).join("\n"));
}

/** Batch-fetch a few fields for many ids (WIQL answers ids only). */
export async function fetchItems(c: AdoClient, ids: number[], fields: string[] = ["System.Id", "System.WorkItemType", "System.State", "System.Title", "System.AssignedTo", "System.IterationPath"]): Promise<Record<string, any>[]> {
  const out: Record<string, any>[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const r = await c.post<{ value?: { fields?: Record<string, any> }[] }>("wit/workitemsbatch", { ids: ids.slice(i, i + 200), fields });
    out.push(...(r.value ?? []).map((x) => x.fields ?? {}));
  }
  return out;
}

export const itemLine = (f: Record<string, any>) => `AB#${f["System.Id"]} ${String(f["System.WorkItemType"] ?? "").padEnd(10)} ${String(f["System.State"] ?? "").padEnd(8)} ${cut(f["System.Title"], 70)}${f["System.AssignedTo"] ? `  (${who(f["System.AssignedTo"])})` : ""}`;
export { encode };
