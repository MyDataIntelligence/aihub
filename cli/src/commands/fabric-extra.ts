import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { AihubError } from "../lib/errors.js";
import { describe, FabricIdentity, identityJson, loadSpFile, saveSpFile, storeSecret } from "../lib/fabric-auth.js";
import { FabricClient, FabricHttpError, guardEnv, inferEnv, jobTypeFor } from "../lib/fabric.js";
import { oneLine, toTable } from "../lib/fabric-ops.js";
import { dryRun, emit, itemArg, makeClient, need, target, where, type Setup } from "./fabric.js";

// ---- workspaces, capacities, connections ----------------------------------------------

export async function workspaceCmd(s: Setup, sub: string | undefined): Promise<void> {
  const client = makeClient(s.ctx, s.v);
  if (sub === "create") {
    const name = need(s.v, "name", "display name");
    const env = inferEnv(name);
    if (env !== "dev") guardEnv({ name, environment: env }, s.v["allow-env"] as string | undefined);
    const body = { displayName: name, ...(s.v.description ? { description: s.v.description } : {}), ...(s.v.capacity ? { capacityId: s.v.capacity } : {}) };
    if (s.v["dry-run"]) return dryRun(s, [`create workspace '${name}'${s.v.capacity ? ` on capacity ${s.v.capacity}` : ""}`]);
    const r = await client.request("POST", "/workspaces", body);
    return emit(s, r.data, `created workspace ${name} (id ${r.data.id ?? "?"})`);
  }
  const t = await target(s, client, sub === "assign-capacity");
  if (sub === "show") {
    const w = (await client.request("GET", `/workspaces/${t.id}`)).data as Record<string, unknown>;
    return emit(s, w, [`workspace ${w.displayName ?? t.ws.name} (${t.ws.environment})`, ...Object.entries(w).filter(([k]) => k !== "displayName").map(([k, x]) => `${k}: ${typeof x === "object" ? JSON.stringify(x) : String(x ?? "")}`)].join("\n"));
  }
  if (sub === "roles") {
    const roles = await client.list<{ id: string; role: string; principal?: { displayName?: string; type?: string } }>(`/workspaces/${t.id}/roleAssignments`);
    return emit(s, roles, [`${roles.length} role assignment(s) in ${where(t)}`, ...(roles.length ? [toTable([["role", "principal", "type"], ...roles.map((r) => [r.role, r.principal?.displayName ?? r.id, r.principal?.type ?? "-"])])] : [])].join("\n"));
  }
  if (sub === "assign-capacity") {
    const cap = need(s.v, "capacity", "capacity id|name");
    const caps = await client.list<{ id: string; displayName: string }>("/capacities");
    const hit = caps.find((c) => c.id.toLowerCase() === cap.toLowerCase() || c.displayName.toLowerCase() === cap.toLowerCase());
    if (!hit) throw new AihubError(`capacity '${cap}' not found; list them with: aihub fabric capacities`);
    if (s.v["dry-run"]) return dryRun(s, [`assign ${where(t)} to capacity ${hit.displayName}`]);
    await client.request("POST", `/workspaces/${t.id}/assignToCapacity`, { capacityId: hit.id });
    return emit(s, { capacity: hit.id }, `assigned ${t.ws.name} to capacity ${hit.displayName}`);
  }
  throw new AihubError("usage: aihub fabric workspace show|roles|create|assign-capacity");
}

export async function capacitiesCmd(s: Setup): Promise<void> {
  const caps = await makeClient(s.ctx, s.v).list<{ id: string; displayName: string; sku?: string; region?: string; state?: string }>("/capacities");
  emit(s, caps, caps.length ? toTable([["id", "name", "sku", "region", "state"], ...caps.map((c) => [c.id, c.displayName, c.sku ?? "-", c.region ?? "-", c.state ?? "-"])]) : "no capacities visible for this account");
}

export async function connectionsCmd(s: Setup, what: "connections" | "gateways"): Promise<void> {
  const rows = await makeClient(s.ctx, s.v).list<{ id: string; displayName?: string; connectivityType?: string; type?: string }>(`/${what}`);
  const f = (s.v.filter as string | undefined)?.toLowerCase();
  const out = rows.filter((r) => !f || `${r.displayName ?? ""} ${r.id}`.toLowerCase().includes(f));
  emit(s, out, out.length ? toTable([["id", "name", "kind"], ...out.map((r) => [r.id, r.displayName ?? "-", r.connectivityType ?? r.type ?? "-"])]) : `no ${what} visible for this account`);
}

// ---- schedules, shortcuts ---------------------------------------------------------------

export async function schedulesCmd(s: Setup): Promise<void> {
  const client = makeClient(s.ctx, s.v);
  const t = await target(s, client, false);
  const it = await itemArg(s, client, t.id);
  const jobType = (s.v["job-type"] as string | undefined) ?? (jobTypeFor(it.type) === "Pipeline" ? "Pipeline" : "DefaultJob");
  const sch = await client.list<{ id: string; enabled?: boolean; configuration?: { type?: string; times?: string[]; interval?: number; weekdays?: string[]; startDateTime?: string; endDateTime?: string } }>(`/workspaces/${t.id}/items/${it.id}/jobs/${jobType}/schedules`);
  const rows = sch.map((x) => [x.id, x.enabled ? "enabled" : "disabled", x.configuration?.type ?? "-", [x.configuration?.times?.join(","), x.configuration?.interval ? `every ${x.configuration.interval} min` : "", x.configuration?.weekdays?.join(",")].filter(Boolean).join(" ") || "-"]);
  emit(s, sch, sch.length ? [`${sch.length} schedule(s) of ${it.type} ${it.displayName} (${jobType})`, toTable([["id", "state", "type", "when"], ...rows])].join("\n") : `no schedules for ${it.displayName} (${jobType})`);
}

export async function shortcutsCmd(s: Setup): Promise<void> {
  const client = makeClient(s.ctx, s.v);
  const t = await target(s, client, false);
  const lh = await client.resolveItem(t.id, need(s.v, "lakehouse", "name|id"), "Lakehouse");
  const sc = await client.list<{ name: string; path: string; target?: { type?: string } }>(`/workspaces/${t.id}/items/${lh.id}/shortcuts`);
  emit(s, sc, sc.length ? [`${sc.length} shortcut(s) in ${lh.displayName}`, toTable([["path", "name", "target"], ...sc.map((x) => [x.path, x.name, x.target?.type ?? "-"])])].join("\n") : `no shortcuts in ${lh.displayName}`);
}

// ---- lakehouse load / maintenance ----------------------------------------------------------

export async function lakehouseLoad(s: Setup): Promise<void> {
  const client = makeClient(s.ctx, s.v);
  const table = need(s.v, "table", "table name");
  const rel = need(s.v, "path", "file path under Files, e.g. landing/orders.csv");
  const t = await target(s, client, true);
  const lh = await client.resolveItem(t.id, need(s.v, "lakehouse", "name|id"), "Lakehouse");
  const mode = s.v.append ? "Append" : "Overwrite";
  const body = { relativePath: `Files/${rel.replace(/^\/+/, "")}`, pathType: "File", mode, formatOptions: { format: "Csv", header: true, delimiter: "," } };
  if (s.v["dry-run"]) return dryRun(s, [`load ${body.relativePath} into table '${table}' of ${lh.displayName} in ${where(t)} (${mode})`]);
  await client.lro("POST", `/workspaces/${t.id}/lakehouses/${lh.id}/tables/${encodeURIComponent(table)}/load`, body);
  emit(s, { loaded: table }, `loaded ${body.relativePath} into ${lh.displayName}.${table} (${mode})`);
}

export async function lakehouseMaintenance(s: Setup): Promise<void> {
  const client = makeClient(s.ctx, s.v);
  const table = need(s.v, "table", "table name");
  const t = await target(s, client, true);
  const lh = await client.resolveItem(t.id, need(s.v, "lakehouse", "name|id"), "Lakehouse");
  const executionData = { tableName: table, optimizeSettings: { vOrder: true }, vacuumSettings: { retentionPeriod: (s.v.retention as string | undefined) ?? "7.01:00:00" } };
  if (s.v["dry-run"]) return dryRun(s, [`run TableMaintenance (optimize + vacuum) on ${lh.displayName}.${table} in ${where(t)}`]);
  const r = await client.request("POST", `/workspaces/${t.id}/items/${lh.id}/jobs/instances?jobType=TableMaintenance`, { executionData });
  const jobId = /instances\/([^/?]+)/.exec(r.headers.get("location") ?? "")?.[1] ?? "?";
  emit(s, { job: jobId }, `started table maintenance on ${lh.displayName}.${table}: job ${jobId}; follow: aihub fabric status --workspace ${t.ws.name} --item ${lh.displayName} --job ${jobId}`);
}

// ---- environments --------------------------------------------------------------------------

export async function environmentCmd(s: Setup, sub: string | undefined): Promise<void> {
  const client = makeClient(s.ctx, s.v);
  const publish = sub === "publish";
  const upload = sub === "upload-library";
  if (!publish && !upload && sub !== "libraries") throw new AihubError("usage: aihub fabric environment publish|libraries|upload-library --workspace W --item E [--file lib.whl]");
  const t = await target(s, client, publish || upload);
  const env = await client.resolveItem(t.id, need(s.v, "item", "environment"), "Environment");
  if (upload) {
    const file = need(s.v, "file", "library file (.whl .py .jar .tar.gz)");
    const name = basename(file);
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}.(jar|py|whl|tar.gz)$/.test(name)) throw new AihubError(`the library file name '${name}' must end in .whl, .py, .jar or .tar.gz`);
    const blob = readFileSync(file);
    const sha = createHash("sha256").update(blob).digest("hex");
    if (s.v["dry-run"]) return dryRun(s, [`upload library ${name} (${blob.length} bytes, sha256 ${sha.slice(0, 12)}) to the staging of Environment '${env.displayName}' in ${where(t)}`]);
    const boundary = `aihub${randomUUID().replace(/-/g, "")}`;
    const head = Buffer.from(`--${boundary}
Content-Disposition: form-data; name="file"; filename="${name}"
Content-Type: application/octet-stream

`);
    const tail = Buffer.from(`
--${boundary}--
`);
    await client.request("POST", `/workspaces/${t.id}/environments/${env.id}/staging/libraries`, undefined, { raw: new Uint8Array(Buffer.concat([head, blob, tail])), headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` } });
    return emit(s, { uploaded: name, sha256: sha }, `uploaded ${name} to the staging of ${env.displayName}; publish it with: aihub fabric environment publish --workspace ${t.ws.name} --item ${env.displayName}`);
  }
  if (publish) {
    if (s.v["dry-run"]) return dryRun(s, [`publish the staged libraries and Spark settings of Environment '${env.displayName}' in ${where(t)}`]);
    await client.lro("POST", `/workspaces/${t.id}/environments/${env.id}/staging/publish`);
    return emit(s, { published: env.id }, `published Environment ${env.displayName} in ${where(t)}`);
  }
  const staging = s.v.staging ? "/staging" : "";
  const lib = (await client.request("GET", `/workspaces/${t.id}/environments/${env.id}${staging}/libraries`)).data as { customLibraries?: Record<string, string[]>; environmentYml?: string };
  const lines = [`libraries of Environment ${env.displayName}${staging ? " (staging)" : " (published)"}`];
  for (const [k, v] of Object.entries(lib.customLibraries ?? {})) if (v?.length) lines.push(`  ${k}: ${v.join(", ")}`);
  if (lib.environmentYml) lines.push(`  environment.yml: ${oneLine(lib.environmentYml, 300)}`);
  emit(s, lib, lines.length > 1 ? lines.join("\n") : `${lines[0]}: none`);
}

// ---- deployment pipelines ---------------------------------------------------------------------

interface Stage {
  id: string;
  order: number;
  displayName: string;
  workspaceId?: string;
  workspaceName?: string;
}

async function pipeline(client: FabricClient, name: string): Promise<{ id: string; displayName: string }> {
  const all = await client.list<{ id: string; displayName: string }>("/deploymentPipelines");
  const hit = all.find((p) => p.id.toLowerCase() === name.toLowerCase() || p.displayName.toLowerCase() === name.toLowerCase());
  if (!hit) throw new AihubError(`deployment pipeline '${name}' not found${all.length ? `; available: ${all.map((p) => p.displayName).join(", ")}` : ""}`);
  return hit;
}

function stageOf(stages: Stage[], key: string, what: string): Stage {
  const hit = stages.find((x) => x.id.toLowerCase() === key.toLowerCase() || x.displayName.toLowerCase() === key.toLowerCase() || String(x.order) === key);
  if (!hit) throw new AihubError(`${what} stage '${key}' not found; stages: ${stages.map((x) => `${x.order}=${x.displayName}`).join(", ")}`);
  return hit;
}

/** A stage counts as ACC/PRD by its name or its workspace name; the last stage of a pipeline of three or more is production too. */
export function stageEnv(st: Stage, all: Stage[]) {
  const byName = [inferEnv(st.displayName), inferEnv(st.workspaceName ?? "")].find((e) => e !== "dev");
  if (byName) return byName;
  const max = Math.max(...all.map((x) => x.order));
  return all.length >= 3 && st.order === max ? "prd" : "dev";
}

export async function deploymentCmd(s: Setup, sub: string | undefined): Promise<void> {
  const client = makeClient(s.ctx, s.v);
  if (sub === "list" || !sub) {
    const all = await client.list<{ id: string; displayName: string; description?: string }>("/deploymentPipelines");
    return emit(s, all, all.length ? toTable([["id", "name"], ...all.map((p) => [p.id, p.displayName])]) : "no deployment pipelines visible for this account");
  }
  const p = await pipeline(client, need(s.v, "pipeline", "name|id"));
  const stages = (await client.list<Stage>(`/deploymentPipelines/${p.id}/stages`)).sort((a, b) => a.order - b.order);
  if (sub === "stages") {
    return emit(s, stages, [`${stages.length} stage(s) of ${p.displayName}`, toTable([["order", "stage", "workspace", "stage env"], ...stages.map((x) => [String(x.order), x.displayName, x.workspaceName ?? "-", stageEnv(x, stages)])])].join("\n"));
  }
  if (sub === "deploy") {
    const from = stageOf(stages, need(s.v, "from-stage", "stage name|order"), "source");
    const to = stageOf(stages, need(s.v, "to-stage", "stage name|order"), "target");
    const env = stageEnv(to, stages);
    guardEnv({ name: `${to.displayName}${to.workspaceName ? ` / ${to.workspaceName}` : ""}`, environment: env }, s.v["allow-env"] as string | undefined);
    const body = { sourceStageId: from.id, targetStageId: to.id, ...(s.v.note ? { note: s.v.note } : {}) };
    if (s.v["dry-run"]) return dryRun(s, [`deploy ${p.displayName}: ${from.displayName} -> ${to.displayName} (${env})`]);
    await client.lro("POST", `/deploymentPipelines/${p.id}/deploy`, body);
    return emit(s, { deployed: [from.id, to.id] }, `deployed ${p.displayName}: ${from.displayName} -> ${to.displayName}`);
  }
  throw new AihubError("usage: aihub fabric deployment list|stages|deploy --pipeline P [--from-stage S --to-stage T]");
}

// ---- auth: who am I, service principals ----------------------------------------------------------

export async function authCmd(s: Setup, pos: string[]): Promise<void> {
  const deps = { env: s.ctx.env, fetch: s.ctx.fetch, exec: s.ctx.exec, now: s.ctx.now, tokenCache: s.ctx.tokenCache };
  const file = loadSpFile(deps);
  if (pos[1] === "status" || pos[0] === "status" || !pos[0]) {
    const id = new FabricIdentity(deps, s.v.sp as string | undefined);
    const ident = id.resolve();
    const lines = [`identity: ${describeIdentity(ident)}`];
    let expires: number | undefined;
    try {
      expires = await id.expiry("fabric");
      if (expires) lines.push(`token expires: ${new Date(expires).toISOString()}`);
      else lines.push("token expiry: managed by az / the token you supplied");
    } catch (e) {
      lines.push(`sign-in failed: ${(e as Error).message}`);
    }
    lines.push(`registered service principals: ${Object.keys(file.principals).join(", ") || "none"}${file.default ? ` (default ${file.default})` : ""}`);
    return emit(s, { identity: identityJson(ident), expires, registered: Object.keys(file.principals), default: file.default }, lines.join("\n"));
  }
  if (pos[0] !== "sp") throw new AihubError("usage: aihub fabric auth status | sp add|list|remove|default|test");
  const act = pos[1];
  const name = pos[2];
  const nameOf = () => {
    if (!name) throw new AihubError(`usage: aihub fabric auth sp ${act} <name>`);
    return name;
  };
  if (act === "list") {
    const rows = Object.entries(file.principals).map(([n, p]) => [n, p.tenant, p.clientId, p.secretRef.startsWith("kv://") ? p.secretRef : p.secretRef.startsWith("cert:") ? "certificate" : "credential store", n === file.default ? "default" : ""]);
    return emit(s, file, rows.length ? toTable([["name", "tenant", "client id", "secret", ""], ...rows]) : "no service principals registered; add one with: aihub fabric auth sp add <name> --tenant T --client-id C --secret-from-stdin");
  }
  if (act === "add") {
    const n = nameOf();
    const tenant = need(s.v, "tenant", "tenant id");
    const clientId = need(s.v, "client-id", "application (client) id");
    const kinds = ["secret-from-stdin", "cert", "keyvault"].filter((k) => s.v[k]);
    if (kinds.length !== 1) throw new AihubError("give exactly one of --secret-from-stdin, --cert <pem file> or --keyvault kv://<vault>/<secret>");
    let secretRef: string;
    if (s.v.cert) secretRef = `cert:${s.v.cert as string}`;
    else if (s.v.keyvault) {
      secretRef = s.v.keyvault as string;
      if (!/^kv:\/\/[^/]+\/[^/]+$/.test(secretRef)) throw new AihubError(`--keyvault must look like kv://<vault>/<secret>, not '${secretRef}'`);
    } else {
      const secret = (s.ctx.stdin ? s.ctx.stdin() : readFileSync(0, "utf8")).trim();
      if (!secret) throw new AihubError("no secret on stdin: pipe it in, for example: echo $SECRET | aihub fabric auth sp add ...");
      if (s.v["dry-run"]) return dryRun(s, [`register service principal ${n} (client ${clientId}) with a secret in the credential store`]);
      storeSecret(deps, n, secret);
      secretRef = `store:${n}`;
    }
    if (s.v["dry-run"]) return dryRun(s, [`register service principal ${n} (client ${clientId}) with ${secretRef}`]);
    file.principals[n] = { tenant, clientId, secretRef };
    saveSpFile(deps, file);
    return emit(s, { added: n }, `registered service principal ${n} (client ${clientId}); test it with: aihub fabric auth sp test ${n}`);
  }
  if (act === "remove") {
    const n = nameOf();
    if (!file.principals[n]) throw new AihubError(`service principal '${n}' is not registered`);
    delete file.principals[n];
    if (file.default === n) file.default = undefined;
    saveSpFile(deps, file);
    return emit(s, { removed: n }, `removed service principal ${n} (a secret in the credential store is not deleted: remove the '${n}' entry there too)`);
  }
  if (act === "default") {
    if (s.v.clear) {
      file.default = undefined;
      saveSpFile(deps, file);
      return emit(s, { default: null }, "no default service principal: the az user is used again");
    }
    const n = nameOf();
    if (!file.principals[n]) throw new AihubError(`service principal '${n}' is not registered`);
    file.default = n;
    saveSpFile(deps, file);
    return emit(s, { default: n }, `default service principal: ${n}`);
  }
  if (act === "test") {
    const n = nameOf();
    const id = new FabricIdentity(deps, n);
    id.resolve();
    const client = new FabricClient(() => id.token("fabric"), s.ctx.fetch, { sleep: s.ctx.sleep, waitScale: s.ctx.env.AIHUB_POLL_MS === "0" ? 0 : 1, identity: id });
    const ws = await client.workspaces();
    return emit(s, { ok: true, workspaces: ws.length }, `service principal ${n} signed in and sees ${ws.length} workspace(s)`);
  }
  throw new AihubError("usage: aihub fabric auth sp add|list|remove|default|test");
}

const describeIdentity = describe;
void FabricHttpError;
