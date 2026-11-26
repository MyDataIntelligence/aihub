import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { AdoClient, branchRef, parseRemote, shortBranch, type AdoRemote } from "./ado.js";
import { makeAuth } from "./auth.js";
import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { remoteUrl } from "./git.js";
import { findLinks, readableLog, type ReadableLog } from "./pipelineLog.js";
import { readUtf8 } from "./team.js";

/**
 * The reads and actions behind "Pipelines in the bar": every answer is one JSON object, built from as few REST calls as
 * possible and no git process (the remote is read from .git/config), because the bar asks again every 15 s while a run
 * of mine is running. Durations are seconds, times ISO; the bar formats them.
 */

// ---- raw Azure DevOps shapes ------------------------------------------------------------------------------------

export interface RawBuild {
  id: number;
  buildNumber?: string;
  status?: string;
  result?: string;
  queueTime?: string;
  startTime?: string;
  finishTime?: string;
  sourceBranch?: string;
  sourceVersion?: string;
  reason?: string;
  requestedFor?: { id?: string; displayName?: string };
  definition?: { id: number; name: string };
  repository?: { id?: string; name?: string; type?: string };
  triggerInfo?: Record<string, string>;
  templateParameters?: Record<string, string>;
  parameters?: string;
  _links?: { web?: { href?: string } };
}

export interface Rec {
  id: string;
  parentId?: string | null;
  type: string;
  name: string;
  identifier?: string | null;
  state?: string;
  result?: string | null;
  startTime?: string | null;
  finishTime?: string | null;
  order?: number;
  errorCount?: number;
  warningCount?: number;
  workerName?: string | null;
  log?: { id: number } | null;
}

// ---- small mappings (exported for the tests) ----------------------------------------------------------------------

export type RunState = "queued" | "running" | "cancelling" | "succeeded" | "partiallySucceeded" | "failed" | "canceled";
export type RecState = RunState | "skipped" | "pending";

export function runState(b: Pick<RawBuild, "status" | "result">): RunState {
  if (b.status === "completed") {
    if (b.result === "succeeded") return "succeeded";
    if (b.result === "partiallySucceeded") return "partiallySucceeded";
    if (b.result === "canceled") return "canceled";
    return "failed";
  }
  if (b.status === "inProgress") return "running";
  if (b.status === "cancelling") return "cancelling";
  return "queued"; // notStarted, postponed
}

export function recState(r: Pick<Rec, "state" | "result">): RecState {
  if (r.state === "completed") {
    switch (r.result) {
      case "succeeded":
        return "succeeded";
      case "succeededWithIssues":
        return "partiallySucceeded";
      case "skipped":
        return "skipped";
      case "canceled":
      case "abandoned":
        return "canceled";
      default:
        return "failed";
    }
  }
  return r.state === "inProgress" ? "running" : "pending";
}

export function reasonOf(reason: string | undefined): "manual" | "pullRequest" | "ci" | "schedule" | "other" {
  if (reason === "manual") return "manual";
  if (reason === "pullRequest") return "pullRequest";
  if (reason === "individualCI" || reason === "batchedCI") return "ci";
  if (reason === "schedule") return "schedule";
  return "other";
}

export function seconds(start?: string | null, finish?: string | null, now?: number): number | null {
  if (!start) return null;
  const a = Date.parse(start);
  const b = finish ? Date.parse(finish) : now;
  if (Number.isNaN(a) || b === undefined || Number.isNaN(b)) return null;
  return Math.max(0, Math.round((b - a) / 1000));
}

/** The branch a run is about: the source branch of the pull request for a PR run, else its own branch. */
export function branchOf(b: RawBuild): string {
  const pr = b.triggerInfo?.["pr.sourceBranch"];
  return shortBranch(pr ?? b.sourceBranch ?? "");
}

const isFinished = (s: RunState) => s !== "queued" && s !== "running" && s !== "cancelling";

// ---- where a repository lives, without starting git ----------------------------------------------------------------

/** The common .git folder of the repository (or worktree) that holds `dir`. */
function gitCommonDir(dir: string): string | undefined {
  let d = resolve(dir);
  for (;;) {
    const g = join(d, ".git");
    if (existsSync(g)) {
      let gd = g;
      if (statSync(g).isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(g, "utf8"));
        if (!m) return undefined;
        gd = isAbsolute(m[1].trim()) ? m[1].trim() : resolve(d, m[1].trim());
      }
      const common = join(gd, "commondir");
      if (existsSync(common)) {
        const c = readFileSync(common, "utf8").trim();
        return isAbsolute(c) ? c : resolve(gd, c);
      }
      return gd;
    }
    const up = dirname(d);
    if (up === d) return undefined;
    d = up;
  }
}

/** The origin remote of the repository at `dir`, read from .git/config (no process); git itself only as a fallback. */
export function remoteOf(dir: string): AdoRemote {
  const common = gitCommonDir(dir);
  if (!common) throw new AihubError(`${dir} is not inside a git repository`);
  let url: string | undefined;
  try {
    const cfg = readFileSync(join(common, "config"), "utf8");
    const sec = /\[remote "origin"\]([^[]*)/.exec(cfg);
    url = sec ? /^\s*url\s*=\s*(.+?)\s*$/m.exec(sec[1])?.[1] : undefined;
  } catch {
    url = undefined;
  }
  return parseRemote(url ?? remoteUrl(dir));
}

export function clientAt(ctx: Ctx, dir: string): AdoClient {
  return new AdoClient(remoteOf(dir), makeAuth({ env: ctx.env, exec: ctx.exec, cacheFile: ctx.tokenCache }), ctx.fetch);
}

// ---- who am I (asked once per organisation, kept) --------------------------------------------------------------------

export interface Me {
  id: string;
  name: string;
}

const meFile = (env: NodeJS.ProcessEnv) => join(env.AIHUB_HOME || join(homedir(), ".aihub"), "devops-me.json");

export async function me(ctx: Ctx, client: AdoClient): Promise<Me> {
  const key = client.remote.orgUrl.toLowerCase();
  let all: Record<string, Me> = {};
  try {
    all = JSON.parse(readFileSync(meFile(ctx.env), "utf8")) as Record<string, Me>;
  } catch {
    all = {};
  }
  if (all[key]?.id) return all[key];
  const r = await client.getOrg<{ authenticatedUser?: { id?: string; providerDisplayName?: string; customDisplayName?: string } }>("connectionData");
  const u = r.authenticatedUser;
  if (!u?.id) throw new AihubError("could not find who you are in Azure DevOps (sign in with 'az login' or set AIHUB_ADO_PAT)");
  const mine = { id: u.id, name: u.customDisplayName || u.providerDisplayName || "" };
  try {
    mkdirSync(dirname(meFile(ctx.env)), { recursive: true });
    writeFileSync(meFile(ctx.env), JSON.stringify({ ...all, [key]: mine }), "utf8");
  } catch {
    /* a read-only home only costs one more call next time */
  }
  return mine;
}

// ---- links -------------------------------------------------------------------------------------------------------------

export function runUrl(client: AdoClient, id: number): string {
  const r = client.remote;
  return `${r.orgUrl}/${encodeURIComponent(r.project)}/_build/results?buildId=${id}`;
}

function recUrl(client: AdoClient, run: number, r: Rec, jobId?: string): string {
  const base = `${runUrl(client, run)}&view=logs`;
  if (r.type === "Stage") return `${base}&s=${r.id}`;
  if (r.type === "Job") return `${base}&j=${r.id}`;
  return `${base}${jobId ? `&j=${jobId}` : ""}&t=${r.id}`;
}

// ---- list ------------------------------------------------------------------------------------------------------------

export interface RunRow {
  id: number;
  number: string | null;
  pipeline: { id: number; name: string };
  repo: string | null;
  repoDir: string | null;
  branch: string;
  commit: string | null;
  state: RunState;
  reason: ReturnType<typeof reasonOf>;
  requestedFor: { name: string; isMe: boolean };
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationSeconds: number | null;
  currentStage: string | null;
  webUrl: string;
}

export interface Counts {
  total: number;
  running: number;
  queued: number;
  failed: number;
  succeeded: number;
  canceled: number;
}

export interface ListResult {
  me: Me | null;
  since: string;
  runs: RunRow[];
  today: Counts & { capped: boolean };
  errors: { repoDir: string; error: string }[];
}

export const STATUS_FILTERS = ["running", "queued", "failed", "succeeded", "canceled"] as const;

/** Local midnight of the day of `now`, as ISO. */
export function midnight(now: number): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export function countOf(states: RunState[]): Counts {
  const c: Counts = { total: states.length, running: 0, queued: 0, failed: 0, succeeded: 0, canceled: 0 };
  for (const s of states) {
    if (s === "running" || s === "cancelling") c.running++;
    else if (s === "queued") c.queued++;
    else if (s === "succeeded" || s === "partiallySucceeded") c.succeeded++;
    else if (s === "canceled") c.canceled++;
    else c.failed++;
  }
  return c;
}

const matchesStatus = (s: RunState, f: string) =>
  f === "running" ? s === "running" || s === "cancelling" : f === "succeeded" ? s === "succeeded" || s === "partiallySucceeded" : s === f;

function rowOf(client: AdoClient, b: RawBuild, meId: string | undefined, repoDir: string | null, now: number): RunRow {
  const state = runState(b);
  return {
    id: b.id,
    number: b.buildNumber ?? null,
    pipeline: { id: b.definition?.id ?? 0, name: b.definition?.name ?? "pipeline" },
    repo: b.repository?.name ?? null,
    repoDir,
    branch: branchOf(b),
    commit: b.sourceVersion ?? null,
    state,
    reason: reasonOf(b.reason),
    requestedFor: { name: b.requestedFor?.displayName ?? "", isMe: !!meId && b.requestedFor?.id?.toLowerCase() === meId.toLowerCase() },
    queuedAt: b.queueTime ?? null,
    startedAt: b.startTime ?? null,
    finishedAt: b.finishTime ?? null,
    durationSeconds: seconds(b.startTime, b.finishTime, isFinished(state) ? undefined : now),
    currentStage: null,
    webUrl: b._links?.web?.href ?? runUrl(client, b.id),
  };
}

/**
 * `aihub pipeline list`: runs of one or more repositories (a story set), newest first, filtered on mine, today, status
 * and branch, plus today's counts. Repositories of the same project share one REST call.
 */
export async function pipelineList(
  ctx: Ctx,
  o: { mine?: boolean; today?: boolean; status?: string; branch?: string; top?: number; repoDirs?: string[] },
): Promise<ListResult> {
  if (o.status && !(STATUS_FILTERS as readonly string[]).includes(o.status)) throw new AihubError(`--status must be one of ${STATUS_FILTERS.join(", ")}`);
  const now = ctx.now?.() ?? Date.now();
  const since = midnight(now);
  const dirs = o.repoDirs?.length ? o.repoDirs : [ctx.cwd];
  const errors: ListResult["errors"] = [];
  // one group per organisation + project
  const groups = new Map<string, { client: AdoClient; repos: Map<string, string> }>();
  for (const d of dirs) {
    try {
      const client = clientAt(ctx, d);
      const key = `${client.remote.orgUrl}/${client.remote.project}`.toLowerCase();
      const g = groups.get(key) ?? { client, repos: new Map<string, string>() };
      g.repos.set(client.remote.repo.toLowerCase(), d);
      groups.set(key, g);
    } catch (e) {
      errors.push({ repoDir: d, error: (e as Error).message });
    }
  }
  let meInfo: Me | null = null;
  const rows: { row: RunRow; client: AdoClient }[] = [];
  let capped = false;
  const FETCH = 100;
  for (const g of groups.values()) {
    try {
      const my = o.mine ? await me(ctx, g.client) : undefined;
      if (my) meInfo = my;
      const ref = o.branch ? branchRef(o.branch) : undefined;
      // a branch filter in the query would hide the PR runs of that branch (they run on refs/pull/N/merge); only without --mine
      // is the list long enough that the query must filter
      const r = await g.client.get<{ value?: RawBuild[] }>("build/builds", {
        queryOrder: "queueTimeDescending",
        $top: FETCH,
        ...(my ? { requestedFor: my.id } : {}),
        ...(o.today ? { minTime: since } : {}),
        ...(ref && !my ? { branchName: ref } : {}),
      });
      const value = r.value ?? [];
      // today's counts are complete unless the oldest run read is still from today
      if (value.length >= FETCH && (value[value.length - 1].queueTime ?? "") >= since) capped = true;
      for (const b of value) {
        const dir = g.repos.get((b.repository?.name ?? "").toLowerCase());
        if (dir === undefined) continue;
        if (ref && b.sourceBranch !== ref && b.triggerInfo?.["pr.sourceBranch"] !== ref) continue;
        rows.push({ row: rowOf(g.client, b, my?.id, dir, now), client: g.client });
      }
    } catch (e) {
      for (const d of g.repos.values()) errors.push({ repoDir: d, error: (e as Error).message });
    }
  }
  rows.sort((a, b) => (b.row.queuedAt ?? "").localeCompare(a.row.queuedAt ?? "") || b.row.id - a.row.id);
  const todays = rows.filter((r) => (r.row.queuedAt ?? "") >= since);
  const picked = rows.filter((r) => (!o.today || (r.row.queuedAt ?? "") >= since) && (!o.status || matchesStatus(r.row.state, o.status))).slice(0, o.top ?? 50);
  // the stage that runs now, only for the few running rows that are shown
  for (const p of picked) {
    if (p.row.state !== "running" && p.row.state !== "queued") continue;
    try {
      const t = await p.client.get<{ records?: Rec[] }>(`build/builds/${p.row.id}/timeline`);
      p.row.currentStage = currentOf(t.records ?? []).stage;
    } catch {
      /* the row still shows without its stage */
    }
  }
  return { me: meInfo, since, runs: picked.map((p) => p.row), today: { ...countOf(todays.map((r) => r.row.state)), capped }, errors };
}

// ---- the stage/job/step tree ------------------------------------------------------------------------------------------

export interface StepNode {
  id: string;
  name: string;
  state: RecState;
  durationSeconds: number | null;
  logId: number | null;
  errorCount: number;
  warningCount: number;
  webUrl: string;
}

export interface JobNode {
  id: string;
  name: string;
  state: RecState;
  durationSeconds: number | null;
  agent: string | null;
  webUrl: string;
  steps: StepNode[];
}

export interface StageNode {
  id: string;
  identifier: string;
  name: string;
  state: RecState;
  durationSeconds: number | null;
  dependsOn: string[];
  notRunReason: string | null;
  errorCount: number;
  webUrl: string;
  jobs: JobNode[];
}

const byOrder = (a: Rec, b: Rec) => (a.order ?? 0) - (b.order ?? 0);
const isCheckpoint = (r: Rec) => r.type === "Checkpoint" || r.type.startsWith("Checkpoint.");

/** Builds the tree from timeline records. Stage dependencies come from the YAML when known, else each stage needs the one before it. */
export function treeOf(records: Rec[], url: (r: Rec, jobId?: string) => string, deps?: Map<string, string[]>, now?: number): StageNode[] {
  const kids = new Map<string, Rec[]>();
  for (const r of records) kids.set(r.parentId ?? "", [...(kids.get(r.parentId ?? "") ?? []), r]);
  for (const l of kids.values()) l.sort(byOrder);
  const dur = (r: Rec) => seconds(r.startTime, r.finishTime, r.state === "inProgress" ? now : undefined);
  const jobsUnder = (id: string): Rec[] => (kids.get(id) ?? []).flatMap((r) => (r.type === "Job" ? [r] : r.type === "Phase" ? jobsUnder(r.id) : []));
  const job = (j: Rec): JobNode => ({
    id: j.id,
    name: j.name,
    state: recState(j),
    durationSeconds: dur(j),
    agent: j.workerName ?? null,
    webUrl: url(j),
    steps: (kids.get(j.id) ?? [])
      .filter((t) => t.type === "Task" && !isCheckpoint(t))
      .map((t) => ({ id: t.id, name: t.name, state: recState(t), durationSeconds: dur(t), logId: t.log?.id ?? null, errorCount: t.errorCount ?? 0, warningCount: t.warningCount ?? 0, webUrl: url(t, j.id) })),
  });
  let stages = records.filter((r) => r.type === "Stage").sort(byOrder);
  const nodes: StageNode[] = stages.map((s) => {
    const jobs = jobsUnder(s.id).map(job);
    return {
      id: s.id,
      identifier: s.identifier ?? s.name,
      name: s.name === "__default" ? "Pipeline" : s.name,
      state: recState(s),
      durationSeconds: dur(s),
      dependsOn: [],
      notRunReason: null,
      errorCount: (s.errorCount ?? 0) + jobs.reduce((n, j) => n + j.steps.reduce((m, t) => m + t.errorCount, 0), 0),
      webUrl: url(s),
      jobs,
    };
  });
  if (!stages.length) {
    // classic or stage-less run: one stage that holds all jobs
    const jobs = records.filter((r) => r.type === "Job").sort(byOrder).map(job);
    if (jobs.length) {
      const st = jobs.some((j) => j.state === "failed") ? "failed" : jobs.some((j) => j.state === "running") ? "running" : jobs.every((j) => j.state === "succeeded" || j.state === "skipped") ? "succeeded" : jobs[0].state;
      nodes.push({ id: "", identifier: "__default", name: "Pipeline", state: st, durationSeconds: null, dependsOn: [], notRunReason: null, errorCount: jobs.reduce((n, j) => n + j.steps.reduce((m, t) => m + t.errorCount, 0), 0), webUrl: url({ id: "", type: "Run", name: "" }).replace(/&view=logs.*$/, ""), jobs });
    }
    stages = [];
  }
  nodes.forEach((n, i) => {
    n.dependsOn = deps?.get(n.identifier) ?? (i > 0 ? [nodes[i - 1].identifier] : []);
    if (n.state === "skipped" || (n.state === "pending" && !n.jobs.length)) {
      const bad = n.dependsOn.map((d) => nodes.find((x) => x.identifier === d)).find((x) => x && (x.state === "failed" || x.state === "canceled" || x.state === "skipped"));
      n.notRunReason = bad ? `${bad.name} ${bad.state === "skipped" ? "not run" : bad.state}` : n.state === "skipped" ? "skipped" : null;
    }
  });
  return nodes;
}

/** The stage and step that run now (or, for a finished run, null). */
export function currentOf(records: Rec[]): { stage: string | null; step: string | null; stepId: string | null } {
  const running = (t: string) => records.filter((r) => r.type === t && r.state === "inProgress").sort(byOrder)[0];
  const st = running("Stage");
  const step = running("Task");
  return { stage: st ? (st.name === "__default" ? null : st.name) : null, step: step?.name ?? null, stepId: step?.id ?? null };
}

/** The first failed stage and, inside it, the first failed step (in tree order). */
export function stoppedAt(tree: StageNode[]): { stage: StageNode; job: JobNode; step: StepNode } | undefined {
  for (const s of tree) {
    if (s.state !== "failed" && s.state !== "canceled") continue;
    for (const j of s.jobs) {
      const step = j.steps.find((t) => t.state === "failed") ?? (j.state === "failed" || j.state === "canceled" ? j.steps.find((t) => t.state === "canceled") : undefined);
      if (step) return { stage: s, job: j, step };
    }
  }
  for (const s of tree) for (const j of s.jobs) for (const t of j.steps) if (t.state === "failed") return { stage: s, job: j, step: t };
  return undefined;
}

// ---- pipeline YAML: parameter types and stage dependencies -------------------------------------------------------------

export interface ParamDef {
  name: string;
  displayName: string | null;
  type: string;
  default: unknown;
  values: string[] | null;
}

export interface YamlFacts {
  parameters: ParamDef[];
  /** stage identifier -> the stages it depends on; undefined when the stages are not in this file (templates). */
  stageDeps?: Map<string, string[]>;
}

export function yamlFacts(text: string): YamlFacts {
  let doc: any;
  try {
    doc = parseYaml(text);
  } catch {
    return { parameters: [] };
  }
  if (!doc || typeof doc !== "object") return { parameters: [] };
  const parameters: ParamDef[] = (Array.isArray(doc.parameters) ? doc.parameters : [])
    .filter((p: any) => p && typeof p.name === "string")
    .map((p: any) => ({
      name: p.name,
      displayName: typeof p.displayName === "string" ? p.displayName : null,
      type: typeof p.type === "string" ? p.type : "string",
      default: p.default ?? null,
      values: Array.isArray(p.values) ? p.values.map(String) : null,
    }));
  const list = Array.isArray(doc.stages) ? doc.stages : undefined;
  if (!list || list.some((s: any) => !s || typeof s.stage !== "string")) return { parameters };
  const stageDeps = new Map<string, string[]>();
  list.forEach((s: any, i: number) => {
    const d = s.dependsOn;
    stageDeps.set(s.stage, d === undefined ? (i > 0 ? [list[i - 1].stage] : []) : Array.isArray(d) ? d.map(String) : d === "" || d === null ? [] : [String(d)]);
  });
  return { parameters, stageDeps };
}

async function readYaml(client: AdoClient, defId: number, commit: string | undefined): Promise<YamlFacts | undefined> {
  try {
    const def = await client.get<{ process?: { yamlFilename?: string; type?: number }; repository?: { id?: string; type?: string } }>(`build/definitions/${defId}`);
    return await yamlAt(client, def, commit);
  } catch {
    return undefined;
  }
}

async function yamlAt(client: AdoClient, def: { process?: { yamlFilename?: string }; repository?: { id?: string; type?: string } }, commit: string | undefined): Promise<YamlFacts | undefined> {
  const path = def.process?.yamlFilename;
  const repo = def.repository?.id;
  if (!path || !repo || (def.repository?.type && def.repository.type !== "TfsGit")) return undefined;
  try {
    const item = await client.get<{ content?: string }>(`git/repositories/${repo}/items`, {
      path,
      includeContent: true,
      ...(commit ? { "versionDescriptor.version": commit, "versionDescriptor.versionType": "commit" } : {}),
    });
    return item.content ? yamlFacts(item.content) : undefined;
  } catch {
    return undefined;
  }
}

// ---- variables ------------------------------------------------------------------------------------------------------

interface DefVar {
  value?: string;
  isSecret?: boolean;
  allowOverride?: boolean;
}

export interface VarRow {
  name: string;
  value: string | null;
  isSecret: boolean;
  settable: boolean;
}

/** Definition variables merged with the queue-time values of the run; a secret never carries its value. */
export function variablesOf(defVars: Record<string, DefVar> | undefined, queueTime: string | undefined): VarRow[] {
  let q: Record<string, unknown> = {};
  try {
    q = queueTime ? (JSON.parse(queueTime) as Record<string, unknown>) : {};
  } catch {
    q = {};
  }
  const rows = new Map<string, VarRow>();
  for (const [name, v] of Object.entries(defVars ?? {})) rows.set(name.toLowerCase(), { name, value: v.isSecret ? null : (v.value ?? ""), isSecret: !!v.isSecret, settable: !!v.allowOverride });
  for (const [name, v] of Object.entries(q)) {
    const known = rows.get(name.toLowerCase());
    if (known) {
      if (!known.isSecret) known.value = v === null || v === undefined ? known.value : String(v);
    } else {
      const secretish = v === null || v === undefined; // Azure DevOps leaves the value of a queue-time secret out
      rows.set(name.toLowerCase(), { name, value: secretish ? null : String(v), isSecret: secretish, settable: name.toLowerCase() === "system.debug" });
    }
  }
  return [...rows.values()];
}

/** Template parameter values as text; Azure DevOps writes booleans as True/False, YAML and the bar use true/false. */
export function paramValues(tp: Record<string, unknown> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(tp ?? {}).map(([k, v]) => [k, typeof v === "boolean" ? String(v) : /^(True|False)$/.test(String(v)) ? String(v).toLowerCase() : typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)]));
}

// ---- tests ------------------------------------------------------------------------------------------------------------

interface TestRun {
  id: number;
  name?: string;
  totalTests?: number;
  passedTests?: number;
  incompleteTests?: number;
  notApplicableTests?: number;
}

interface TestResult {
  testCaseTitle?: string;
  automatedTestName?: string;
  automatedTestStorage?: string;
  errorMessage?: string;
  stackTrace?: string;
}

/** A retried stage publishes its tests again under the same name: only the newest test run per name counts. */
export function latestTestRuns<T extends { id: number; name?: string }>(runs: T[]): T[] {
  const best = new Map<string, T>();
  for (const r of runs) {
    const k = r.name ?? `#${r.id}`;
    const had = best.get(k);
    if (!had || r.id > had.id) best.set(k, r);
  }
  return [...best.values()].sort((a, b) => a.id - b.id);
}

export interface FirstFailure {
  test: string;
  message: string | null;
  file: string | null;
  line: number | null;
}

/** The short name of a test (`pkg.module.test_x` or `path::test_x` -> `test_x`). */
export const testName = (r: TestResult) => {
  const full = r.automatedTestName ?? r.testCaseTitle ?? "";
  const last = full.split("::").pop() ?? full;
  return /\.test_\w+$|\.\w+$/.test(last) && !last.includes(" ") ? last.slice(last.lastIndexOf(".") + 1) : last;
};

export function firstFailureOf(r: TestResult): FirstFailure {
  const text = `${r.stackTrace ?? ""}\n${r.errorMessage ?? ""}`;
  const links = text.split("\n").flatMap(findLinks);
  const storage = (r.automatedTestStorage ?? "").replace(/\\/g, "/");
  const own = links.find((l) => storage && (l.file === storage || l.file.endsWith(`/${storage}`) || storage.endsWith(l.file)));
  const link = own ?? links.find((l) => /(^|\/)test_[^/]+$|_test\.\w+$/.test(l.file)) ?? links[0];
  const msg = (r.errorMessage ?? "").split("\n").find((l) => l.trim()) ?? null;
  return { test: testName(r), message: msg ? msg.trim().slice(0, 300) : null, file: link?.file ?? null, line: link?.line ?? null };
}

async function testFacts(client: AdoClient, run: number, wantFailure: boolean): Promise<{ total: number; failed: number; first: FirstFailure | null } | null> {
  try {
    const runs = latestTestRuns((await client.get<{ value?: TestRun[] }>("test/runs", { buildUri: `vstfs:///Build/Build/${run}` })).value ?? []);
    if (!runs.length) return null;
    let total = 0;
    let failed = 0;
    for (const r of runs) {
      total += r.totalTests ?? 0;
      failed += Math.max(0, (r.totalTests ?? 0) - (r.passedTests ?? 0) - (r.notApplicableTests ?? 0) - (r.incompleteTests ?? 0));
    }
    let first: FirstFailure | null = null;
    if (wantFailure && failed) {
      for (const r of runs) {
        const res = (await client.get<{ value?: TestResult[] }>(`test/runs/${r.id}/results`, { outcomes: "Failed", $top: 1 })).value ?? [];
        if (res.length) {
          first = firstFailureOf(res[0]);
          break;
        }
      }
    }
    return { total, failed, first };
  } catch {
    return null;
  }
}

// ---- show ------------------------------------------------------------------------------------------------------------

export interface Summary {
  text: string;
  stoppedStage: string | null;
  stoppedStep: string | null;
  stoppedStepId: string | null;
  failedTests: number | null;
  totalTests: number | null;
  firstFailure: FirstFailure | null;
}

export function summaryText(state: RunState, tree: StageNode[], cur: { stage: string | null; step: string | null }, stop: ReturnType<typeof stoppedAt>, tests: { total: number; failed: number } | null, first: FirstFailure | null, firstError: string | null): string {
  if (state === "running" || state === "cancelling") return cur.stage || cur.step ? `Running${cur.stage ? ` stage ${cur.stage}` : ""}${cur.step ? `, step ${cur.step}` : ""}.` : "Running.";
  if (state === "queued") return "Waiting for an agent.";
  const parts: string[] = [];
  if (stop) parts.push(tree.length > 1 || stop.stage.name !== "Pipeline" ? `Stage ${stop.stage.name} ${state === "canceled" ? "was canceled" : "stopped"} at step ${stop.step.name}.` : `Step ${stop.step.name} ${state === "canceled" ? "was canceled" : "failed"}.`);
  else if (state === "succeeded" || state === "partiallySucceeded") {
    const skipped = tree.filter((s) => s.state === "skipped");
    const ran = tree.length - skipped.length;
    parts.push(`${state === "succeeded" ? "Succeeded" : "Partially succeeded"}: ${ran} stage${ran === 1 ? "" : "s"}${skipped.length ? `, skipped ${skipped.map((s) => s.name).join(", ")}` : ""}.`);
  }
  else parts.push(state === "canceled" ? "Canceled." : "Failed.");
  if (tests && (tests.failed || state === "failed")) parts.push(`${tests.failed} of ${tests.total} tests failed.`);
  else if (tests && tests.total) parts.push(`All ${tests.total} tests passed.`);
  if (first) parts.push(`The first failure is ${first.test}${first.file ? ` in ${first.file}${first.line ? `:${first.line}` : ""}` : ""}.`);
  else if (firstError && state === "failed") parts.push(`The first error is: ${firstError}`);
  return parts.join(" ");
}

export interface RunDetail {
  run: {
    id: number;
    number: string | null;
    pipeline: { id: number; name: string };
    state: RunState;
    reason: ReturnType<typeof reasonOf>;
    manual: boolean;
    requestedFor: { name: string; isMe: boolean };
    repo: string | null;
    branch: string;
    commit: { id: string; short: string; message: string | null } | null;
    pr: { id: number; webUrl: string } | null;
    queuedAt: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    waitSeconds: number | null;
    durationSeconds: number | null;
    agent: string | null;
    webUrl: string;
  };
  stages: StageNode[];
  parameters: { name: string; value: string }[];
  variables: { name: string; value: string | null; isSecret: boolean }[];
  summary: Summary;
}

async function commitMessage(client: AdoClient, repoId: string | undefined, sha: string | undefined): Promise<string | null> {
  if (!repoId || !sha) return null;
  try {
    const c = await client.get<{ comment?: string }>(`git/repositories/${repoId}/commits/${sha}`);
    return (c.comment ?? "").split("\n")[0].trim() || null;
  } catch {
    return null;
  }
}

async function activePr(client: AdoClient, b: RawBuild): Promise<{ id: number; webUrl: string } | null> {
  const repo = b.repository?.name ?? client.remote.repo;
  const prUrl = (id: number) => `${client.remote.orgUrl}/${encodeURIComponent(client.remote.project)}/_git/${encodeURIComponent(repo)}/pullrequest/${id}`;
  const fromTrigger = Number(b.triggerInfo?.["pr.number"]);
  if (Number.isInteger(fromTrigger) && fromTrigger > 0) return { id: fromTrigger, webUrl: prUrl(fromTrigger) };
  if (!b.sourceBranch?.startsWith("refs/heads/") || !b.repository?.id) return null;
  try {
    const prs = (await client.get<{ value?: { pullRequestId: number }[] }>(`git/repositories/${b.repository.id}/pullrequests`, { "searchCriteria.sourceRefName": b.sourceBranch, "searchCriteria.status": "active", $top: 1 })).value ?? [];
    return prs[0] ? { id: prs[0].pullRequestId, webUrl: prUrl(prs[0].pullRequestId) } : null;
  } catch {
    return null;
  }
}

/** `aihub pipeline show --run N`: one run in one answer (tree, trigger, parameters, variables, summary). */
export async function pipelineShow(ctx: Ctx, o: { run: number; repoDir?: string }): Promise<RunDetail> {
  const client = clientAt(ctx, o.repoDir ?? ctx.cwd);
  const now = ctx.now?.() ?? Date.now();
  const b = await client.get<RawBuild>(`build/builds/${o.run}`);
  const state = runState(b);
  const recs = (await client.get<{ records?: Rec[] }>(`build/builds/${o.run}/timeline`).catch(() => ({ records: [] as Rec[] }))).records ?? [];
  const def = b.definition?.id
    ? await client.get<{ variables?: Record<string, DefVar>; process?: { yamlFilename?: string }; repository?: { id?: string; type?: string } }>(`build/definitions/${b.definition.id}`).catch(() => undefined)
    : undefined;
  const yaml = def ? await yamlAt(client, def, b.sourceVersion) : undefined;
  const tree = treeOf(recs, (r, j) => recUrl(client, o.run, r, j), yaml?.stageDeps, now);
  const stop = isFinished(state) ? stoppedAt(tree) : undefined;
  const tests = isFinished(state) ? await testFacts(client, o.run, state === "failed") : null;
  let firstError: string | null = null;
  let first = tests?.first ?? null;
  if (stop?.step.logId && (!first || !first.file)) {
    try {
      const log = readableLog(await client.getText(`build/builds/${o.run}/logs/${stop.step.logId}`), { tail: 1 });
      firstError = log.firstError?.text ?? null;
      if (first && !first.file && log.firstError?.file) first = { ...first, file: log.firstError.file, line: log.firstError.line ?? null };
    } catch {
      firstError = null;
    }
  }
  const myId = (await me(ctx, client).catch(() => undefined))?.id;
  const firstJob = tree.flatMap((s) => s.jobs).find((j) => j.agent);
  const sha = b.sourceVersion;
  const cur = currentOf(recs);
  return {
    run: {
      id: b.id,
      number: b.buildNumber ?? null,
      pipeline: { id: b.definition?.id ?? 0, name: b.definition?.name ?? "pipeline" },
      state,
      reason: reasonOf(b.reason),
      manual: b.reason === "manual",
      requestedFor: { name: b.requestedFor?.displayName ?? "", isMe: !!myId && b.requestedFor?.id?.toLowerCase() === myId.toLowerCase() },
      repo: b.repository?.name ?? null,
      branch: branchOf(b),
      commit: sha ? { id: sha, short: sha.slice(0, 7), message: await commitMessage(client, b.repository?.id, sha) } : null,
      pr: await activePr(client, b),
      queuedAt: b.queueTime ?? null,
      startedAt: b.startTime ?? null,
      finishedAt: b.finishTime ?? null,
      waitSeconds: seconds(b.queueTime, b.startTime),
      durationSeconds: seconds(b.startTime, b.finishTime, isFinished(state) ? undefined : now),
      agent: (stop?.job.agent ?? firstJob?.agent) || null,
      webUrl: b._links?.web?.href ?? runUrl(client, b.id),
    },
    stages: tree,
    parameters: Object.entries(paramValues(b.templateParameters)).map(([name, value]) => ({ name, value })),
    variables: variablesOf(def?.variables, b.parameters).map(({ name, value, isSecret }) => ({ name, value, isSecret })),
    summary: {
      text: summaryText(state, tree, cur, stop, tests, first, firstError),
      stoppedStage: stop?.stage.name ?? null,
      stoppedStep: stop?.step.name ?? null,
      stoppedStepId: stop?.step.id ?? null,
      failedTests: tests ? tests.failed : null,
      totalTests: tests ? tests.total : null,
      firstFailure: first,
    },
  };
}

// ---- poll ------------------------------------------------------------------------------------------------------------

export interface PollResult {
  id: number;
  pipeline: string;
  state: RunState;
  finished: boolean;
  currentStage: string | null;
  currentStep: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationSeconds: number | null;
  failedStage: string | null;
  failedStep: string | null;
  tests: { failed: number; total: number } | null;
  webUrl: string;
}

/** `aihub pipeline poll --run N`: the cheap read the bar repeats every 15 s for a run of mine (build + timeline). */
export async function pipelinePoll(ctx: Ctx, o: { run: number; repoDir?: string }): Promise<PollResult> {
  const client = clientAt(ctx, o.repoDir ?? ctx.cwd);
  const now = ctx.now?.() ?? Date.now();
  const b = await client.get<RawBuild>(`build/builds/${o.run}`);
  const state = runState(b);
  const recs = state === "queued" ? [] : ((await client.get<{ records?: Rec[] }>(`build/builds/${o.run}/timeline`).catch(() => ({ records: [] as Rec[] }))).records ?? []);
  const finished = isFinished(state);
  const cur = currentOf(recs);
  const stop = finished ? stoppedAt(treeOf(recs, () => "")) : undefined;
  const t = finished && state === "failed" ? await testFacts(client, o.run, false) : null;
  return {
    id: b.id,
    pipeline: b.definition?.name ?? "pipeline",
    state,
    finished,
    currentStage: cur.stage,
    currentStep: cur.step,
    startedAt: b.startTime ?? null,
    finishedAt: b.finishTime ?? null,
    durationSeconds: seconds(b.startTime, b.finishTime, finished ? undefined : now),
    failedStage: stop?.stage.name ?? null,
    failedStep: stop?.step.name ?? null,
    tests: t ? { failed: t.failed, total: t.total } : null,
    webUrl: b._links?.web?.href ?? runUrl(client, b.id),
  };
}

// ---- log -------------------------------------------------------------------------------------------------------------

export interface LogResult extends ReadableLog {
  run: number;
  step: { id: string; name: string; stage: string | null; job: string | null; state: RecState; durationSeconds: number | null; webUrl: string };
  final: boolean;
}

/** `aihub pipeline log --run N --step S`: one step log made readable (S is a step id from `show`, or a name). */
export async function pipelineLog(ctx: Ctx, o: { run: number; step?: string; tail?: number; fromLine?: number; repoDir?: string }): Promise<LogResult> {
  const client = clientAt(ctx, o.repoDir ?? ctx.cwd);
  const now = ctx.now?.() ?? Date.now();
  const recs = (await client.get<{ records?: Rec[] }>(`build/builds/${o.run}/timeline`)).records ?? [];
  const tree = treeOf(recs, (r, j) => recUrl(client, o.run, r, j), undefined, now);
  const all = tree.flatMap((s) => s.jobs.flatMap((j) => j.steps.map((t) => ({ s, j, t }))));
  let hit: (typeof all)[number] | undefined;
  if (o.step) {
    const needle = o.step.toLowerCase();
    hit = all.find((x) => x.t.id.toLowerCase() === needle) ?? all.filter((x) => x.t.name.toLowerCase() === needle).sort((a, b) => Number(b.t.state === "failed") - Number(a.t.state === "failed"))[0] ?? all.find((x) => x.t.name.toLowerCase().includes(needle));
    if (!hit) throw new AihubError(`run ${o.run}: no step '${o.step}' (steps: ${[...new Set(all.map((x) => x.t.name))].join(", ")})`);
  } else {
    const stop = stoppedAt(tree);
    hit = stop ? all.find((x) => x.t.id === stop.step.id) : undefined;
    if (!hit) throw new AihubError(`run ${o.run}: no failed step; pass --step <id or name> (see 'aihub pipeline show --run ${o.run}')`);
  }
  const step = { id: hit.t.id, name: hit.t.name, stage: hit.s.name === "Pipeline" && hit.s.identifier === "__default" ? null : hit.s.name, job: hit.j.name, state: hit.t.state, durationSeconds: hit.t.durationSeconds, webUrl: hit.t.webUrl };
  const final = hit.t.state !== "running" && hit.t.state !== "pending";
  if (!hit.t.logId) return { run: o.run, step, final, totalLines: 0, lines: [], firstError: null, counts: { errors: 0, warnings: 0 }, sections: [], truncated: false };
  const text = await client.getText(`build/builds/${o.run}/logs/${hit.t.logId}`, o.fromLine ? { startLine: o.fromLine } : undefined);
  return { run: o.run, step, final, ...readableLog(text, { tail: o.tail ?? 2000, firstLine: o.fromLine ?? 1 }) };
}

// ---- run again: read the form, queue the changed run ---------------------------------------------------------------------

export interface PlanParam extends ParamDef {
  value: string | null;
}

export interface PlanStage {
  identifier: string;
  name: string;
  dependsOn: string[];
  requiredBy: string[];
  canSkip: boolean;
}

export interface RunAgainPlan {
  run: { id: number; pipeline: { id: number; name: string }; branch: string; sourceBranch: string; commit: { id: string; short: string; message: string | null } | null };
  latestCommit: { id: string; short: string; message: string | null; newerCount: number | null } | null;
  parameters: PlanParam[];
  variables: VarRow[];
  stages: PlanStage[];
  dependencySource: "yaml" | "order";
}

/** Stage dependencies both ways; a stage may be skipped only when no other stage depends on it. */
export function planStages(stages: { identifier: string; name: string }[], deps: Map<string, string[]> | undefined): PlanStage[] {
  const out = stages.map((s, i) => ({ identifier: s.identifier, name: s.name, dependsOn: deps?.get(s.identifier) ?? (i > 0 ? [stages[i - 1].identifier] : []), requiredBy: [] as string[], canSkip: false }));
  for (const s of out) for (const d of s.dependsOn) out.find((x) => x.identifier === d)?.requiredBy.push(s.identifier);
  for (const s of out) s.canSkip = s.requiredBy.length === 0;
  return out;
}

/** Refuses a skip set in which a stage that still runs depends on a skipped one. */
export function checkSkips(stages: PlanStage[], skip: string[]): string[] {
  const ids = skip.map((s) => {
    const hit = stages.find((x) => x.identifier.toLowerCase() === s.toLowerCase() || x.name.toLowerCase() === s.toLowerCase());
    if (!hit) throw new AihubError(`no stage '${s}' (stages: ${stages.map((x) => x.identifier).join(", ")})`);
    return hit.identifier;
  });
  for (const id of ids) {
    const runs = stages.find((x) => x.identifier === id)!.requiredBy.filter((r) => !ids.includes(r));
    if (runs.length) throw new AihubError(`stage ${id} cannot be skipped: ${runs.join(", ")} depends on it (skip those too, or keep ${id})`);
  }
  return ids;
}

async function branchCommits(client: AdoClient, repoId: string | undefined, branch: string): Promise<{ commitId: string; comment?: string }[]> {
  if (!repoId || !branch) return [];
  try {
    return (await client.get<{ value?: { commitId: string; comment?: string }[] }>(`git/repositories/${repoId}/commits`, { "searchCriteria.itemVersion.version": branch, "searchCriteria.itemVersion.versionType": "branch", "searchCriteria.$top": 50 })).value ?? [];
  } catch {
    return [];
  }
}

async function loadPlan(ctx: Ctx, client: AdoClient, run: number): Promise<{ plan: RunAgainPlan; build: RawBuild }> {
  const b = await client.get<RawBuild>(`build/builds/${run}`);
  if (!b.definition?.id) throw new AihubError(`run ${run} has no pipeline definition`);
  const def = await client.get<{ variables?: Record<string, DefVar>; process?: { yamlFilename?: string }; repository?: { id?: string; type?: string } }>(`build/definitions/${b.definition.id}`);
  const yaml = await yamlAt(client, def, b.sourceVersion);
  const recs = (await client.get<{ records?: Rec[] }>(`build/builds/${run}/timeline`).catch(() => ({ records: [] as Rec[] }))).records ?? [];
  const timelineStages = recs.filter((r) => r.type === "Stage" && r.name !== "__default").sort(byOrder).map((r) => ({ identifier: r.identifier ?? r.name, name: r.name }));
  const yamlStages = yaml?.stageDeps ? [...yaml.stageDeps.keys()].map((id) => ({ identifier: id, name: timelineStages.find((t) => t.identifier === id)?.name ?? id })) : [];
  const stageList = yamlStages.length ? yamlStages : timelineStages;
  const branch = branchOf(b);
  const prRun = (b.sourceBranch ?? "").startsWith("refs/pull/");
  const commits = await branchCommits(client, b.repository?.id, branch);
  const sha = b.sourceVersion;
  const idx = sha ? commits.findIndex((c) => c.commitId === sha) : -1;
  const head = commits[0];
  const firstLine = (s?: string) => (s ?? "").split("\n")[0].trim() || null;
  const own = idx >= 0 ? firstLine(commits[idx].comment) : await commitMessage(client, b.repository?.id, sha);
  const tp = paramValues(b.templateParameters);
  const params: PlanParam[] = (yaml?.parameters ?? []).map((p) => ({ ...p, value: p.name in tp ? tp[p.name] : p.default === null || p.default === undefined ? null : typeof p.default === "object" ? JSON.stringify(p.default) : String(p.default) }));
  for (const [k, v] of Object.entries(tp)) if (!params.some((p) => p.name === k)) params.push({ name: k, displayName: null, type: "string", default: null, values: null, value: String(v) });
  return {
    build: b,
    plan: {
      run: { id: b.id, pipeline: { id: b.definition.id, name: b.definition.name }, branch, sourceBranch: b.sourceBranch ?? "", commit: sha ? { id: sha, short: sha.slice(0, 7), message: own } : null },
      latestCommit: head && !prRun ? { id: head.commitId, short: head.commitId.slice(0, 7), message: firstLine(head.comment), newerCount: idx >= 0 ? idx : null } : null,
      parameters: params,
      variables: variablesOf(def.variables, b.parameters),
      stages: planStages(stageList, yaml?.stageDeps),
      dependencySource: yaml?.stageDeps ? "yaml" : "order",
    },
  };
}

export interface Changes {
  parameters?: Record<string, unknown>;
  variables?: Record<string, unknown>;
  skipStages?: string[];
}

export function readChanges(file: string | undefined): Changes {
  if (!file) return {};
  let c: unknown;
  try {
    c = JSON.parse(readUtf8(file));
  } catch (e) {
    throw new AihubError(`--changes-file ${file} is not JSON: ${(e as Error).message}`);
  }
  if (!c || typeof c !== "object" || Array.isArray(c)) throw new AihubError('--changes-file must hold { "parameters": {}, "variables": {}, "skipStages": [] }');
  const x = c as Changes;
  if (x.skipStages !== undefined && !Array.isArray(x.skipStages)) throw new AihubError("skipStages in --changes-file must be a list of stage names");
  return x;
}

/** Checks the changed parameters against their YAML type and allowed values; returns the full set to queue with. */
export function mergeParameters(plan: PlanParam[], changes: Record<string, unknown> = {}): { all: Record<string, string>; changed: string[] } {
  const all: Record<string, string> = {};
  for (const p of plan) if (p.value !== null) all[p.name] = p.value;
  const changed: string[] = [];
  for (const [k, raw] of Object.entries(changes)) {
    const p = plan.find((x) => x.name === k) ?? plan.find((x) => x.name.toLowerCase() === k.toLowerCase());
    if (!p && plan.length) throw new AihubError(`no parameter '${k}' (parameters: ${plan.map((x) => x.name).join(", ")})`);
    const name = p?.name ?? k;
    let v = typeof raw === "object" && raw !== null ? JSON.stringify(raw) : String(raw);
    if (p?.type === "boolean") {
      if (!/^(true|false)$/i.test(v)) throw new AihubError(`parameter ${name} is a boolean: use true or false, not '${v}'`);
      v = v.toLowerCase();
    }
    if (p?.type === "number" && Number.isNaN(Number(v))) throw new AihubError(`parameter ${name} is a number, not '${v}'`);
    if (p?.values?.length && !p.values.includes(v)) throw new AihubError(`parameter ${name} allows ${p.values.join(", ")}, not '${v}'`);
    if (all[name] !== v) changed.push(name);
    all[name] = v;
  }
  return { all, changed };
}

/** Variables to queue with: the previous non-secret settable values, plus what changed; a secret only when given. */
export function mergeVariables(plan: VarRow[], changes: Record<string, unknown> = {}): { send: Record<string, { value: string; isSecret?: boolean }>; changed: string[] } {
  const send: Record<string, { value: string; isSecret?: boolean }> = {};
  for (const v of plan) if (v.settable && !v.isSecret && v.value !== null) send[v.name] = { value: v.value };
  const changed: string[] = [];
  for (const [k, raw] of Object.entries(changes)) {
    if (raw === null || raw === undefined) continue; // not filled in: a secret keeps its value
    const v = plan.find((x) => x.name.toLowerCase() === k.toLowerCase());
    if (!v || !v.settable) throw new AihubError(`variable ${k} cannot be set when queuing (only variables marked 'settable at queue time': ${plan.filter((x) => x.settable).map((x) => x.name).join(", ") || "none"})`);
    const value = String(raw);
    if (v.isSecret || v.value !== value) changed.push(v.name);
    send[v.name] = v.isSecret ? { value, isSecret: true } : { value };
  }
  return { send, changed };
}

export interface RunAgainResult {
  id: number;
  number: string | null;
  pipeline: string;
  branch: string;
  commit: string | null;
  skipped: string[];
  changed: { parameters: string[]; variables: string[] };
  webUrl: string;
}

/**
 * `aihub pipeline run-again --run N [--plan]`: with --plan the form (what the run had, what may change, which stages may be
 * skipped); without it a new run of the same pipeline with the changes of --changes-file, on the same or the latest commit.
 */
export async function pipelineRunAgain(ctx: Ctx, o: { run: number; plan?: boolean; commit?: string; changesFile?: string; repoDir?: string }): Promise<RunAgainPlan | RunAgainResult> {
  const client = clientAt(ctx, o.repoDir ?? ctx.cwd);
  const { plan, build } = await loadPlan(ctx, client, o.run);
  if (o.plan) return plan;
  const changes = readChanges(o.changesFile);
  const commitMode = o.commit ?? "same";
  if (!["same", "latest"].includes(commitMode)) throw new AihubError("--commit must be same or latest");
  const skipped = checkSkips(plan.stages, changes.skipStages ?? []);
  const params = mergeParameters(plan.parameters, changes.parameters);
  const vars = mergeVariables(plan.variables, changes.variables);
  const version = commitMode === "same" ? plan.run.commit?.id : (plan.latestCommit?.id ?? undefined);
  const refName = plan.run.sourceBranch || branchRef(plan.run.branch);
  const body = {
    resources: { repositories: { self: { refName, ...(version && !refName.startsWith("refs/pull/") ? { version } : {}) } } },
    ...(Object.keys(params.all).length ? { templateParameters: params.all } : {}),
    ...(Object.keys(vars.send).length ? { variables: vars.send } : {}),
    ...(skipped.length ? { stagesToSkip: skipped } : {}),
  };
  const r = await client.post<{ id: number; name?: string; _links?: { web?: { href?: string } } }>(`pipelines/${plan.run.pipeline.id}/runs`, body);
  return {
    id: r.id,
    number: r.name ?? null,
    pipeline: plan.run.pipeline.name,
    branch: plan.run.branch,
    commit: version ?? build.sourceVersion ?? null,
    skipped,
    changed: { parameters: params.changed, variables: vars.changed },
    webUrl: runUrl(client, r.id),
  };
}
