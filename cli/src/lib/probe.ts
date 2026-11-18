import { makeAuth } from "./auth.js";
import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { FabricHttpError } from "./fabric.js";
import { redact } from "./fabric-redact.js";

/**
 * Read-only probes for the feasibility mode: does an endpoint or feature exist for THIS account, tenant and capacity?
 * Every probe is one GET (or a list). It never writes, and for Fabric and Azure DevOps it reports the status and the
 * SHAPE of the answer (keys, number of items), never item contents.
 */
export type Answer = "yes" | "no" | "unknown";

export interface ProbeResult {
  probe: string;
  answer: Answer;
  /** HTTP status of the call, null when no call was made. */
  status: number | null;
  /** One sentence: what the status means for the question. */
  meaning: string;
  /** Shape of the body: top-level keys and the length of a `value` list. */
  shape?: { keys: string[]; count?: number };
  /** Extra facts that are metadata only (capacity SKU, region, state; the signed-in identity). */
  facts?: Record<string, unknown>;
  readOnly: true;
}

/** What a status means for "is this available to me?". */
export function interpret(status: number): { answer: Answer; meaning: string } {
  if (status >= 200 && status < 300) return { answer: "yes", meaning: "the endpoint answered: the feature exists and your account may read it" };
  if (status === 404) return { answer: "no", meaning: "404: the endpoint, the item type or the resource does not exist here (or is not enabled for this tenant)" };
  if (status === 401) return { answer: "unknown", meaning: "401: not signed in; run az login" };
  if (status === 403) return { answer: "unknown", meaning: "403: it may exist, but your account lacks permission or a tenant setting blocks it" };
  if (status === 400) return { answer: "unknown", meaning: "400: the endpoint exists but rejected this request (a parameter, or the feature is off for this capacity)" };
  if (status === 429) return { answer: "unknown", meaning: "429: throttled; try again in a minute" };
  if (status === 501) return { answer: "no", meaning: "501: not implemented" };
  return { answer: "unknown", meaning: `${status}: the service failed; try again, this says nothing about the feature` };
}

export const shapeOf = (data: unknown): ProbeResult["shape"] => {
  if (Array.isArray(data)) return { keys: [], count: data.length };
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    const list = Array.isArray(o.value) ? o.value : Array.isArray(o.data) ? o.data : undefined;
    return { keys: Object.keys(o).slice(0, 12), ...(list ? { count: list.length } : {}) };
  }
  return { keys: [] };
};

export function format(r: ProbeResult): string {
  const L = [`${r.answer.toUpperCase()}  ${r.probe}  ->  ${r.status ?? "no call"}`, `  ${r.meaning}`];
  if (r.shape) L.push(`  answer shape: keys [${r.shape.keys.join(", ")}]${r.shape.count !== undefined ? `, ${r.shape.count} item(s)` : ""} (contents are never shown)`);
  for (const [k, v] of Object.entries(r.facts ?? {})) L.push(`  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  L.push("  read-only probe: nothing was changed");
  return L.join("\n");
}

const FABRIC = "https://api.fabric.microsoft.com";
const GET_HOSTS_PUBLIC = ["learn.microsoft.com", "github.com", "api.github.com", "raw.githubusercontent.com"];

async function getText(ctx: Ctx, url: string, headers: Record<string, string>): Promise<{ status: number; text: string }> {
  const res = await ctx.fetch(url, { method: "GET", headers: { Accept: "application/json", ...headers } });
  return { status: res.status, text: await res.text() };
}

const parse = (text: string): unknown => {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return undefined;
  }
};

// ---- Fabric --------------------------------------------------------------------------------------

async function fabricGet(ctx: Ctx, path: string): Promise<{ status: number; data: unknown }> {
  const { makeClient } = await import("../commands/fabric.js");
  const client = makeClient(ctx, {});
  try {
    const r = await client.request("GET", path);
    return { status: r.status, data: r.data };
  } catch (e) {
    if (e instanceof FabricHttpError) return { status: e.status, data: undefined };
    throw e;
  }
}

const NO_SAFE_WORKSPACE = "geef --workspace of maak een aihub-test-dev-workspace (zonder --workspace gebruikt een probe alleen een workspace die met aihub-test-dev begint)";

class NoSafeWorkspace extends Error {}

const noSafeWorkspace = (probe: string): ProbeResult => ({ probe, answer: "unknown", status: null, meaning: NO_SAFE_WORKSPACE, readOnly: true });

async function workspaceId(ctx: Ctx, name: string | undefined): Promise<{ id: string; name: string }> {
  const { makeClient } = await import("../commands/fabric.js");
  const all = await makeClient(ctx, {}).workspaces();
  if (name) {
    const hit = all.find((w) => w.id === name || w.displayName.toLowerCase() === name.toLowerCase());
    if (!hit) throw new AihubError(`Fabric workspace '${name}' not found for your account`);
    return { id: hit.id, name: hit.displayName };
  }
  // never "the first workspace the account sees": that could be a real one. Only a test workspace is used by default.
  const pick = all.find((w) => /^aihub-test-dev/i.test(w.displayName));
  if (!pick) throw new NoSafeWorkspace();
  return { id: pick.id, name: pick.displayName };
}

/** Item-type list endpoints that tell whether a Fabric feature exists for a workspace's capacity. */
export const FABRIC_FEATURES: Record<string, { path: string; what: string }> = {
  spark: { path: "/workspaces/{ws}/spark/settings", what: "Spark workspace settings (Spark compute available)" },
  notebooks: { path: "/workspaces/{ws}/notebooks", what: "Notebooks" },
  copyjob: { path: "/workspaces/{ws}/copyJobs", what: "Copy job items" },
  mirroring: { path: "/workspaces/{ws}/mirroredDatabases", what: "Mirrored databases" },
  graphql: { path: "/workspaces/{ws}/GraphQLApis", what: "API for GraphQL items" },
  variablelibrary: { path: "/workspaces/{ws}/VariableLibraries", what: "Variable libraries" },
  pipelines: { path: "/workspaces/{ws}/dataPipelines", what: "Data pipelines" },
  lakehouse: { path: "/workspaces/{ws}/lakehouses", what: "Lakehouses" },
  warehouse: { path: "/workspaces/{ws}/warehouses", what: "Warehouses" },
  eventstream: { path: "/workspaces/{ws}/eventstreams", what: "Eventstreams" },
  gitintegration: { path: "/workspaces/{ws}/git/connection", what: "Git integration of the workspace" },
};

/**
 * A path as the user or an agent typed it: with or without the leading slash or /v1, or as a full URL. Git Bash on Windows
 * turns a leading "/workspaces/..." into "C:/Program Files/Git/workspaces/..." before the program sees it; that prefix is removed.
 */
export function normalizeFabricPath(raw: string): string {
  let p = raw.trim().replace(/^[A-Za-z]:[\/]Program Files[\/]Git/i, "");
  if (!p) throw new AihubError("usage: aihub probe fabric endpoint <path>   (for example workspaces/{workspace}/notebooks)");
  p = p.replace(/^https:\/\/api\.fabric\.microsoft\.com\/v1/i, "").replace(/^\/?v1(?=\/)/, "");
  return p.startsWith("/") ? p : `/${p}`;
}

/** `aihub probe fabric endpoint <path>`: one GET. `{workspace}` (or {workspaceId}) in the path becomes the id of --workspace. */
export async function probeFabricEndpoint(ctx: Ctx, rawPath: string, o: { workspace?: string }): Promise<ProbeResult> {
  let path = normalizeFabricPath(rawPath);
  if (/\{workspace[A-Za-z_]*\}/.test(path)) {
    try {
      const w = await workspaceId(ctx, o.workspace);
      path = path.replace(/\{workspace[A-Za-z_]*\}/g, w.id);
    } catch (e) {
      if (e instanceof NoSafeWorkspace) return noSafeWorkspace(`fabric GET /v1${path}`);
      throw e;
    }
  }
  const { status, data } = await fabricGet(ctx, path);
  const i = interpret(status);
  return { probe: `fabric GET /v1${redact(path)}`, answer: i.answer, status, meaning: i.meaning, ...(data !== undefined ? { shape: shapeOf(data) } : {}), readOnly: true };
}

/** `aihub probe fabric capacity [--feature spark|copyjob|...]`: the capacities you can see (SKU, region, state) and, per feature, whether the item type exists. */
export async function probeFabricCapacity(ctx: Ctx, o: { feature?: string; workspace?: string }): Promise<ProbeResult> {
  const caps = await fabricGet(ctx, "/capacities");
  const list = ((caps.data as { value?: { displayName?: string; sku?: string; region?: string; state?: string }[] } | undefined)?.value ?? []).map((c) => ({ name: c.displayName, sku: c.sku, region: c.region, state: c.state }));
  if (!o.feature) {
    const i = interpret(caps.status);
    return { probe: "fabric GET /v1/capacities", answer: i.answer, status: caps.status, meaning: i.meaning, shape: shapeOf(caps.data), facts: { capacities: list }, readOnly: true };
  }
  const f = FABRIC_FEATURES[o.feature.toLowerCase()];
  if (!f) throw new AihubError(`unknown feature '${o.feature}'; known: ${Object.keys(FABRIC_FEATURES).join(", ")}`);
  let w: { id: string; name: string };
  try {
    w = await workspaceId(ctx, o.workspace);
  } catch (e) {
    if (e instanceof NoSafeWorkspace) return { ...noSafeWorkspace(`fabric feature ${o.feature} (${f.what})`), facts: { capacities: list } };
    throw e;
  }
  const { status, data } = await fabricGet(ctx, f.path.replace("{ws}", w.id));
  const i = interpret(status);
  return {
    probe: `fabric feature ${o.feature} (${f.what}) in workspace ${w.name}`,
    answer: i.answer,
    status,
    meaning: i.meaning,
    ...(data !== undefined ? { shape: shapeOf(data) } : {}),
    facts: { checkedInWorkspace: w.name, capacities: list },
    readOnly: true,
  };
}

// ---- Azure DevOps --------------------------------------------------------------------------------

/** Project-level endpoints that tell whether an Azure DevOps feature is on for the project. */
export const DEVOPS_FEATURES: Record<string, { path: string; what: string; org?: boolean; version?: string }> = {
  pipelines: { path: "pipelines", what: "YAML pipelines" },
  builds: { path: "build/definitions", what: "Build definitions" },
  releases: { path: "release/definitions", what: "Classic release pipelines" },
  environments: { path: "distributedtask/environments", what: "Pipeline environments", version: "7.1-preview.1" },
  wiki: { path: "wiki/wikis", what: "Project wikis" },
  boards: { path: "wit/workitemtypes", what: "Work item tracking" },
  testplans: { path: "testplan/plans", what: "Test plans", version: "7.1-preview.1" },
  policy: { path: "policy/configurations", what: "Branch policies" },
  variablegroups: { path: "distributedtask/variablegroups", what: "Variable groups", version: "7.1-preview.2" },
  serviceconnections: { path: "serviceendpoint/endpoints", what: "Service connections", version: "7.1-preview.4" },
  identity: { path: "connectionData", what: "Who you are (the signed-in identity)", org: true, version: "7.1-preview.1" },
};

export async function probeDevops(ctx: Ctx, name: string): Promise<ProbeResult> {
  const f = DEVOPS_FEATURES[name.toLowerCase()];
  if (!f) throw new AihubError(`unknown devops feature '${name}'; known: ${Object.keys(DEVOPS_FEATURES).join(", ")}`);
  const { client } = repoClient(ctx);
  const r = client.remote;
  const auth = makeAuth({ env: ctx.env, exec: ctx.exec, cacheFile: ctx.tokenCache });
  const base = f.org ? r.orgUrl : `${r.orgUrl}/${encodeURIComponent(r.project)}`;
  const url = `${base}/_apis/${f.path}?api-version=${f.version ?? "7.1"}`;
  const res = await getText(ctx, url, { Authorization: await auth() });
  let status = res.status;
  if (status === 203 || (status === 200 && /^\s*</.test(res.text))) status = 401; // ADO answers a bad credential with an HTML sign-in page
  const i = interpret(status);
  const data = parse(res.text);
  const facts: Record<string, unknown> = {};
  if (name === "identity" && data && typeof data === "object") {
    const u = (data as { authenticatedUser?: { providerDisplayName?: string; id?: string } }).authenticatedUser;
    if (u) facts.signedInAs = u.providerDisplayName;
  }
  return { probe: `devops ${name} (${f.what}) in ${r.project}`, answer: i.answer, status, meaning: i.meaning, ...(data !== undefined && name !== "identity" ? { shape: shapeOf(data) } : {}), ...(Object.keys(facts).length ? { facts } : {}), readOnly: true };
}

// ---- any allowed URL -----------------------------------------------------------------------------

/**
 * `aihub probe api --get <url>`: Fabric and Azure DevOps URLs use your own sign-in and show status and shape only;
 * a few public documentation hosts are fetched without credentials and show a short text excerpt.
 */
export async function probeApi(ctx: Ctx, rawUrl: string): Promise<ProbeResult> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new AihubError(`not a URL: ${rawUrl}`);
  }
  if (u.protocol !== "https:") throw new AihubError("only https URLs");
  const host = u.hostname.toLowerCase();
  if (host === "api.fabric.microsoft.com") {
    const path = u.pathname.replace(/^\/v1/, "") + u.search;
    const { status, data } = await fabricGet(ctx, path);
    const i = interpret(status);
    return { probe: `GET ${u.origin}${u.pathname}`, answer: i.answer, status, meaning: i.meaning, ...(data !== undefined ? { shape: shapeOf(data) } : {}), readOnly: true };
  }
  if (host === "dev.azure.com" || host.endsWith(".dev.azure.com") || host.endsWith(".visualstudio.com")) {
    const auth = makeAuth({ env: ctx.env, exec: ctx.exec, cacheFile: ctx.tokenCache });
    const res = await getText(ctx, u.toString(), { Authorization: await auth() });
    let status = res.status;
    if (status === 203 || (status === 200 && /^\s*</.test(res.text))) status = 401;
    const i = interpret(status);
    const data = parse(res.text);
    return { probe: `GET ${u.origin}${u.pathname}`, answer: i.answer, status, meaning: i.meaning, ...(data !== undefined ? { shape: shapeOf(data) } : {}), readOnly: true };
  }
  if (GET_HOSTS_PUBLIC.includes(host)) {
    const res = await getText(ctx, u.toString(), { Accept: "text/html,application/json" });
    const i = interpret(res.status);
    const excerpt = redact(res.text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 600));
    return { probe: `GET ${u.origin}${u.pathname}`, answer: i.answer, status: res.status, meaning: i.meaning, facts: { excerpt }, readOnly: true };
  }
  throw new AihubError(`host ${host} is not allowed. Allowed: api.fabric.microsoft.com, dev.azure.com, ${GET_HOSTS_PUBLIC.join(", ")}`);
}

