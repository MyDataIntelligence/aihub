import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { changedFiles } from "../lib/changes.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import {
  buildPlan,
  jobTypeFor,
  type Plan,
  executionDataFromParams,
  fabricWorkspaces,
  FabricClient,
  FabricHttpError,
  formatJob,
  formatPlan,
  guardEnv,
  inferEnv,
  selectWorkspaces,
  workspaceGroups,
  groupServicePrincipals,
  type FabricItem,
  type FabricWorkspace,
  type JobInstance,
  type PlanItem,
  waitForJob,
  chooseWorkspace,
} from "../lib/fabric.js";
import { collectJobLogs, collectRefreshLogs, workspaceRuns } from "../lib/fabric-logs.js";
import { classifyError } from "../lib/fabric-diag.js";
import { clampLines, digestJob, formatDigest, WINDOW_BYTES, writeFullLog } from "../lib/fabric-digest.js";
import { CAPACITY_HINT, connectionWriteCmd, dbtCmd, failuresCmd, formatChain, resolveBranchWorkspace, livyCmd, notebookTestCmd, rootCause, sparkCmd, sqlCmd, udfCmd, type Link } from "./fabric-deep.js";
import { apiCmd, onelakeCmd, queryCmd } from "./fabric-api.js";
import { authCmd, capacitiesCmd, connectionsCmd, deploymentCmd, environmentCmd, lakehouseLoad, lakehouseMaintenance, schedulesCmd, shortcutsCmd, workspaceCmd } from "./fabric-extra.js";
import { fabricHelp, unknownCommand, usageOf } from "./fabric-help.js";
import { durationText, filterLines, formatSections, oneLine, parseSince, parseUtc, readDefinitionDir, toTable, writeDefinitionParts } from "../lib/fabric-ops.js";
import { git, repoRoot } from "../lib/git.js";
import { FabricIdentity, identityJson } from "../lib/fabric-auth.js";
import { redact } from "../lib/fabric-redact.js";
import { buildTestPlan, testStrategy } from "../lib/fabric-testplan.js";
import { loadTeam } from "../lib/team.js";
import { missingSetting } from "../lib/team-guide.js";

const OPTIONS = {
  branch: { type: "string" },
  target: { type: "string" },
  workspace: { type: "string", multiple: true },
  workspaces: { type: "string" },
  item: { type: "string" },
  job: { type: "string" },
  type: { type: "string" },
  name: { type: "string" },
  description: { type: "string" },
  filter: { type: "string" },
  top: { type: "string" },
  out: { type: "string" },
  format: { type: "string" },
  lakehouse: { type: "string" },
  path: { type: "string" },
  since: { type: "string" },
  status: { type: "string" },
  search: { type: "string" },
  tail: { type: "string" },
  cancel: { type: "string" },
  "definition-dir": { type: "string" },
  "message-file": { type: "string" },
  "params-file": { type: "string" },
  "allow-env": { type: "string" },
  "check-workspace": { type: "boolean" },
  "dry-run": { type: "boolean" },
  session: { type: "string" },
  "all-mine": { type: "boolean" },
  yes: { type: "boolean" },
  json: { type: "boolean" },
  wait: { type: "boolean" },
  "desired-commit": { type: "string" },
  "deployed-commit": { type: "string" },
  "log-type": { type: "string" },
  livy: { type: "string" },
  state: { type: "string" },
  view: { type: "string" },
  stage: { type: "string" },
  "stage-attempt": { type: "string" },
  "sql-id": { type: "string" },
  container: { type: "string" },
  code: { type: "string" },
  "code-file": { type: "string" },
  kind: { type: "string" },
  timeout: { type: "string" },
  context: { type: "string" },
  "confirm-name": { type: "string" },
  connection: { type: "string" },
  function: { type: "string" },
  "args-file": { type: "string" },
  source: { type: "string" },
  "source-file": { type: "string" },
  route: { type: "string" },
  "project-name": { type: "string" },
  folder: { type: "string" },
  schema: { type: "string" },
  warehouse: { type: "string" },
  command: { type: "string" },
  select: { type: "string" },
  exclude: { type: "string" },
  "folder-path": { type: "string" },
  project: { type: "string" },
  operation: { type: "string" },
  threads: { type: "string" },
  full: { type: "boolean" },
  errors: { type: "boolean" },
  cell: { type: "boolean" },
  "full-refresh": { type: "boolean" },
  "fail-fast": { type: "boolean" },
  sp: { type: "string" },
  tenant: { type: "string" },
  "client-id": { type: "string" },
  "secret-from-stdin": { type: "boolean" },
  cert: { type: "string" },
  keyvault: { type: "string" },
  clear: { type: "boolean" },
  arg: { type: "string", multiple: true },
  "body-file": { type: "string" },
  query: { type: "string" },
  "query-file": { type: "string" },
  variables: { type: "string" },
  to: { type: "string" },
  text: { type: "string" },
  file: { type: "string" },
  "max-bytes": { type: "string" },
  capacity: { type: "string" },
  table: { type: "string" },
  append: { type: "boolean" },
  retention: { type: "string" },
  staging: { type: "boolean" },
  pipeline: { type: "string" },
  "from-stage": { type: "string" },
  "to-stage": { type: "string" },
  note: { type: "string" },
  "job-type": { type: "string" },
  message: { type: "string" },
  replace: { type: "string", multiple: true },
  with: { type: "string", multiple: true },
  "replace-file": { type: "string" },
  "with-file": { type: "string" },
  set: { type: "string", multiple: true },
  part: { type: "string" },
  run: { type: "boolean" },
} as const;

export type V = Record<string, string | boolean | string[] | undefined>;

export interface Setup {
  /** Prefixes of per-branch workspaces: "<prefix> <branch label>" (team.yaml fabric.branchWorkspacePrefixes and repository names). */
  prefixes?: string[];
  /** Service principal per group name (lowercase), from team.yaml. */
  groupSp?: Record<string, string>;
  ctx: Ctx;
  v: V;
  root?: string;
  list: FabricWorkspace[];
  groups: Record<string, string[]>;
  branch?: string;
}

export interface Target {
  ws: FabricWorkspace;
  id: string;
  /** Not in team.yaml: only reads are allowed. */
  adhoc: boolean;
}

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    ctx.out(fabricHelp(sub === "help" ? rest[0] : undefined));
    return;
  }
  const p0 = rest.find((a) => !a.startsWith("-"));
  if (rest.includes("--help") || rest.includes("-h")) {
    ctx.out(usageOf(sub, p0) ?? unknownCommand(sub, p0));
    return;
  }
  let v: V;
  let pos: string[];
  try {
    const p = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true });
    v = p.values as V;
    pos = p.positionals;
  } catch (e) {
    // the first sentence of the parser's message and the usage line of this one command, not the whole manual
    const first = (e as Error).message.split(/\.\s/)[0].replace(/\.$/, "");
    throw new AihubError(`${first}\n${usageOf(sub, p0) ?? unknownCommand(sub, p0)}`);
  }
  const given = v.branch as string | undefined;

  let root: string | undefined;
  let list: FabricWorkspace[] = [];
  let groups: Record<string, string[]> = {};
  let prefixes: string[] = [];
  let groupSp: Record<string, string> = {};
  try {
    root = repoRoot(ctx.cwd);
    const team = loadTeam(root);
    list = fabricWorkspaces(team);
    groups = workspaceGroups(team);
    groupSp = groupServicePrincipals(team);
    prefixes = [...(((team as { fabric?: { branchWorkspacePrefixes?: string[] } }).fabric?.branchWorkspacePrefixes) ?? []), ...(((team as { repositories?: { name?: string }[] }).repositories ?? []).map((x) => x.name ?? "").filter(Boolean))];
  } catch (e) {
    // plan and run need the team file; the other commands work with an explicit --workspace name or id
    if (sub === "plan") throw e;
  }
  const branch = given ?? (root ? git(root, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true }).trim() : undefined);
  const s: Setup = { ctx, v, root, list, groups, branch, prefixes, groupSp };

  switch (sub) {
    case "plan":
      return planCmd(s);
    case "run":
    case "status":
      return runStatus(s, sub);
    case "workspaces":
      return workspacesCmd(s);
    case "items":
      return itemsCmd(s);
    case "jobs":
      return jobsCmd(s);
    case "logs":
      return logsCmd(s);
    case "item":
      switch (pos[0]) {
        case "show":
          return itemShow(s);
        case "definition":
          return itemDefinition(s);
        case "create":
          return itemCreate(s);
        case "update":
          return itemUpdate(s);
        case "rename":
          return itemRename(s);
        case "delete":
          return itemDelete(s);
        case "edit":
          return itemEdit(s);
      }
      throw new AihubError(unknownCommand(sub, pos[0]));
    case "job":
      switch (pos[0]) {
        case "show":
          return runStatus(s, "status");
        case "cancel":
          return cancelCmd(s, v.job as string | undefined);
        case "logs":
          return logsCmd(s);
      }
      throw new AihubError("usage: aihub fabric job show|cancel|logs --workspace W --item I --job ID");
    case "lakehouse":
      if (pos[0] === "tables") return lakehouseTables(s);
      if (pos[0] === "files") return lakehouseFiles(s);
      if (pos[0] === "load") return lakehouseLoad(s);
      if (pos[0] === "maintenance") return lakehouseMaintenance(s);
      throw new AihubError("usage: aihub fabric lakehouse tables|files|load|maintenance --workspace W --lakehouse L");
    case "shortcuts":
      return shortcutsCmd(s);
    case "schedules":
      return schedulesCmd(s);
    case "environment":
      return environmentCmd(s, pos[0]);
    case "workspace":
      return workspaceCmd(s, pos[0]);
    case "capacities":
      return capacitiesCmd(s);
    case "connections":
    case "gateways":
      return connectionsCmd(s, sub);
    case "spark":
      return sparkCmd(s, pos[0]);
    case "livy":
      return livyCmd(s, pos[0]);
    case "failures":
      return failuresCmd(s);
    case "sql":
      return sqlCmd(s);
    case "connection":
      return connectionWriteCmd(s, pos[0]);
    case "udf":
      return udfCmd(s, pos[0]);
    case "notebook-test":
      return notebookTestCmd(s, pos[0]);
    case "dbt":
      return dbtCmd(s, pos[0]);
    case "api":
      return apiCmd(s, pos);
    case "onelake":
      return onelakeCmd(s, pos[0]);
    case "dax":
    case "kql":
    case "graphql":
      return queryCmd(s, sub);
    case "auth":
      return authCmd(s, pos);
    case "deployment":
      return deploymentCmd(s, pos[0]);
    case "git":
      if (pos[0] === "status") return gitStatus(s);
      if (pos[0] === "update") return gitUpdate(s);
      if (pos[0] === "commit") return gitCommit(s);
      throw new AihubError("usage: aihub fabric git status|update|commit --workspace W");
  }
  throw new AihubError(unknownCommand(sub, pos[0]));
}

// ---- shared helpers --------------------------------------------------------------

let currentIdentity: FabricIdentity | undefined;

export function makeClient(ctx: Ctx, v: V = {}): FabricClient {
  const identity = new FabricIdentity({ env: ctx.env, fetch: ctx.fetch, exec: ctx.exec, now: ctx.now, tokenCache: ctx.tokenCache }, v.sp as string | undefined);
  currentIdentity = identity;
  return new FabricClient(() => identity.token("fabric"), ctx.fetch, {
    sleep: ctx.sleep,
    waitScale: ctx.env.AIHUB_POLL_MS === "0" ? 0 : 1,
    storageAuth: () => identity.token("storage"),
    powerbiAuth: () => identity.token("powerbi"),
    kustoAuth: () => identity.token("kusto"),
    identity,
  });
}

export const need = (v: V, key: string, what: string): string => {
  const x = v[key];
  if (typeof x !== "string" || !x) throw new AihubError(`needs --${key} <${what}>`);
  return x;
};

const num = (v: V, key: string, dflt: number): number => {
  const x = v[key];
  if (x === undefined) return dflt;
  const n = Number(x);
  if (!Number.isInteger(n) || n < 1) throw new AihubError(`--${key} must be a whole number of 1 or more`);
  return n;
};

/** Print text, or the data as JSON with --json. */
export function emit(s: Setup, data: unknown, text: string): void {
  if (s.v.json) {
    const id = currentIdentity?.resolve();
    s.ctx.out(redact(JSON.stringify(id ? { identity: identityJson(id), result: data } : { result: data })));
  } else s.ctx.out(redact(text));
}

/**
 * The workspace for a request. Reads accept any name or id the account can see; writes only workspaces
 * from team.yaml, and never acc/prd/test unless --allow-env names that environment.
 */
export async function target(s: Setup, client: FabricClient, write: boolean): Promise<Target> {
  const given = (s.v.workspace as string[] | undefined)?.[0];
  let ws: FabricWorkspace | undefined;
  let adhoc = false;
  if (given) {
    ws = selectWorkspaces(s.list, s.groups, { workspaces: [given] })[0];
    adhoc = !chooseWorkspace(s.list, { workspace: given });
  } else {
    ws = selectWorkspaces(s.list, s.groups, { branch: s.branch })[0];
    if (!ws) throw noWorkspace(s);
  }
  // refuse ACC/PRD by name before any Fabric call; a bare id is classified after its name is read
  const byId = adhoc && isGuidLike(ws.name);
  if (write && !byId) guardEnv(ws, s.v["allow-env"] as string | undefined);
  client.identity?.hint(ws.servicePrincipal);
  const id = await client.workspaceId(ws);
  if (adhoc && write && byId) {
    // a bare id says nothing about the stage: read the name and classify that
    const info = (await client.request("GET", `/workspaces/${id}`)).data as { displayName?: string };
    if (info.displayName) ws = { ...ws, name: info.displayName, id, environment: inferEnv(info.displayName) };
  }
  if (write && byId) guardEnv(ws, s.v["allow-env"] as string | undefined);
  return { ws, id, adhoc };
}

/** No --workspace and team.yaml names none for this branch: one question for the user (exit 3), before any Fabric call. */
function noWorkspace(s: Setup): AihubError {
  const e = missingSetting("fabric.workspaces", s.list.map((w) => w.name));
  e.message += "; or pass --workspace <name|id> when the user named one";
  return e;
}

const isGuidLike = (x: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);

const typeArg = (s: Setup) => {
  const t = s.v.type as string | undefined;
  return t ? (KNOWN_TYPES.find((k) => k.toLowerCase() === t.toLowerCase()) ?? t) : undefined;
};

export async function itemArg(s: Setup, client: FabricClient, wsId: string, key = "item"): Promise<FabricItem> {
  return client.resolveItem(wsId, need(s.v, key, "name|id"), typeArg(s));
}

/** "name (env)": whether team.yaml lists the workspace is not repeated on every call (writes outside it are refused with a reason). */
export const where = (t: Target) => `${t.ws.name} (${t.ws.environment})`;

export function dryRun(s: Setup, lines: string[]): void {
  s.ctx.out(s.v.json ? JSON.stringify({ dryRun: true, plan: lines }) : ["dry-run: nothing was changed", ...lines.map((l) => `  ${l}`)].join("\n"));
}

// ---- plan ------------------------------------------------------------------------

async function planCmd(s: Setup): Promise<void> {
  const { ctx, v } = s;
  const c = changedFiles(s.root!, loadTeam(s.root!), { branch: v.branch as string | undefined, target: v.target as string | undefined });
  const plan = buildPlan(c.files, s.list, { branch: c.branch, workspace: (v.workspace as string[] | undefined)?.[0] });
  applyTestPlan(s.root!, c.files, plan);
  {
    const team = loadTeam(s.root!) as { fabric?: { integrationRepositories?: string[]; robotGatedRepositories?: string[] }; repositories?: { name?: string }[] };
    const env = plan.workspace?.environment === "test" ? "test" : plan.workspace?.environment === "feature" ? "feature" : "dev";
    const d = testStrategy(team.repositories?.[0]?.name ?? "", env, team.fabric ?? {}, v["desired-commit"] as string | undefined, v["deployed-commit"] as string | undefined);
    plan.strategy = `${d.strategy}${d.executable ? "" : " (blocked)"}: ${d.reason}`;
  }
  if (v["check-workspace"] && plan.workspace) {
    const client = makeClient(ctx, v);
    const wsId = await client.workspaceId(plan.workspace);
    const have = await client.items(wsId);
    for (const it of plan.items) it.inWorkspace = have.some((h) => h.displayName === it.name && h.type === it.type);
  }
  emit(s, plan, formatPlan(plan, c.branch, c.target));
}

/** Add the callers of changed items, order referenced-before-caller, and note dbt models and UDF functions (legacy test planner). */
function applyTestPlan(root: string, changed: string[], plan: Plan): void {
  const all = git(root, ["ls-files", "--cached", "--others", "--exclude-standard"], { allowFail: true }).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const tp = buildTestPlan(root, all, changed);
  const known = new Map(plan.items.map((i) => [`${i.type}:${i.name}`, i]));
  const ordered: PlanItem[] = [];
  for (const st of tp.steps) {
    const base = known.get(`${st.item.type}:${st.item.name}`);
    const it: PlanItem = base ?? { name: st.item.name, type: st.item.type as PlanItem["type"], jobType: jobTypeFor(st.item.type), files: st.changedFiles.length, dir: st.item.folder };
    if (st.via) {
      it.via = st.via.name;
      it.activity = st.activity;
    }
    if (st.functions.length) it.functions = st.functions.map((f) => `${f.name}(${f.params})`);
    if (st.item.type === "DataBuildToolJob" && tp.dbtModels.length) it.note = `dbt models changed: ${tp.dbtModels.slice(0, 5).join(", ")}`;
    ordered.push(it);
  }
  for (const i of plan.items) if (!ordered.includes(i)) ordered.push(i);
  plan.items = ordered;
}

// ---- run / status ----------------------------------------------------------------

async function runStatus(s: Setup, sub: "run" | "status"): Promise<void> {
  const { ctx, v } = s;
  if (sub === "run" && v.cancel) return cancelCmd(s, v.cancel as string);
  const chosen = selectWorkspaces(s.list, s.groups, { workspaces: v.workspace as string[] | undefined, group: v.workspaces as string | undefined, branch: s.branch });
  if (!chosen.length) throw noWorkspace(s);
  // refuse before any Fabric call when one of them is not allowed
  if (sub === "run") for (const w of chosen) guardEnv(w, v["allow-env"] as string | undefined);
  const ws = chosen[0];
  if (!v.item) throw new AihubError(`aihub fabric ${sub} needs --item <name|id>`);
  if (sub === "status" && !v.job) throw new AihubError("aihub fabric status needs --job <id> and --item <name|id>");

  const client = makeClient(ctx, v);
  client.identity?.hint(s.v.workspaces ? s.groupSp?.[String(s.v.workspaces).toLowerCase()] : undefined);
  client.identity?.hint(ws.servicePrincipal);
  if (chosen.length > 1) {
    if (sub === "status") throw new AihubError("aihub fabric status takes one --workspace");
    await runMany(s, client, chosen);
    return;
  }
  const wsId = await client.workspaceId(ws);
  const item = await itemArg(s, client, wsId);

  if (sub === "status") {
    if (v.wait) return finishJob(s, client, ws.name, wsId, item, v.job as string);
    const j = await client.jobStatus(wsId, item.id, v.job as string);
    emit(s, j, formatJob(j, item.displayName));
    return;
  }
  return startJob(s, client, ws, wsId, item);
}

/** Start one item; with --wait also wait and print the end result (and on failure its cause) in the same call. */
export async function startJob(s: Setup, client: FabricClient, ws: FabricWorkspace, wsId: string, item: FabricItem): Promise<void> {
  const { ctx, v } = s;
  const exec = v["params-file"] ? executionDataFromParams(readFileSync(v["params-file"] as string, "utf8"), item) : undefined;
  if (v["dry-run"]) {
    dryRun(s, [`start ${item.type} ${item.displayName} in ${ws.name} (${ws.environment})${exec ? ` with parameters ${JSON.stringify(exec)}` : ""}${v.wait ? " and wait for the result" : ""}`]);
    return;
  }
  const jobId = await client.startJob(wsId, item, exec).catch((e) => {
    if (classifyError(String((e as Error).message)).kind === "capacity") throw new AihubError(`${(e as Error).message}; ${CAPACITY_HINT(ws.name)}`);
    throw e;
  });
  if (!v.json) ctx.out(`started ${item.type} ${item.displayName} in ${ws.name} (${ws.environment}): job ${jobId}`);
  if (!v.wait) {
    // the job runs already: waiting is `status --wait` on this job, never a second `run`
    emit(s, { started: jobId, workspace: ws.name, item: item.displayName }, `wait for the result: aihub fabric status --workspace ${ws.name} --item ${item.displayName} --job ${jobId} --wait\nor in the background: aihub watch --fabric-job ${ws.name}/${item.displayName}/${jobId} --notify`);
    return;
  }
  return finishJob(s, client, ws.name, wsId, item, jobId);
}

/** Wait for a job; print its end state, and when it failed the root cause (failed cell, exception, likely cause) too. */
export async function finishJob(s: Setup, client: FabricClient, wsName: string, wsId: string, item: FabricItem, jobId: string): Promise<void> {
  const j = await waitForJob(client, wsId, item.id, jobId, { pollMs: Number(s.ctx.env.AIHUB_POLL_MS ?? 5000) });
  const lines = [formatJob(j, item.displayName)];
  let chain: Link[] = [];
  if (j.status === "Failed") {
    if (classifyError(String(j.failureReason?.message ?? "")).kind === "capacity") lines.push(CAPACITY_HINT(wsName));
    chain = await rootCause(client, wsId, item, j).catch((e) => {
      if (e instanceof FabricHttpError && e.status === 401) throw e;
      return [];
    });
    // link 0 is the job printed above
    if (chain.length > 1) lines.push("cause:", ...formatChain(chain, 1).map((l) => `  ${l}`));
    lines.push(`full log: aihub fabric logs --workspace ${wsName} --item ${item.displayName} --job ${jobId}`);
  }
  emit(s, { job: j, ...(chain.length ? { chain } : {}) }, lines.join("\n"));
  if (j.status !== "Completed") throw new AihubError(`${item.displayName} ended as ${j.status}`);
}

interface Row {
  ws: FabricWorkspace;
  jobId?: string;
  wsId?: string;
  itemId?: string;
  result?: JobInstance;
  error?: string;
}

/** Same item in several workspaces: start in each, wait for all, one table, keep going on errors. */
async function runMany(s: Setup, client: FabricClient, chosen: FabricWorkspace[]): Promise<void> {
  const { ctx, v } = s;
  const rows: Row[] = chosen.map((ws) => ({ ws }));
  for (const r of rows) {
    try {
      r.wsId = await client.workspaceId(r.ws);
      const item = await itemArg(s, client, r.wsId);
      r.itemId = item.id;
      const exec = v["params-file"] ? executionDataFromParams(readFileSync(v["params-file"] as string, "utf8"), item) : undefined;
      if (v["dry-run"]) {
        ctx.out(`dry-run: would start ${item.displayName} in ${r.ws.name} (${r.ws.environment})`);
        continue;
      }
      r.jobId = await client.startJob(r.wsId, item, exec);
      ctx.out(`started ${item.displayName} in ${r.ws.name} (${r.ws.environment}): job ${r.jobId}`);
    } catch (e) {
      r.error = (e as Error).message;
    }
  }
  if (v["dry-run"]) return;
  if (v.wait) {
    const pollMs = Number(ctx.env.AIHUB_POLL_MS ?? 5000);
    for (const r of rows) {
      if (!r.jobId) continue;
      try {
        r.result = await waitForJob(client, r.wsId!, r.itemId!, r.jobId, { pollMs });
      } catch (e) {
        r.error = (e as Error).message;
      }
    }
  }
  const lines = ["workspace | environment | job | result"];
  for (const r of rows) {
    const res = r.error
      ? `error: ${r.error}`
      : r.result
        ? `${r.result.status}${r.result.status === "Failed" ? `: ${(r.result.failureReason?.message ?? "no details").replace(/\s+/g, " ").trim()}` : ""}`
        : "started";
    lines.push(`${r.ws.name} | ${r.ws.environment} | ${r.jobId ?? "-"} | ${res}`);
  }
  ctx.out(lines.join(String.fromCharCode(10)));
  const bad = rows.filter((r) => r.error || (v.wait && r.result?.status !== "Completed"));
  if (bad.length) throw new AihubError(`${bad.length} of ${rows.length} workspaces did not complete: ${bad.map((r) => r.ws.name).join(", ")}`);
}

// ---- read commands -----------------------------------------------------------------

async function workspacesCmd(s: Setup): Promise<void> {
  const client = makeClient(s.ctx, s.v);
  const f = (s.v.filter as string | undefined)?.toLowerCase();
  const all = (await client.workspaces()).filter((w) => !f || w.displayName.toLowerCase().includes(f) || w.id.toLowerCase().includes(f));
  const known = (n: string) => s.list.find((w) => w.name.toLowerCase() === n.toLowerCase())?.environment ?? "-";
  emit(s, all, all.length ? toTable([["id", "name", "type", "team.yaml env"], ...all.map((w) => [w.id, w.displayName, w.type ?? "-", known(w.displayName)])]) : f ? `no workspace matches '${f}'` : "no workspaces visible for this account");
}

async function itemsCmd(s: Setup): Promise<void> {
  const client = makeClient(s.ctx, s.v);
  const t = await target(s, client, false);
  const type = typeArg(s);
  const items = await client.items(t.id, type);
  items.sort((a, b) => a.type.localeCompare(b.type) || a.displayName.localeCompare(b.displayName));
  // a lakehouse brings its own SQL endpoint with the same name: one row "Lakehouse (+SQL endpoint)", not a second item
  const twin = (i: FabricItem) => i.type === "SQLEndpoint" && !type && items.some((l) => l.type === "Lakehouse" && l.displayName === i.displayName);
  const shown = items.filter((i) => !twin(i));
  const label = (i: FabricItem) => (i.type === "Lakehouse" && items.some((x) => twin(x) && x.displayName === i.displayName) ? "Lakehouse (+SQL endpoint)" : i.type);
  emit(s, items, shown.length ? [`${shown.length} item(s) in ${where(t)}`, toTable([["type", "name", "id"], ...shown.map((i) => [label(i), i.displayName, i.id])])].join("\n") : `no ${type ?? ""} items in ${where(t)}`.replace("  ", " "));
}

async function itemShow(s: Setup): Promise<void> {
  const client = makeClient(s.ctx, s.v);
  const t = await target(s, client, false);
  const it = await itemArg(s, client, t.id);
  const full = (await client.request("GET", `/workspaces/${t.id}/items/${it.id}`)).data as Record<string, unknown>;
  const lines = [`${full.type ?? it.type} ${full.displayName ?? it.displayName} in ${where(t)}`];
  for (const [k, val] of Object.entries(full)) {
    if (k === "displayName" || k === "type") continue;
    lines.push(`${k}: ${val && typeof val === "object" ? JSON.stringify(val) : String(val ?? "")}`);
  }
  emit(s, full, lines.join("\n"));
}

async function itemDefinition(s: Setup): Promise<void> {
  const client = makeClient(s.ctx, s.v);
  const t = await target(s, client, false);
  const it = await itemArg(s, client, t.id);
  const fmt = s.v.format as string | undefined;
  const r = await client.lro("POST", `/workspaces/${t.id}/items/${it.id}/getDefinition${fmt ? `?format=${encodeURIComponent(fmt)}` : ""}`);
  const parts = (r.data?.definition?.parts ?? []) as { path: string; payload: string; payloadType?: string }[];
  if (!parts.length) throw new AihubError(`${it.type} '${it.displayName}' has no definition (not every item type supports getDefinition)`);
  const out = s.v.out as string | undefined;
  if (out) {
    const names = writeDefinitionParts(parts, out);
    emit(s, { out, files: names }, `wrote ${names.length} file(s) of ${it.type} ${it.displayName} to ${out}:\n${names.map((n) => `  ${n}`).join("\n")}`);
    return;
  }
  const rows = parts.map((p) => ({ path: p.path, bytes: Buffer.from(p.payload ?? "", "base64").length }));
  emit(s, rows, [`${parts.length} definition part(s) of ${it.type} ${it.displayName}; add --out <dir> to write them`, ...rows.map((p) => `  ${p.path} (${p.bytes} bytes)`)].join("\n"));
}

async function jobsCmd(s: Setup): Promise<void> {
  const client = makeClient(s.ctx, s.v);
  const t = await target(s, client, false);
  const it = await itemArg(s, client, t.id);
  const jobs = (await client.jobs(t.id, it.id)).sort((a, b) => parseUtc(b.startTimeUtc) - parseUtc(a.startTimeUtc));
  const top = jobs.slice(0, num(s.v, "top", 20));
  const rows = top.map((j) => [j.startTimeUtc ?? "-", j.status, j.id, durationText(j.startTimeUtc, j.endTimeUtc), j.invokeType ?? "-", oneLine(j.failureReason?.message, 80)]);
  emit(s, top, top.length ? [`${top.length} of ${jobs.length} job(s) of ${it.type} ${it.displayName} in ${where(t)}`, toTable([["started", "status", "job", "duration", "invoke", "failure"], ...rows])].join("\n") : `no jobs yet for ${it.displayName}`);
}

// ---- logs -------------------------------------------------------------------------

async function logsCmd(s: Setup): Promise<void> {
  const { v } = s;
  const client = makeClient(s.ctx, s.v);
  if (!v.workspaces) await resolveBranchWorkspace(s, client);
  const t = await target(s, client, false);
  const search = v.search as string | undefined;
  const tail = v.tail ? num(v, "tail", 1) : undefined;

  if (v.job) {
    const it = await itemArg(s, client, t.id);
    if (it.type === "SemanticModel") {
      const secs = await collectRefreshLogs(client, t.id, it, tail ?? 20);
      return emit(s, { item: it.displayName, sections: secs }, `refresh history of SemanticModel ${it.displayName} in ${where(t)}\n${formatSections(secs, { search })}`);
    }
    const { job, sections } = await collectJobLogs(client, t.id, it, v.job as string);
    const header = `logs of ${it.type} ${it.displayName}, job ${job.id}, in ${where(t)}`;
    const out = v.out as string | undefined;
    const base = `aihub fabric logs --workspace ${t.ws.name} --item ${it.displayName} --job ${job.id}`;
    const more = out ? `full log written to ${out} (${Math.ceil(writeFullLog(out, header, sections) / 1024)} KB)` : `full log: ${base} --out <file> (or --search <text>, --tail N)`;
    if (search || tail) {
      // a window: the matching or last lines of every section, still capped on stdout
      const windowed = sections.map((x) => ({ ...x, lines: filterLines(x.lines, { search, tail }) }));
      const text = clampLines(`${header}\n${formatSections(sections, { search, tail })}`.split("\n"), WINDOW_BYTES, out ? more : `full log: ${base} --out <file>`).join("\n");
      return emit(s, { item: it.displayName, job, sections: windowed.map((x) => ({ ...x, lines: clampLines(x.lines, WINDOW_BYTES, "use --out <file>") })) }, text);
    }
    const d = digestJob(job, sections);
    const small = sections.filter((x) => !x.raw && x.title !== "job instance").map((x) => ({ ...x, lines: x.lines.slice(0, 30) }));
    emit(s, { item: it.displayName, job, digest: d, sections: small, ...(out ? { fullLog: out } : {}) }, formatDigest(job, `${it.type} ${it.displayName} in ${where(t)}`, sections, d, more));
    return;
  }

  const since = parseSince((v.since as string | undefined) ?? "24h", s.ctx.now?.());
  const r = await workspaceRuns(client, t.id, { since, status: v.status as string | undefined, item: v.item as string | undefined, type: typeArg(s), search, top: v.top ? num(v, "top", 50) : tail ?? 50 });
  const counts = new Map<string, number>();
  for (const x of r.rows) counts.set(x.status, (counts.get(x.status) ?? 0) + 1);
  const summary = `${r.rows.length} run(s) since ${v.since ?? "24h"} in ${where(t)}${r.rows.length ? `: ${[...counts].map(([k, n]) => `${n} ${k}`).join(", ")}` : ""}`;
  const lines = [summary, `source: ${r.source}; ${r.scanned} item(s) scanned${r.skipped.length ? `, ${r.skipped.length} without job history (${r.skipped.map((k) => `${k.item}: ${k.why}`).slice(0, 3).join("; ")})` : ""}`];
  if (r.rows.length) lines.push(toTable([["started", "item", "type", "status", "duration", "job", "first error line"], ...r.rows.map((x) => [x.start ?? "-", x.item, x.type, x.status, x.duration, x.jobId, x.error || "-"])]));
  const failed = r.rows.filter((x) => x.status === "Failed");
  if (failed.length) {
    lines.push("dig deeper:");
    for (const x of failed.slice(0, 5)) lines.push(`  aihub fabric logs --workspace ${t.ws.name} --item ${x.item} --job ${x.jobId}`);
  } else if (r.rows.length) lines.push(`nothing failed; details of one run: aihub fabric logs --workspace ${t.ws.name} --item ${r.rows[0].item} --job ${r.rows[0].jobId}`);
  emit(s, r, lines.join("\n"));
}

// ---- lakehouse --------------------------------------------------------------------

async function lakehouse(s: Setup, client: FabricClient, wsId: string): Promise<FabricItem> {
  const name = need(s.v, "lakehouse", "name|id");
  return client.resolveItem(wsId, name, "Lakehouse");
}

export async function oneLakeList(client: FabricClient, wsId: string, lhId: string, folder: string, subPath: string): Promise<{ name: string; isDirectory: boolean; size: string; modified: string }[]> {
  const dir = [lhId, folder, subPath.replace(/^\/+|\/+$/g, "")].filter(Boolean).join("/");
  const out: { name: string; isDirectory: boolean; size: string; modified: string }[] = [];
  let cont: string | undefined;
  for (let i = 0; i < 200; i++) {
    const url = `https://onelake.dfs.fabric.microsoft.com/${wsId}?resource=filesystem&recursive=false&directory=${encodeURIComponent(dir)}${cont ? `&continuation=${encodeURIComponent(cont)}` : ""}`;
    const r = await client.request("GET", url, undefined, { storage: true });
    for (const p of (r.data.paths ?? []) as { name: string; isDirectory?: string | boolean; contentLength?: string; lastModified?: string }[]) {
      out.push({ name: p.name.replace(`${lhId}/`, ""), isDirectory: p.isDirectory === true || p.isDirectory === "true", size: p.contentLength ?? "-", modified: p.lastModified ?? "-" });
    }
    cont = r.headers.get("x-ms-continuation") ?? undefined;
    if (!cont) break;
  }
  return out;
}

async function lakehouseTables(s: Setup): Promise<void> {
  const client = makeClient(s.ctx, s.v);
  const t = await target(s, client, false);
  const lh = await lakehouse(s, client, t.id);
  try {
    const tables = await client.list<{ name: string; type?: string; format?: string; location?: string }>(`/workspaces/${t.id}/lakehouses/${lh.id}/tables`);
    emit(s, { source: "lakehouse tables API", tables }, [`${tables.length} table(s) in ${lh.displayName} [source: lakehouse tables API]`, ...(tables.length ? [toTable([["name", "type", "format", "location"], ...tables.map((x) => [x.name, x.type ?? "-", x.format ?? "-", x.location ?? "-"])])] : [])].join("\n"));
  } catch (e) {
    if (!(e instanceof FabricHttpError) || ![400, 404, 501].includes(e.status)) throw e;
    // schema-enabled lakehouses do not support the tables API: list the Tables folder in OneLake instead
    const rows = await oneLakeList(client, t.id, lh.id, "Tables", (s.v.path as string | undefined) ?? "");
    emit(s, { source: "OneLake Tables folder", tables: rows }, [`${rows.length} entr(y/ies) in ${lh.displayName}/Tables [source: OneLake DFS, the tables API answered ${e.status}]`, ...rows.map((r) => `  ${r.name}${r.isDirectory ? "/" : ""}`)].join("\n"));
  }
}

async function lakehouseFiles(s: Setup): Promise<void> {
  const client = makeClient(s.ctx, s.v);
  const t = await target(s, client, false);
  const lh = await lakehouse(s, client, t.id);
  const path = (s.v.path as string | undefined) ?? "";
  const rows = await oneLakeList(client, t.id, lh.id, "Files", path);
  emit(s, rows, [`${rows.length} entr(y/ies) in ${lh.displayName}/Files/${path} [source: OneLake DFS]`, ...(rows.length ? [toTable([["name", "kind", "bytes", "modified"], ...rows.map((r) => [r.name, r.isDirectory ? "dir" : "file", r.size, r.modified])])] : [])].join("\n"));
}

// ---- write commands -------------------------------------------------------------------

const KNOWN_TYPES = ["Notebook", "DataPipeline", "Lakehouse", "Warehouse", "SemanticModel", "Report", "Environment", "VariableLibrary", "Dataflow", "SparkJobDefinition", "CopyJob", "KQLDatabase", "Eventhouse", "Eventstream"];

async function itemCreate(s: Setup): Promise<void> {
  const { v } = s;
  const client = makeClient(s.ctx, s.v);
  const type0 = need(v, "type", "Notebook|DataPipeline|Lakehouse|...");
  const type = KNOWN_TYPES.find((k) => k.toLowerCase() === type0.toLowerCase()) ?? type0;
  const name = need(v, "name", "display name");
  const parts = v["definition-dir"] ? readDefinitionDir(v["definition-dir"] as string) : undefined;
  const t = await target(s, client, true);
  const existing = (await client.items(t.id)).find((i) => i.displayName.toLowerCase() === name.toLowerCase() && i.type === type);
  if (existing) throw new AihubError(`${type} '${name}' already exists in ${t.ws.name} (id ${existing.id}); use: aihub fabric item update --workspace ${t.ws.name} --item ${name} --type ${type} --definition-dir <dir>`);
  const body: Record<string, unknown> = { displayName: name, type, ...(v.description ? { description: v.description } : {}), ...(parts ? { definition: { parts } } : {}) };
  if (v["dry-run"]) {
    dryRun(s, [`create ${type} '${name}' in ${where(t)}`, parts ? `definition: ${parts.length} part(s): ${parts.map((p) => p.path).join(", ")}` : "definition: none (empty item)"]);
    return;
  }
  const r = await client.lro("POST", `/workspaces/${t.id}/items`, body);
  const id = r.data?.id ?? "?";
  emit(s, r.data, `created ${type} ${name} (id ${id}) in ${where(t)}`);
}

async function itemUpdate(s: Setup): Promise<void> {
  const { v } = s;
  const client = makeClient(s.ctx, s.v);
  const dir = need(v, "definition-dir", "folder");
  const parts = readDefinitionDir(dir);
  const t = await target(s, client, true);
  const it = await itemArg(s, client, t.id);
  const withMeta = parts.some((p) => p.path === ".platform");
  if (v["dry-run"]) {
    dryRun(s, [`update the definition of ${it.type} '${it.displayName}' in ${where(t)}`, `parts: ${parts.length}: ${parts.map((p) => p.path).join(", ")}`, `metadata (.platform) ${withMeta ? "is updated too" : "is left as it is"}`]);
    return;
  }
  await client.lro("POST", `/workspaces/${t.id}/items/${it.id}/updateDefinition${withMeta ? "?updateMetadata=true" : ""}`, { definition: { parts } });
  emit(s, { updated: it.id, parts: parts.length }, `updated ${it.type} ${it.displayName} in ${where(t)} (${parts.length} part(s))`);
}

interface Edit {
  /** What the user asked, for messages. */
  label: string;
  /** Find the one place to change in a text; [] when absent. */
  find: (text: string) => { at: number; len: number; replacement: string }[];
}

const stripEol = (t: string) => t.replace(/^﻿/, "").replace(/\r?\n$/, "");

/** `--replace/--with` pairs, `--replace-file/--with-file`, and `--set name=value` (an assignment line, its quotes kept). */
function editsFrom(v: V): Edit[] {
  const edits: Edit[] = [];
  const olds = (v.replace as string[] | undefined) ?? [];
  const news = (v.with as string[] | undefined) ?? [];
  if (v["replace-file"] || v["with-file"]) {
    if (!v["replace-file"] || !v["with-file"]) throw new AihubError("--replace-file needs --with-file (and the other way round)");
    olds.push(stripEol(readFileSync(v["replace-file"] as string, "utf8")));
    news.push(stripEol(readFileSync(v["with-file"] as string, "utf8")));
  }
  if (olds.length !== news.length) throw new AihubError("every --replace needs a --with (use --with \"\" to delete the text)");
  olds.forEach((old, i) => {
    if (!old) throw new AihubError("--replace is empty");
    const repl = news[i];
    edits.push({
      label: `'${oneLine(old, 60)}'`,
      find: (text) => {
        const hits: { at: number; len: number; replacement: string }[] = [];
        for (let at = text.indexOf(old); at >= 0; at = text.indexOf(old, at + old.length)) hits.push({ at, len: old.length, replacement: repl });
        return hits;
      },
    });
  });
  for (const a of (v.set as string[] | undefined) ?? []) {
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(0, eq).trim() : "";
    if (!/^[A-Za-z_][\w.]*$/.test(name)) throw new AihubError(`--set wants name=value (an assignment in the code, e.g. --set regio=noord), not '${a}'`);
    const value = a.slice(eq + 1);
    const re = new RegExp(`^([ \\t]*${name.replace(/\./g, "\\.")}[ \\t]*=[ \\t]*)([^\\r\\n#]*?)([ \\t]*(?:#[^\\r\\n]*)?)$`, "gm");
    edits.push({
      label: `assignment '${name} = ...'`,
      find: (text) =>
        [...text.matchAll(re)].map((m) => {
          const cur = m[2];
          const q = /^(['"]).*\1$/.test(cur) ? cur[0] : "";
          // keep the quote style of the current value, unless the new value brings its own quotes or is not a string there
          const next = q && !/^(['"]).*\1$/.test(value) ? `${q}${value}${q}` : value;
          return { at: m.index! + m[1].length, len: cur.length, replacement: next };
        }),
    });
  }
  if (!edits.length) throw new AihubError('usage: aihub fabric item edit --workspace W --item I (--set name=value | --replace "old" --with "new" | --replace-file F --with-file F) [--part P] [--run --wait] [--dry-run]');
  return edits;
}

/** `aihub fabric item edit`: change text in an item's definition in place (download, replace, upload in one call), optionally run it. */
async function itemEdit(s: Setup): Promise<void> {
  const { v } = s;
  const edits = editsFrom(v);
  const client = makeClient(s.ctx, s.v);
  const t = await target(s, client, true);
  const it = await itemArg(s, client, t.id);
  const r = await client.lro("POST", `/workspaces/${t.id}/items/${it.id}/getDefinition`);
  const def = (r.data?.definition ?? {}) as { format?: string; parts?: { path: string; payload: string; payloadType?: string }[] };
  const parts = (def.parts ?? []).map((p) => ({ ...p, text: Buffer.from(p.payload ?? "", "base64").toString("utf8") }));
  if (!parts.length) throw new AihubError(`${it.type} '${it.displayName}' has no definition (not every item type supports getDefinition)`);
  const only = v.part as string | undefined;
  const isText = (p: { payload: string; text: string }) => !p.text.includes("\u0000") && Buffer.from(p.text, "utf8").toString("base64") === (p.payload ?? "");
  const editable = parts.filter((p) => (only ? p.path === only : p.path !== ".platform") && isText(p));
  if (only && !editable.length) throw new AihubError(`${it.displayName} has no text part '${only}'; parts: ${parts.map((p) => p.path).join(", ")}`);
  const changes: string[] = [];
  const lineOf = (text: string, at: number) => text.slice(0, at).split("\n").length;
  const lineText = (text: string, n: number) => text.split("\n")[n - 1]?.replace(/\r$/, "") ?? "";
  for (const e of edits) {
    const hits = editable.flatMap((p) => e.find(p.text).map((h) => ({ p, ...h })));
    const where1 = (h: { p: { path: string; text: string }; at: number }) => `${h.p.path} line ${lineOf(h.p.text, h.at)}`;
    if (!hits.length) throw new AihubError(`${e.label} does not occur in ${it.type} ${it.displayName} (${editable.map((p) => p.path).join(", ")}); nothing was changed. PowerShell drops double quotes inside arguments: leave them out, use --set name=value, or --replace-file`);
    if (hits.length > 1) throw new AihubError(`${e.label} occurs ${hits.length} times (${hits.slice(0, 5).map(where1).join(", ")}); make it longer so it occurs once; nothing was changed`);
    const h = hits[0];
    const n = lineOf(h.p.text, h.at);
    const before = lineText(h.p.text, n);
    h.p.text = h.p.text.slice(0, h.at) + h.replacement + h.p.text.slice(h.at + h.len);
    const show = (l: string) => (l.trim().length > 120 ? `${l.trim().slice(0, 119)}…` : l.trim());
    changes.push(`${h.p.path} line ${n}: ${show(before)}  ->  ${show(lineText(h.p.text, n))}`);
  }
  if (v["dry-run"]) return dryRun(s, [`edit ${it.type} '${it.displayName}' in ${where(t)}`, ...changes, ...(v.run ? [`then run it${v.wait ? " and wait" : ""}`] : [])]);
  const send = parts.filter((p) => p.path !== ".platform").map((p) => ({ path: p.path, payload: editable.includes(p) ? Buffer.from(p.text, "utf8").toString("base64") : p.payload, payloadType: "InlineBase64" }));
  await client.lro("POST", `/workspaces/${t.id}/items/${it.id}/updateDefinition`, { definition: { ...(def.format ? { format: def.format } : {}), parts: send } });
  if (!v.run) return emit(s, { updated: it.id, changes }, [`updated ${it.type} ${it.displayName} in ${where(t)}:`, ...changes.map((c) => `  ${c}`)].join("\n"));
  if (!v.json) s.ctx.out([`updated ${it.type} ${it.displayName} in ${where(t)}:`, ...changes.map((c) => `  ${c}`)].join("\n"));
  return startJob(s, client, t.ws, t.id, it);
}

async function itemRename(s: Setup): Promise<void> {
  const client = makeClient(s.ctx, s.v);
  const name = need(s.v, "name", "new display name");
  const t = await target(s, client, true);
  const it = await itemArg(s, client, t.id);
  if (s.v["dry-run"]) {
    dryRun(s, [`rename ${it.type} '${it.displayName}' to '${name}' in ${where(t)}`]);
    return;
  }
  await client.request("PATCH", `/workspaces/${t.id}/items/${it.id}`, { displayName: name });
  emit(s, { renamed: it.id, name }, `renamed ${it.type} ${it.displayName} to ${name} in ${where(t)}`);
}

async function itemDelete(s: Setup): Promise<void> {
  const client = makeClient(s.ctx, s.v);
  const t = await target(s, client, true);
  const it = await itemArg(s, client, t.id);
  if (s.v["dry-run"]) {
    dryRun(s, [`delete ${it.type} '${it.displayName}' (id ${it.id}) from ${where(t)}`]);
    return;
  }
  if (!s.v.yes) throw new AihubError(`deleting ${it.type} '${it.displayName}' in ${t.ws.name} cannot be undone: add --yes (or --dry-run to look first)`);
  await client.request("DELETE", `/workspaces/${t.id}/items/${it.id}`);
  emit(s, { deleted: it.id }, `deleted ${it.type} ${it.displayName} from ${where(t)}`);
}

async function cancelCmd(s: Setup, jobId: string | undefined): Promise<void> {
  if (!jobId) throw new AihubError("needs --job <id> (or: aihub fabric run --cancel <job> --item <name|id>)");
  const client = makeClient(s.ctx, s.v);
  const t = await target(s, client, true);
  const it = await itemArg(s, client, t.id);
  if (s.v["dry-run"]) {
    dryRun(s, [`cancel job ${jobId} of ${it.type} '${it.displayName}' in ${where(t)}`]);
    return;
  }
  await client.cancelJob(t.id, it.id, jobId);
  emit(s, { cancelRequested: jobId }, `cancel requested for job ${jobId} of ${it.displayName}; check: aihub fabric status --workspace ${t.ws.name} --item ${it.displayName} --job ${jobId}`);
}

// ---- git integration ----------------------------------------------------------------------

interface GitStatus {
  workspaceHead?: string;
  remoteCommitHash?: string;
  changes?: { itemMetadata?: { displayName?: string; itemType?: string }; workspaceChange?: string; remoteChange?: string; conflictType?: string }[];
}

async function gitState(client: FabricClient, wsId: string): Promise<GitStatus> {
  return (await client.lro("GET", `/workspaces/${wsId}/git/status`)).data as GitStatus;
}

const changeRows = (st: GitStatus) =>
  (st.changes ?? []).map((c) => [c.itemMetadata?.itemType ?? "?", c.itemMetadata?.displayName ?? "?", c.workspaceChange ?? "-", c.remoteChange ?? "-", c.conflictType && c.conflictType !== "None" ? c.conflictType : "-"]);

async function gitStatus(s: Setup): Promise<void> {
  const client = makeClient(s.ctx, s.v);
  const t = await target(s, client, false);
  const st = await gitState(client, t.id);
  const rows = changeRows(st);
  emit(s, st, [`git status of ${where(t)}: workspace head ${st.workspaceHead?.slice(0, 8) ?? "-"}, remote ${st.remoteCommitHash?.slice(0, 8) ?? "-"}`, ...(rows.length ? [toTable([["type", "item", "workspace change", "remote change", "conflict"], ...rows])] : ["no differences between workspace and branch"])].join("\n"));
}

async function gitUpdate(s: Setup): Promise<void> {
  const client = makeClient(s.ctx, s.v);
  const t = await target(s, client, true);
  const st = await gitState(client, t.id);
  const remote = (st.changes ?? []).filter((c) => c.remoteChange);
  if (!st.remoteCommitHash || (st.remoteCommitHash === st.workspaceHead && !remote.length)) {
    emit(s, st, `${t.ws.name} is already up to date with its branch`);
    return;
  }
  const lines = [`update ${where(t)} from git: ${st.workspaceHead?.slice(0, 8) ?? "-"} -> ${st.remoteCommitHash.slice(0, 8)}, ${remote.length} item(s) change; remote wins on conflicts`, ...changeRows({ changes: remote }).map((r) => `${r[0]} ${r[1]}: remote ${r[3]}`)];
  if (s.v["dry-run"]) return dryRun(s, lines);
  await client.lro("POST", `/workspaces/${t.id}/git/updateFromGit`, {
    remoteCommitHash: st.remoteCommitHash,
    workspaceHead: st.workspaceHead,
    conflictResolution: { conflictResolutionType: "Workspace", conflictResolutionPolicy: "PreferRemote" },
    options: { allowOverrideItems: true },
  });
  emit(s, { updated: t.ws.name, to: st.remoteCommitHash }, `updated ${t.ws.name} from git to ${st.remoteCommitHash.slice(0, 8)}`);
}

async function gitCommit(s: Setup): Promise<void> {
  const client = makeClient(s.ctx, s.v);
  const file = s.v["message-file"] as string | undefined;
  const given = file ? readFileSync(file, "utf8").trim() : ((s.v.message as string | undefined) ?? "").trim();
  if (file && !given) throw new AihubError(`--message-file '${file}' is empty`);
  const t = await target(s, client, true);
  const st = await gitState(client, t.id);
  const local = (st.changes ?? []).filter((c) => c.workspaceChange);
  if (!local.length) {
    emit(s, st, `nothing to commit in ${t.ws.name}: the workspace matches its branch`);
    return;
  }
  const what = changeRows({ changes: local }).map((r) => `${r[0]} ${r[1]}: ${r[2]}`);
  // without a message the commit names what changed, so one call is enough
  const message = given || `Update ${local.length === 1 ? `${local[0].itemMetadata?.displayName ?? "1 item"}` : `${local.length} items`} from Fabric workspace ${t.ws.name}`;
  const lines = [`commit ${local.length} workspace change(s) of ${where(t)} to git: "${oneLine(message.split("\n")[0], 80)}"`, ...what];
  if (s.v["dry-run"]) return dryRun(s, lines);
  await client.lro("POST", `/workspaces/${t.id}/git/commitToGit`, { mode: "All", workspaceHead: st.workspaceHead, comment: message });
  // read the status once more, so the caller does not need a second call: the new head and whether anything is left
  const after = await gitState(client, t.id).catch((e) => {
    if (e instanceof FabricHttpError && e.status === 401) throw e;
    return undefined;
  });
  const left = (after?.changes ?? []).filter((c) => c.workspaceChange);
  const state = !after ? "the git status after the commit could not be read" : left.length ? `${left.length} change(s) still not committed` : "the workspace is clean (matches its branch)";
  emit(
    s,
    { committed: local.length, items: what, message, head: after?.workspaceHead, clean: after ? !left.length : undefined },
    [`committed ${local.length} change(s) of ${t.ws.name} to git${after?.workspaceHead ? ` as ${after.workspaceHead.slice(0, 8)}` : ""}: "${oneLine(message.split("\n")[0], 80)}"`, ...what.map((w) => `  ${w}`), state].join("\n"),
  );
}

export type { PlanItem };
