import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultExec, type Exec } from "./auth.js";
import { AihubError } from "./errors.js";
import { redact } from "./fabric-redact.js";
import { anyGlob } from "./glob.js";
import type { TeamConfig } from "./team.js";

export const FABRIC_API = "https://api.fabric.microsoft.com/v1";
export const FABRIC_RESOURCE = "https://api.fabric.microsoft.com";
export const ONELAKE_RESOURCE = "https://storage.azure.com";

export type Env = "dev" | "feature" | "test" | "acc" | "prd";
export const ENVS: Env[] = ["dev", "feature", "test", "acc", "prd"];
/** Environments the CLI may run in without an explicit --allow-env. */
const SAFE_ENVS: Env[] = ["dev", "feature"];

export interface FabricWorkspace {
  name: string;
  id?: string;
  environment: Env;
  /** Branch patterns whose changes are tested in this workspace. */
  branches?: string[];
  /** Name of a registered service principal this workspace is accessed with (the secret lives in the user config, never here). */
  servicePrincipal?: string;
}

export function fabricWorkspaces(team: TeamConfig): FabricWorkspace[] {
  const f = (team as { fabric?: { workspaces?: Partial<FabricWorkspace>[] } }).fabric;
  return (f?.workspaces ?? [])
    .filter((w) => !!w?.name && ENVS.includes(String(w.environment).toLowerCase() as Env))
    .map((w) => ({ ...w, environment: String(w.environment).toLowerCase() as Env }) as FabricWorkspace);
}

// ---- plan ------------------------------------------------------------------

export type ItemType = "Notebook" | "DataPipeline" | "Lakehouse" | "Warehouse" | "Environment" | "VariableLibrary" | "Dataflow" | "SemanticModel" | "Report";
const ITEM_TYPES: ItemType[] = ["Notebook", "DataPipeline", "Lakehouse", "Warehouse", "Environment", "VariableLibrary", "Dataflow", "SemanticModel", "Report"];
/** Dependencies first, then things that run. */
const ORDER: ItemType[] = ["Environment", "VariableLibrary", "Lakehouse", "Warehouse", "Dataflow", "Notebook", "DataPipeline", "SemanticModel", "Report"];

export interface PlanItem {
  name: string;
  type: ItemType;
  /** Fabric job type when the item can run on demand. */
  jobType?: "RunNotebook" | "Pipeline";
  files: number;
  /** Repository folder of the item (`fabric/nb.Notebook`), the source for create/update. */
  dir: string;
  /** Set by `plan --check-workspace`: does the item exist in the chosen workspace? */
  inWorkspace?: boolean;
  /** Set when the item is in the plan because it calls a changed item: that item, and the calling activity. */
  via?: string;
  activity?: string;
  /** Functions of a User Data Functions item. */
  functions?: string[];
  /** dbt model files that changed (for a dbt job item). */
  note?: string;
}

export const jobTypeFor = (t: string): PlanItem["jobType"] => (t === "Notebook" ? "RunNotebook" : t === "DataPipeline" ? "Pipeline" : undefined);

/** Map changed paths to Fabric items using the git-integration folder convention `<name>.<Type>/`. */
export function mapItems(files: string[]): PlanItem[] {
  const re = new RegExp(`^((?:[^/]+/)*?([^/]+)\\.(${ITEM_TYPES.join("|")}))(?:/|$)`);
  const found = new Map<string, PlanItem>();
  for (const f of files) {
    const m = re.exec(f.replace(/\\/g, "/"));
    if (!m) continue;
    const type = m[3] as ItemType;
    const key = `${type}:${m[2]}`;
    const cur = found.get(key) ?? { name: m[2], type, jobType: jobTypeFor(type), files: 0, dir: m[1] };
    cur.files++;
    found.set(key, cur);
  }
  return [...found.values()].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type) || a.name.localeCompare(b.name));
}

const isGuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** Workspace for a request: explicit name/id, else the branch rules, else the first feature, else the first dev workspace. */
export function chooseWorkspace(list: FabricWorkspace[], opts: { branch?: string; workspace?: string }): FabricWorkspace | undefined {
  if (opts.workspace) {
    const w = opts.workspace.toLowerCase();
    return list.find((x) => x.name.toLowerCase() === w || x.id?.toLowerCase() === w);
  }
  const byBranch = opts.branch ? list.find((x) => x.branches && anyGlob(x.branches, opts.branch!)) : undefined;
  return byBranch ?? list.find((x) => x.environment === "feature") ?? list.find((x) => x.environment === "dev");
}

export interface Plan {
  workspace?: FabricWorkspace;
  /** Every workspace that applies to the branch (several when more than one branch rule matches). */
  workspaces: FabricWorkspace[];
  items: PlanItem[];
  /** How the branch is tested (legacy test strategy): fabric-api, azure-devops-integration, robot-integration or blocked, with the reason. */
  strategy?: string;
}

type GroupDef = string[] | { workspaces?: string[]; servicePrincipal?: string };
const groupsOf = (team: TeamConfig): Record<string, GroupDef> => {
  const g = (team as { fabric?: { workspaceGroups?: Record<string, GroupDef> } }).fabric?.workspaceGroups;
  return g && typeof g === "object" ? g : {};
};

/** Named workspace shortcuts: `devs: [a, b]` or `devs: { workspaces: [a, b], servicePrincipal: ci }`. */
export function workspaceGroups(team: TeamConfig): Record<string, string[]> {
  return Object.fromEntries(Object.entries(groupsOf(team)).map(([k, v]) => [k, Array.isArray(v) ? v : (v?.workspaces ?? [])]));
}

/** The service principal a group is accessed with (only the registered name; the secret is in the user config). */
export function groupServicePrincipals(team: TeamConfig): Record<string, string> {
  return Object.fromEntries(Object.entries(groupsOf(team)).flatMap(([k, v]) => (!Array.isArray(v) && v?.servicePrincipal ? [[k.toLowerCase(), v.servicePrincipal]] : [])));
}

/** All workspaces whose branch rules match the branch. */
export function matchingWorkspaces(list: FabricWorkspace[], branch?: string): FabricWorkspace[] {
  return branch ? list.filter((x) => x.branches && anyGlob(x.branches, branch)) : [];
}

/**
 * Workspaces for a run: explicit names/ids and/or a group from team.yaml, else the default choice.
 * Unknown names and groups are refused. Duplicates are dropped.
 */
export function selectWorkspaces(
  list: FabricWorkspace[],
  groups: Record<string, string[]>,
  opts: { workspaces?: string[]; group?: string; branch?: string },
): FabricWorkspace[] {
  const names = [...(opts.workspaces ?? [])];
  if (opts.group) {
    const key = Object.keys(groups).find((k) => k.toLowerCase() === opts.group!.toLowerCase());
    if (!key) throw new AihubError(`workspace group '${opts.group}' is not in team.yaml fabric.workspaceGroups (${Object.keys(groups).join(", ") || "none"})`);
    names.push(...groups[key]);
  }
  if (!names.length) {
    const w = chooseWorkspace(list, { branch: opts.branch });
    return w ? [w] : [];
  }
  const out: FabricWorkspace[] = [];
  for (const n of names) {
    // a workspace that team.yaml does not list is still usable: the signed-in user's access decides, the name decides ACC/PRD
    const w = chooseWorkspace(list, { workspace: n }) ?? { name: n, environment: inferEnv(n) };
    if (!out.some((o) => o.name === w.name)) out.push(w);
  }
  return out;
}

export function buildPlan(files: string[], list: FabricWorkspace[], opts: { branch?: string; workspace?: string }): Plan {
  const first = chooseWorkspace(list, opts);
  const matched = opts.workspace ? [] : matchingWorkspaces(list, opts.branch);
  return { workspace: first, workspaces: matched.length > 1 ? matched : first ? [first] : [], items: mapItems(files) };
}

export function formatPlan(p: Plan, branch: string, target: string): string {
  const lines = [`Fabric plan for ${branch} (vs ${target}):`];
  if (p.workspaces.length > 1) lines.push(`workspaces (branch rules): ${p.workspaces.map((w) => `${w.name} (${w.environment})`).join(", ")}`);
  else
    lines.push(
      p.workspace
        ? `workspace: ${p.workspace.name} (${p.workspace.environment})`
        : "workspace: none found in team.yaml fabric.workspaces; pass --workspace <name|id>",
    );
  if (p.strategy) lines.push(`strategy: ${p.strategy}`);
  if (!p.items.length) {
    lines.push("No Fabric items changed: nothing to run in Fabric.");
    return lines.join("\n");
  }
  let n = 0;
  for (const it of p.items) {
    const all = p.workspaces.length > 1 ? p.workspaces.map((w) => ` --workspace ${w.name}`).join("") : "";
    const how = it.jobType ? `run: aihub fabric run --item ${it.name}${all} --wait` : "nothing to run";
    lines.push(`${++n}. ${it.type} ${it.name} (${it.via ? `calls changed ${it.via}${it.activity ? ` in activity ${it.activity}` : ""}` : `${it.files} file${it.files === 1 ? "" : "s"}`}): ${how}`);
    if (it.functions?.length) lines.push(`   functions: ${it.functions.join(", ")}`);
    if (it.note) lines.push(`   ${it.note}`);
    const ws = p.workspace ? ` --workspace ${p.workspace.name}` : "";
    const create = `aihub fabric item create${ws} --type ${it.type} --name ${it.name} --definition-dir ${it.dir}`;
    const update = `aihub fabric item update${ws} --item ${it.name} --type ${it.type} --definition-dir ${it.dir}`;
    if (it.inWorkspace === true) lines.push(`   in workspace: yes; update first: ${update}`);
    else if (it.inWorkspace === false) lines.push(`   in workspace: no; create first: ${create}`);
    else lines.push(`   deploy: ${update} (new item: ${create}; add --check-workspace to know which)`);
  }
  return lines.join("\n");
}

// ---- guard -----------------------------------------------------------------

/** Stage from a workspace name: only acc/prd are recognised (a name such as DEV-test-project stays dev). */
export function inferEnv(name: string): Env {
  if (/(^|[^a-z0-9])(prd|prod|production|productie)([^a-z0-9]|$)/i.test(name)) return "prd";
  if (/(^|[^a-z0-9])(acc|acceptance|acceptatie|acpt|uat)([^a-z0-9]|$)/i.test(name)) return "acc";
  return "dev";
}

export function guardEnv(w: FabricWorkspace, allowEnv: string | undefined): void {
  if (SAFE_ENVS.includes(w.environment)) return;
  if (allowEnv && allowEnv.toLowerCase() === w.environment) return;
  const E = w.environment.toUpperCase();
  throw new AihubError(`workspace '${w.name}' is ${E}: the developer runs ${E}, the CLI only runs dev/feature (--allow-env ${w.environment} only when the developer asked for it)`);
}

// ---- auth ------------------------------------------------------------------

export interface FabricAuthDeps {
  env: NodeJS.ProcessEnv;
  exec?: Exec;
  cacheFile?: string;
  now?: () => number;
  /** Token audience (default Fabric); OneLake uses https://storage.azure.com. */
  resource?: string;
  /** Environment variable that overrides the token (default AIHUB_FABRIC_TOKEN). */
  tokenVar?: string;
}

export function makeFabricAuth(deps: FabricAuthDeps): () => Promise<string> {
  const exec = deps.exec ?? defaultExec;
  const now = deps.now ?? Date.now;
  const resource = deps.resource ?? FABRIC_RESOURCE;
  const tokenVar = deps.tokenVar ?? "AIHUB_FABRIC_TOKEN";
  const cacheFile = deps.cacheFile ?? join(tmpdir(), resource === FABRIC_RESOURCE ? "aihub-fabric-token.json" : resource === ONELAKE_RESOURCE ? "aihub-onelake-token.json" : `aihub-token-${resource.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}.json`);
  let cached: string | undefined;
  return async () => {
    if (cached) return cached;
    if (deps.env[tokenVar]) return (cached = `Bearer ${deps.env[tokenVar]}`);
    try {
      if (existsSync(cacheFile)) {
        const c = JSON.parse(readFileSync(cacheFile, "utf8")) as { token: string; expiresAt: number };
        if (c.token && c.expiresAt - 120_000 > now()) return (cached = `Bearer ${c.token}`);
      }
    } catch {
      /* ignore a broken cache */
    }
    try {
      const j = JSON.parse(exec("az", ["account", "get-access-token", "--resource", resource, "--output", "json"])) as {
        accessToken: string;
        expires_on?: number | string;
        expiresOn?: string;
      };
      const expiresAt = j.expires_on ? Number(j.expires_on) * 1000 : Date.parse(j.expiresOn ?? "") || now() + 30 * 60_000;
      try {
        writeFileSync(cacheFile, JSON.stringify({ token: j.accessToken, expiresAt }), { mode: 0o600 });
      } catch {
        /* cache is optional */
      }
      return (cached = `Bearer ${j.accessToken}`);
    } catch {
      throw new AihubError("not signed in to Fabric: run 'az login' or set AIHUB_FABRIC_TOKEN");
    }
  };
}

// ---- client ----------------------------------------------------------------

export interface FabricItem {
  id: string;
  displayName: string;
  type: string;
  description?: string;
  workspaceId?: string;
}
export interface JobInstance {
  id: string;
  itemId?: string;
  jobType?: string;
  invokeType?: string;
  status: string;
  startTimeUtc?: string;
  endTimeUtc?: string;
  failureReason?: { errorCode?: string; message?: string };
}

/** A Fabric REST failure with its HTTP status, so callers can fall back when an endpoint is not available. */
export class FabricHttpError extends AihubError {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface FabricClientOpts {
  sleep?: (ms: number) => Promise<void>;
  /** 0 skips every wait (tests); 1 honours Retry-After. */
  waitScale?: number;
  maxRetries?: number;
  /** Auth for OneLake (storage) calls. */
  storageAuth?: () => Promise<string>;
  /** Auth for the Power BI REST API (refresh history). */
  powerbiAuth?: () => Promise<string>;
  /** Auth for Kusto (KQL database query service). */
  kustoAuth?: () => Promise<string>;
  /** The identity behind the three auth functions (for hints and reporting). */
  identity?: import("./fabric-auth.js").FabricIdentity;
}

export interface Res {
  status: number;
  data: any;
  headers: Headers;
  text: string;
}

/** "Did you mean": names that contain the wanted text or share its start, best first. */
export function didYouMean(wanted: string, names: string[], max = 3): string[] {
  const w = wanted.toLowerCase();
  const score = (n: string) => {
    const l = n.toLowerCase();
    if (l.includes(w) || w.includes(l)) return 3;
    let p = 0;
    while (p < l.length && p < w.length && l[p] === w[p]) p++;
    if (p >= 3) return 2;
    const tokens = w.split(/[^a-z0-9]+/).filter((t) => t.length > 2);
    return tokens.some((t) => l.includes(t)) ? 1 : 0;
  };
  return names
    .map((n) => ({ n, s: score(n) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.n.localeCompare(b.n))
    .slice(0, max)
    .map((x) => x.n);
}

const hint = (wanted: string, names: string[]) => {
  const d = didYouMean(wanted, names);
  return d.length ? `; did you mean: ${d.join(", ")}?` : "";
};

export class FabricClient {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly scale: number;
  private readonly maxRetries: number;
  get identity() {
    return this.opts.identity;
  }
  constructor(
    private readonly auth: () => Promise<string>,
    private readonly fetchFn: typeof fetch,
    private readonly opts: FabricClientOpts = {},
  ) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.scale = opts.waitScale ?? 1;
    this.maxRetries = opts.maxRetries ?? 5;
  }

  wait(ms: number): Promise<void> {
    return this.scale === 0 ? Promise.resolve() : this.sleep(ms * this.scale);
  }

  /** One HTTP call with 429 back-off (Retry-After, else exponential). `path` may be an absolute URL (OneLake). */
  async request(method: string, path: string, body?: unknown, o: { storage?: boolean; powerbi?: boolean; kusto?: boolean; accept?: string; raw?: string | Uint8Array; headers?: Record<string, string> } = {}): Promise<Res> {
    const url = /^https?:\/\//.test(path) ? path : `${FABRIC_API}${path}`;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchFn(url, {
        method,
        headers: {
          Authorization: await (o.storage && this.opts.storageAuth ? this.opts.storageAuth() : o.powerbi && this.opts.powerbiAuth ? this.opts.powerbiAuth() : o.kusto && this.opts.kustoAuth ? this.opts.kustoAuth() : this.auth()),
          Accept: o.accept ?? "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(o.headers ?? {}),
        },
        body: o.raw !== undefined ? (o.raw as BodyInit) : body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      if (res.status === 429 && attempt < this.maxRetries) {
        const ra = Number(res.headers.get("retry-after"));
        await this.wait((Number.isFinite(ra) && ra > 0 ? ra : 2 ** attempt) * 1000);
        continue;
      }
      if (res.status === 401) throw new FabricHttpError("not signed in to Fabric: run 'az login' or set AIHUB_FABRIC_TOKEN", 401);
      if (!res.ok) {
        let detail = "";
        try {
          const j = JSON.parse(text) as { message?: string; errorCode?: string; error?: { message?: string } };
          detail = redact(j.message ?? j.error?.message ?? j.errorCode ?? "");
        } catch {
          detail = redact(text.slice(0, 200));
        }
        if (res.status === 403) throw new FabricHttpError(`Fabric denied access (403): your account needs access to this workspace${detail ? ` (${detail})` : ""}`, 403);
        if (res.status === 429) throw new FabricHttpError(`Fabric kept answering 429 (too many requests) after ${this.maxRetries} retries; try again in a minute`, 429);
        throw new FabricHttpError(`Fabric ${method} ${path.split("?")[0]} failed (${res.status})${detail ? `: ${detail}` : ""}`, res.status);
      }
      let data: any = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        /* non-JSON body */
      }
      return { status: res.status, data, headers: res.headers, text };
    }
  }

  /** All pages of a list endpoint (continuationToken); the array is `value` or `data`. */
  async list<T = any>(path: string, o: { key?: string; powerbi?: boolean } = {}): Promise<T[]> {
    const out: T[] = [];
    let token: string | undefined;
    for (let page = 0; page < 500; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const r = await this.request("GET", token ? `${path}${sep}continuationToken=${encodeURIComponent(token)}` : path, undefined, { powerbi: o.powerbi });
      out.push(...(((o.key ? r.data[o.key] : (r.data.value ?? r.data.data)) as T[] | undefined) ?? []));
      token = r.data.continuationToken || undefined;
      if (!token) break;
    }
    return out;
  }

  /**
   * A call that may be a long-running operation: 202 + Location/x-ms-operation-id is polled until
   * Succeeded (then the result is fetched when there is one) or Failed.
   */
  async lro(method: string, path: string, body?: unknown, o: { powerbi?: boolean } = {}): Promise<{ status: number; data: any; headers: Headers }> {
    const first = await this.request(method, path, body, { powerbi: o.powerbi });
    if (first.status !== 202) return first;
    const loc = first.headers.get("location") ?? "";
    const opId = first.headers.get("x-ms-operation-id") ?? /operations\/([^/?]+)/.exec(loc)?.[1];
    if (!opId) return first;
    let retry = Number(first.headers.get("retry-after")) || 1;
    for (let i = 0; i < 2000; i++) {
      await this.wait(retry * 1000);
      const st = await this.request("GET", `/operations/${opId}`);
      const s = String(st.data.status ?? "");
      if (/^succeeded$/i.test(s)) {
        try {
          const res = await this.request("GET", `/operations/${opId}/result`);
          return { status: 200, data: res.data, headers: res.headers };
        } catch (e) {
          if (e instanceof FabricHttpError && (e.status === 404 || e.status === 400)) return { status: 200, data: st.data, headers: st.headers };
          throw e;
        }
      }
      if (/^failed$/i.test(s)) {
        const er = st.data.error as { errorCode?: string; message?: string } | undefined;
        throw new AihubError(`Fabric operation ${opId} failed${er ? `: ${er.errorCode ?? ""} ${er.message ?? ""}`.trimEnd() : ""}`);
      }
      retry = Number(st.headers.get("retry-after")) || retry;
    }
    throw new AihubError(`Fabric operation ${opId} did not finish in time`);
  }

  async workspaces(): Promise<{ id: string; displayName: string; type?: string; capacityId?: string; description?: string }[]> {
    return this.list("/workspaces");
  }

  async workspaceId(w: FabricWorkspace): Promise<string> {
    if (w.id) return w.id;
    if (isGuid(w.name)) return w.name;
    const all = await this.workspaces();
    const hit = all.find((x) => x.displayName.toLowerCase() === w.name.toLowerCase());
    if (!hit) throw new AihubError(`Fabric workspace '${w.name}' not found for your account${hint(w.name, all.map((x) => x.displayName))}`);
    return hit.id;
  }

  async items(wsId: string, type?: string): Promise<FabricItem[]> {
    return this.list<FabricItem>(`/workspaces/${wsId}/items${type ? `?type=${encodeURIComponent(type)}` : ""}`);
  }

  async resolveItem(wsId: string, item: string, type?: string): Promise<FabricItem> {
    const items = await this.items(wsId);
    const pool = type ? items.filter((i) => i.type.toLowerCase() === type.toLowerCase()) : items;
    const hits = pool.filter((i) => i.id.toLowerCase() === item.toLowerCase() || i.displayName.toLowerCase() === item.toLowerCase());
    if (!hits.length) throw new AihubError(`item '${item}' not found in this workspace${hint(item, pool.map((i) => i.displayName))}`);
    if (hits.length > 1) throw new AihubError(`item name '${item}' is ambiguous (${hits.map((h) => h.type).join(", ")}); pass --type <Type> or the item id`);
    return hits[0];
  }

  async startJob(wsId: string, item: FabricItem, executionData?: unknown): Promise<string> {
    const jobType = jobTypeFor(item.type);
    if (!jobType) throw new AihubError(`${item.type} '${item.displayName}' cannot run on demand (only Notebook and DataPipeline)`);
    const r = await this.request("POST", `/workspaces/${wsId}/items/${item.id}/jobs/instances?jobType=${jobType}`, executionData ? { executionData } : undefined);
    const jobId = /instances\/([^/?]+)/.exec(r.headers.get("location") ?? "")?.[1];
    if (!jobId) throw new AihubError("Fabric accepted the job but returned no job id");
    return jobId;
  }

  async jobStatus(wsId: string, itemId: string, jobId: string): Promise<JobInstance> {
    const r = await this.request("GET", `/workspaces/${wsId}/items/${itemId}/jobs/instances/${jobId}`);
    return r.data as JobInstance;
  }

  async jobs(wsId: string, itemId: string): Promise<JobInstance[]> {
    return this.list<JobInstance>(`/workspaces/${wsId}/items/${itemId}/jobs/instances`);
  }

  async cancelJob(wsId: string, itemId: string, jobId: string): Promise<void> {
    await this.request("POST", `/workspaces/${wsId}/items/${itemId}/jobs/instances/${jobId}/cancel`);
  }
}

export const isDone = (s: string) => ["Completed", "Failed", "Cancelled", "Deduped"].includes(s);

export async function waitForJob(
  c: FabricClient,
  wsId: string,
  itemId: string,
  jobId: string,
  opts: { pollMs: number; timeoutMs?: number },
): Promise<JobInstance> {
  const deadline = Date.now() + (opts.timeoutMs ?? 6 * 3600_000);
  for (;;) {
    const j = await c.jobStatus(wsId, itemId, jobId);
    if (isDone(j.status)) return j;
    if (Date.now() > deadline) throw new AihubError(`job ${jobId} still ${j.status} after the timeout; check with: aihub fabric status --job ${jobId} --item ${itemId}`);
    await new Promise((r) => setTimeout(r, opts.pollMs));
  }
}

export function formatJob(j: JobInstance, itemName: string): string {
  const lines = [`job ${j.id}: ${j.status} (${itemName})`];
  if (j.startTimeUtc) lines.push(`started: ${j.startTimeUtc}${j.endTimeUtc ? `, ended: ${j.endTimeUtc}` : ""}`);
  if (j.status === "Failed") {
    const f = j.failureReason;
    lines.push(`failure: ${f?.errorCode ?? "unknown"}: ${(f?.message ?? "no details from Fabric").replace(/\s+/g, " ").trim()}`);
  }
  return redact(lines.join("\n"));
}

/** Parameter file: JSON map (`{"limit": 10}`) or `{"parameters": {...}}`, turned into Fabric executionData. */
export function executionDataFromParams(text: string, item: { type: string }): unknown {
  let j: any;
  try {
    j = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw new AihubError('--params-file must contain JSON, e.g. {"limit": 10}');
  }
  const map: Record<string, unknown> = j && typeof j === "object" && j.parameters && typeof j.parameters === "object" ? j.parameters : j;
  if (item.type === "DataPipeline") return { parameters: map };
  const typed: Record<string, { value: unknown; type: string }> = {};
  for (const [k, v] of Object.entries(map)) {
    if (v && typeof v === "object" && "value" in (v as object) && "type" in (v as object)) typed[k] = v as { value: unknown; type: string };
    else typed[k] = { value: v, type: typeof v === "boolean" ? "bool" : typeof v === "number" ? (Number.isInteger(v) ? "int" : "float") : "string" };
  }
  return { parameters: typed };
}
