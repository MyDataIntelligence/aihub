import { readFileSync, writeFileSync } from "node:fs";
import { AihubError } from "../lib/errors.js";
import { didYouMean, FabricHttpError, type FabricClient } from "../lib/fabric.js";
import { FABRIC_ROWS, type FabricRow } from "../lib/fabric-table.js";
import { oneLine, toTable } from "../lib/fabric-ops.js";
import { redact } from "../lib/fabric-redact.js";
import { dryRun, emit, itemArg, makeClient, need, oneLakeList, target, where, type Setup, type Target } from "./fabric.js";

const DFS = "https://onelake.dfs.fabric.microsoft.com";

/** Drop nulls, cut long strings and long lists (legacy `slim`). */
export function slim(v: unknown): unknown {
  if (Array.isArray(v)) return v.length > 100 ? [...v.slice(0, 100).map(slim), { _more: v.length - 100 }] : v.map(slim);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== null && x !== undefined).map(([k, x]) => [k, slim(x)]));
  return typeof v === "string" && v.length > 800 ? `${v.slice(0, 800)}...(${v.length - 800} more characters)` : v;
}

const norm = (n: string) => n.replace(/^fabric[_-]/, "").replace(/-/g, "_").toLowerCase();

function args(s: Setup): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of (s.v.arg as string[] | undefined) ?? []) {
    const i = a.indexOf("=");
    if (i < 1) throw new AihubError(`--arg wants name=value, not '${a}'`);
    out[a.slice(0, i)] = a.slice(i + 1);
  }
  return out;
}

const coerce = (x: string): unknown => (x === "true" ? true : x === "false" ? false : /^-?\d+$/.test(x) ? Number(x) : x);

export function findRow(name: string): FabricRow {
  const n = norm(name);
  const hit = FABRIC_ROWS.find((r) => r.name === n);
  if (hit) return hit;
  const d = didYouMean(n, FABRIC_ROWS.map((r) => r.name), 4);
  throw new AihubError(`no Fabric API row '${name}'${d.length ? `; did you mean: ${d.join(", ")}?` : ""}; list them with: aihub fabric api list`);
}

/** `aihub fabric api <tool>`: every declarative row of the legacy Hub tool table, same URL, body and safety rules. */
export async function apiCmd(s: Setup, pos: string[]): Promise<void> {
  const tool = pos[0];
  if (!tool || tool === "list") {
    const f = (s.v.filter as string | undefined)?.toLowerCase();
    const rows = FABRIC_ROWS.filter((r) => !f || r.name.includes(f) || r.url.toLowerCase().includes(f));
    return emit(s, rows, rows.length ? toTable([["tool", "method", "write", "url"], ...rows.map((r) => [r.name, r.method, r.write ? "yes" : "", r.url.replace("https://api.powerbi.com/v1.0/myorg/", "powerbi:")])]) : `no tool matches '${f}'`);
  }
  const row = findRow(tool);
  const a = args(s);
  const client = makeClient(s.ctx, s.v);
  const wantsWs = row.url.includes("{ws}");
  const t: Target | undefined = wantsWs ? await target(s, client, !!row.write) : undefined;
  if (!wantsWs && row.write) {
    // tenant-level write: still never in ACC/PRD by name when a name is given
    const name = a.displayName ?? a.name;
    if (name) (await import("../lib/fabric.js")).guardEnv({ name, environment: (await import("../lib/fabric.js")).inferEnv(name) }, s.v["allow-env"] as string | undefined);
  }
  let url = row.url;
  if (url.includes("{item}")) {
    if (!t) throw new AihubError(`${row.name} needs a workspace`);
    url = url.replace("{item}", (await itemArg(s, client, t.id)).id);
  }
  if (t) url = url.replace("{ws}", t.id);
  url = url.replace(/\{(\w+)\}/g, (_m, k: string) => {
    const x = a[k] ?? (k === "jobType" ? undefined : undefined);
    if (x === undefined) throw new AihubError(`${row.name} needs --arg ${k}=<value>`);
    return k === "path" || k === "parentPath" ? encodeURIComponent(x).replace(/%2F/g, "/") : encodeURIComponent(x);
  });
  const q = (row.q ?? []).flatMap((e) => {
    const [key, arg] = e.includes("=") ? e.split("=") : [e, e];
    const val = a[arg];
    return val === undefined || val === "" ? [] : [`${key}=${encodeURIComponent(val)}`];
  });
  if (q.length) url += `${url.includes("?") ? "&" : "?"}${q.join("&")}`;
  let body: unknown;
  if (s.v["body-file"]) {
    try {
      body = JSON.parse(readFileSync(s.v["body-file"] as string, "utf8").replace(/^﻿/, ""));
    } catch {
      throw new AihubError(`--body-file '${s.v["body-file"]}' must contain JSON`);
    }
  } else if (row.body) {
    body = Object.fromEntries(
      row.body.flatMap((e) => {
        const [arg, key] = e.split(">");
        return a[arg] === undefined ? [] : [[key || arg, coerce(a[arg])]];
      }),
    );
  } else if (row.bodyFile) throw new AihubError(`${row.name} builds a structured body: pass it with --body-file <json file> (fields as in the Fabric REST docs)`);
  else if (row.method !== "GET" && row.method !== "DELETE") body = {};
  const pbi = row.res === "pbi";
  const path = /^https?:\/\//.test(url) ? url : `/${url}`;
  const shown = `${row.method} ${url.replace("https://api.powerbi.com/v1.0/myorg/", "powerbi:")}`;
  if (row.write && (s.v["dry-run"] || (row.method === "DELETE" && !s.v.yes))) {
    if (s.v["dry-run"]) return dryRun(s, [t ? `${row.phrase ?? row.name} in ${where(t)}` : (row.phrase ?? row.name), shown, ...(body !== undefined ? [`body: ${redact(JSON.stringify(body)).slice(0, 300)}`] : [])]);
    throw new AihubError(`${row.name} deletes: add --yes (or --dry-run to look first)`);
  }
  let data: unknown;
  if (row.method === "GET" && row.paged) data = await client.list(path, { key: row.key, powerbi: pbi });
  else if (row.lro) data = (await client.lro(row.method, path, body, { powerbi: pbi })).data;
  else data = (await client.request(row.method, path, body, { powerbi: pbi })).data;
  const text = Array.isArray(data) ? `${data.length} ${row.noun ?? "entries"}\n${JSON.stringify(slim(data), null, 1)}` : row.write ? `done: ${row.name}${t ? ` in ${where(t)}` : ""}${data && Object.keys(data as object).length ? `\n${JSON.stringify(slim(data), null, 1)}` : ""}` : JSON.stringify(slim(data), null, 1);
  emit(s, slim(data), text);
}

// ---- OneLake -----------------------------------------------------------------------------------------

function oneLakePath(item: string, path: string, wsId: string, itemId: string): string {
  const p = path.replace(/^\/+|\/+$/g, "");
  if (!p || p.includes("..")) throw new AihubError("--path must be a path inside the item, for example Files/landing/orders.csv");
  const rooted = /^(Files|Tables)(\/|$)/.test(p) ? p : `Files/${p}`;
  void item;
  return `${DFS}/${wsId}/${itemId}/${rooted.split("/").map(encodeURIComponent).join("/")}`;
}

export async function onelakeCmd(s: Setup, sub: string | undefined): Promise<void> {
  const write = ["write", "mkdir", "delete", "move"].includes(sub ?? "");
  if (!["list", "read", "write", "mkdir", "delete", "move"].includes(sub ?? "")) throw new AihubError("usage: aihub fabric onelake list|read|write|mkdir|delete|move --workspace W --lakehouse L --path P");
  const client = makeClient(s.ctx, s.v);
  const t = await target(s, client, write);
  const lh = await client.resolveItem(t.id, need(s.v, "lakehouse", "name|id"));
  const path = (s.v.path as string | undefined) ?? "";
  if (sub === "list") {
    const root = /^Tables(\/|$)/.test(path) ? "" : "Files";
    const rows = await oneLakeList(client, t.id, lh.id, root, root ? path.replace(/^Files\/?/, "") : path);
    return emit(s, rows, [`${rows.length} entr(y/ies) in ${lh.displayName}/${path || "Files"} [source: OneLake DFS]`, ...(rows.length ? [toTable([["name", "kind", "bytes", "modified"], ...rows.map((r) => [r.name, r.isDirectory ? "dir" : "file", r.size, r.modified])])] : [])].join("\n"));
  }
  const url = oneLakePath(lh.displayName, path, t.id, lh.id);
  if (sub === "read") {
    const r = await client.request("GET", url, undefined, { storage: true, accept: "*/*" });
    const max = Number(s.v["max-bytes"] ?? 200_000);
    if (s.v.out) {
      writeFileSync(s.v.out as string, r.text);
      return emit(s, { out: s.v.out, bytes: r.text.length }, `wrote ${r.text.length} bytes of ${path} to ${s.v.out}`);
    }
    const cut = r.text.length > max;
    return emit(s, { path, truncated: cut, text: r.text.slice(0, max) }, `${cut ? `first ${max} of ${r.text.length} bytes of ${path}:\n` : ""}${r.text.slice(0, max)}`);
  }
  if (sub === "mkdir") {
    if (s.v["dry-run"]) return dryRun(s, [`create folder ${path} in ${lh.displayName} (${where(t)})`]);
    await client.request("PUT", `${url}?resource=directory`, undefined, { storage: true });
    return emit(s, { created: path }, `created folder ${path} in ${lh.displayName}`);
  }
  if (sub === "delete") {
    if (s.v["dry-run"]) return dryRun(s, [`delete ${path} (recursive) in ${lh.displayName} (${where(t)})`]);
    if (!s.v.yes) throw new AihubError(`deleting ${path} in ${lh.displayName} cannot be undone: add --yes (or --dry-run)`);
    await client.request("DELETE", `${url}?recursive=true`, undefined, { storage: true });
    return emit(s, { deleted: path }, `deleted ${path} in ${lh.displayName}`);
  }
  if (sub === "move") {
    const to = need(s.v, "to", "destination path");
    if (s.v["dry-run"]) return dryRun(s, [`move ${path} to ${to} in ${lh.displayName} (${where(t)})`]);
    const src = new URL(oneLakePath(lh.displayName, path, t.id, lh.id)).pathname;
    await client.request("PUT", oneLakePath(lh.displayName, to, t.id, lh.id), undefined, { storage: true, headers: { "x-ms-rename-source": src } });
    return emit(s, { moved: path, to }, `moved ${path} to ${to} in ${lh.displayName}`);
  }
  // write: create, append, flush (DFS file upload)
  const content = s.v.file ? readFileSync(s.v.file as string) : Buffer.from(need(s.v, "text", "text or use --file"));
  if (s.v["dry-run"]) return dryRun(s, [`write ${content.length} bytes to ${path} in ${lh.displayName} (${where(t)})`]);
  await client.request("PUT", `${url}?resource=file`, undefined, { storage: true });
  if (content.length) await client.request("PATCH", `${url}?action=append&position=0`, undefined, { storage: true, raw: new Uint8Array(content), headers: { "Content-Type": "application/octet-stream" } });
  await client.request("PATCH", `${url}?action=flush&position=${content.length}`, undefined, { storage: true });
  emit(s, { written: path, bytes: content.length }, `wrote ${content.length} bytes to ${path} in ${lh.displayName}`);
}

// ---- read-only queries: DAX, KQL, GraphQL --------------------------------------------------------------

export function daxGuard(q: string): void {
  const t = q.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(--|\/\/)[^\n]*/g, " ").trim();
  if (!/^(EVALUATE|DEFINE)\b/i.test(t)) throw new AihubError("only DAX queries are allowed: start with EVALUATE (or DEFINE ... EVALUATE); nothing was run");
}
export function kqlGuard(q: string): void {
  if (q.split(/\r?\n/).some((l) => l.trim().startsWith("."))) throw new AihubError('KQL control commands (starting with ".") are not allowed; send a read-only query; nothing was run');
}
export function graphqlGuard(q: string): void {
  const t = q.replace(/#[^\n]*/g, " ").replace(/"""[\s\S]*?"""|"(?:[^"\\]|\\.)*"/g, '""');
  if (/(^|[\s}])(mutation|subscription)\b/i.test(t)) throw new AihubError("only read-only GraphQL queries are allowed (mutation and subscription are refused); nothing was sent");
}

const queryText = (s: Setup): string => {
  const q = s.v.query ? (s.v.query as string) : s.v["query-file"] ? readFileSync(s.v["query-file"] as string, "utf8") : "";
  if (!q.trim()) throw new AihubError("needs --query <text> or --query-file <file>");
  return q;
};

export async function queryCmd(s: Setup, kind: "dax" | "kql" | "graphql"): Promise<void> {
  const q = queryText(s);
  (kind === "dax" ? daxGuard : kind === "kql" ? kqlGuard : graphqlGuard)(q);
  const client: FabricClient = makeClient(s.ctx, s.v);
  const t = await target(s, client, false);
  const it = await itemArg(s, client, t.id);
  const max = Math.min(Number(s.v.top ?? 100), 5000);
  if (kind === "dax") {
    const r = await client.request("POST", `https://api.powerbi.com/v1.0/myorg/groups/${t.id}/datasets/${it.id}/executeQueries`, { queries: [{ query: q }], serializerSettings: { includeNulls: true } }, { powerbi: true });
    const res = (r.data.results?.[0] ?? {}) as { tables?: { rows?: unknown[] }[]; error?: unknown };
    const rows = res.tables?.[0]?.rows ?? [];
    return emit(s, { rowCount: rows.length, truncated: rows.length > max, rows: slim(rows.slice(0, max)), error: res.error }, `DAX ran: ${rows.length} row(s)${rows.length > max ? ` (first ${max})` : ""}\n${JSON.stringify(slim(rows.slice(0, max)), null, 1)}${res.error ? `\nerror: ${JSON.stringify(res.error)}` : ""}`);
  }
  if (kind === "kql") {
    const db = (await client.request("GET", `/workspaces/${t.id}/kqlDatabases/${it.id}`)).data as { properties?: { queryServiceUri?: string; databaseName?: string } };
    const uri = db.properties?.queryServiceUri ?? "";
    if (!/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.kusto\.fabric\.microsoft\.com\/?$/i.test(uri)) throw new AihubError(`the query service URI '${uri.slice(0, 80)}' is not a *.kusto.fabric.microsoft.com host; nothing was sent`);
    const r = await client.request("POST", `${uri.replace(/\/$/, "")}/v1/rest/query`, { db: db.properties?.databaseName ?? it.displayName, csl: q, properties: { Options: { request_readonly: true } } }, { kusto: true });
    const table = (r.data.Tables?.[0] ?? {}) as { Columns?: { ColumnName: string }[]; Rows?: unknown[] };
    const rows = table.Rows ?? [];
    const cols = (table.Columns ?? []).map((c) => c.ColumnName);
    return emit(s, { columns: cols, rowCount: rows.length, truncated: rows.length > max, rows: slim(rows.slice(0, max)) }, `KQL ran: ${rows.length} row(s)\ncolumns: ${cols.join(", ")}\n${JSON.stringify(slim(rows.slice(0, max)), null, 1)}`);
  }
  const body: Record<string, unknown> = { query: q };
  if (s.v.variables) body.variables = JSON.parse(s.v.variables as string);
  const r = await client.request("POST", `/workspaces/${t.id}/graphqlapis/${it.id}/graphql`, body);
  const errors = ((r.data.errors ?? []) as { message?: string }[]).map((e) => e.message);
  emit(s, { data: slim(r.data.data), errors }, errors.length && !r.data.data ? `GraphQL failed: ${oneLine(errors.join("; "), 300)}` : `GraphQL ran\n${JSON.stringify(slim(r.data.data), null, 1)}${errors.length ? `\nerrors: ${errors.join("; ")}` : ""}`);
}

void FabricHttpError;
