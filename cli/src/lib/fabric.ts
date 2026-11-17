import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultExec, type Exec } from "./auth.js";
import { AihubError } from "./errors.js";
import { anyGlob } from "./glob.js";
import type { TeamConfig } from "./team.js";

export const FABRIC_API = "https://api.fabric.microsoft.com/v1";
export const FABRIC_RESOURCE = "https://api.fabric.microsoft.com";

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
}

export const jobTypeFor = (t: string): PlanItem["jobType"] => (t === "Notebook" ? "RunNotebook" : t === "DataPipeline" ? "Pipeline" : undefined);

/** Map changed paths to Fabric items using the git-integration folder convention `<name>.<Type>/`. */
export function mapItems(files: string[]): PlanItem[] {
  const re = new RegExp(`(?:^|/)([^/]+)\\.(${ITEM_TYPES.join("|")})(?:/|$)`);
  const found = new Map<string, PlanItem>();
  for (const f of files) {
    const m = re.exec(f.replace(/\\/g, "/"));
    if (!m) continue;
    const type = m[2] as ItemType;
    const key = `${type}:${m[1]}`;
    const cur = found.get(key) ?? { name: m[1], type, jobType: jobTypeFor(type), files: 0 };
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
}

export function workspaceGroups(team: TeamConfig): Record<string, string[]> {
  const g = (team as { fabric?: { workspaceGroups?: Record<string, string[]> } }).fabric?.workspaceGroups;
  return g && typeof g === "object" ? g : {};
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
    const w = chooseWorkspace(list, { workspace: n });
    if (!w) throw new AihubError(`workspace '${n}' is not in team.yaml fabric.workspaces; the CLI only runs workspaces the team listed`);
    if (!out.includes(w)) out.push(w);
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
  if (!p.items.length) {
    lines.push("No Fabric items changed: nothing to run in Fabric.");
    return lines.join("\n");
  }
  let n = 0;
  for (const it of p.items) {
    const all = p.workspaces.length > 1 ? p.workspaces.map((w) => ` --workspace ${w.name}`).join("") : "";
    const how = it.jobType ? `run: aihub fabric run --item ${it.name}${all} --wait` : "deploy only (nothing to run)";
    lines.push(`${++n}. ${it.type} ${it.name} (${it.files} file${it.files === 1 ? "" : "s"}): ${how}`);
  }
  return lines.join("\n");
}

// ---- guard -----------------------------------------------------------------

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
}

export function makeFabricAuth(deps: FabricAuthDeps): () => Promise<string> {
  const exec = deps.exec ?? defaultExec;
  const now = deps.now ?? Date.now;
  const cacheFile = deps.cacheFile ?? join(tmpdir(), "aihub-fabric-token.json");
  let cached: string | undefined;
  return async () => {
    if (cached) return cached;
    if (deps.env.AIHUB_FABRIC_TOKEN) return (cached = `Bearer ${deps.env.AIHUB_FABRIC_TOKEN}`);
    try {
      if (existsSync(cacheFile)) {
        const c = JSON.parse(readFileSync(cacheFile, "utf8")) as { token: string; expiresAt: number };
        if (c.token && c.expiresAt - 120_000 > now()) return (cached = `Bearer ${c.token}`);
      }
    } catch {
      /* ignore a broken cache */
    }
    try {
      const j = JSON.parse(exec("az", ["account", "get-access-token", "--resource", FABRIC_RESOURCE, "--output", "json"])) as {
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
}
export interface JobInstance {
  id: string;
  status: string;
  startTimeUtc?: string;
  endTimeUtc?: string;
  failureReason?: { errorCode?: string; message?: string };
}

export class FabricClient {
  constructor(
    private readonly auth: () => Promise<string>,
    private readonly fetchFn: typeof fetch,
  ) {}

  async request(method: string, path: string, body?: unknown): Promise<{ status: number; data: any; headers: Headers }> {
    const res = await this.fetchFn(`${FABRIC_API}${path}`, {
      method,
      headers: {
        Authorization: await this.auth(),
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (res.status === 401) throw new AihubError("not signed in to Fabric: run 'az login' or set AIHUB_FABRIC_TOKEN");
    if (!res.ok) {
      let detail = "";
      try {
        const j = JSON.parse(text) as { message?: string; errorCode?: string };
        detail = j.message ?? j.errorCode ?? "";
      } catch {
        detail = text.slice(0, 200);
      }
      if (res.status === 403) throw new AihubError(`Fabric denied access (403): your account needs access to this workspace${detail ? ` (${detail})` : ""}`);
      throw new AihubError(`Fabric ${method} ${path.split("?")[0]} failed (${res.status})${detail ? `: ${detail}` : ""}`);
    }
    let data: any = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      /* non-JSON body */
    }
    return { status: res.status, data, headers: res.headers };
  }

  async workspaceId(w: FabricWorkspace): Promise<string> {
    if (w.id) return w.id;
    if (isGuid(w.name)) return w.name;
    const r = await this.request("GET", "/workspaces");
    const hit = (r.data.value as { id: string; displayName: string }[] | undefined)?.find((x) => x.displayName.toLowerCase() === w.name.toLowerCase());
    if (!hit) throw new AihubError(`Fabric workspace '${w.name}' not found for your account`);
    return hit.id;
  }

  async resolveItem(wsId: string, item: string): Promise<FabricItem> {
    const r = await this.request("GET", `/workspaces/${wsId}/items`);
    const items = (r.data.value ?? []) as FabricItem[];
    const hits = items.filter((i) => i.id.toLowerCase() === item.toLowerCase() || i.displayName.toLowerCase() === item.toLowerCase());
    if (!hits.length) throw new AihubError(`item '${item}' not found in this workspace`);
    if (hits.length > 1) throw new AihubError(`item name '${item}' is ambiguous (${hits.map((h) => h.type).join(", ")}); pass the item id`);
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
  return lines.join("\n");
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
