import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AihubError } from "../lib/errors.js";
import { FabricHttpError, guardEnv, inferEnv, type FabricClient, type FabricItem, type JobInstance } from "../lib/fabric.js";
import { causeOfChain, classifyError, codeRefusals, errorsOnly, failedCell, parseSqlHost, rememberRun, searchLines, SPARK_VIEWS, sparkExecutor, sparkJob, sparkSql, sparkStage, sparkTask, sqlGuard, stagesSummary, tailLines, branchWorkspace, type SparkView } from "../lib/fabric-diag.js";
import { COMMANDS, findProfiles, findProjects, jobDefinition, projectFiles, readRunResults, logTail, safeProjectDir, scaffoldFiles, setHash, writeScaffold, routeOf, MAX_FILES } from "../lib/fabric-dbt.js";
import { durationText, extractStack, oneLine, parseUtc, toTable } from "../lib/fabric-ops.js";
import { redact } from "../lib/fabric-redact.js";
import { isDroppedConnection, powershellSqlQuery } from "../lib/fabric-sql-fallback.js";
import { readKeyVaultSecret } from "../lib/fabric-auth.js";
import { dryRun, emit, itemArg, makeClient, need, target, where, type Setup, type Target } from "./fabric.js";
import { slim } from "./fabric-api.js";

const SEG: Record<string, string> = { Notebook: "notebooks", SparkJobDefinition: "sparkJobDefinitions", Lakehouse: "lakehouses" };
const segOf = (item: FabricItem) => {
  const s = SEG[item.type];
  if (!s) throw new AihubError(`${item.type} '${item.displayName}' has no Spark sessions (Notebook, SparkJobDefinition or Lakehouse)`);
  return s;
};
const isNum = (s: unknown) => typeof s === "string" && /^\d+$/.test(s);
const num = (s: Setup, key: string, d: number) => (s.v[key] === undefined ? d : Number(s.v[key]));
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- Spark monitoring --------------------------------------------------------------------------------------------

interface Session {
  livyId: string;
  sparkApplicationId?: string;
  state?: string;
  jobInstanceId?: string;
  itemName?: string;
  [k: string]: unknown;
}

async function findSession(client: FabricClient, wsId: string, item: FabricItem, want: { livy?: string; job?: string }): Promise<Session> {
  const all = await client.list<Session>(`/workspaces/${wsId}/${segOf(item)}/${item.id}/livySessions`);
  const hit = want.livy ? all.find((x) => x.livyId?.toLowerCase() === want.livy!.toLowerCase()) : want.job ? all.find((x) => String(x.jobInstanceId ?? "").toLowerCase() === want.job!.toLowerCase()) : all.sort((a, b) => String(b.submittedDateTime ?? b.startDateTime ?? "").localeCompare(String(a.submittedDateTime ?? a.startDateTime ?? "")))[0];
  if (!hit) throw new AihubError(want.livy || want.job ? `no Spark session ${want.livy ? `with id ${want.livy}` : `for job ${want.job}`} on ${item.displayName}; list them with: aihub fabric spark sessions --item ${item.displayName}` : `${item.displayName} has no Spark sessions`);
  return hit;
}

export const CAPACITY_HINT = (ws: string) => `the capacity is full (a trial capacity runs one Spark session at a time): free it with: aihub fabric spark stop --workspace ${ws} --all-mine --dry-run`;

/** Object id (`oid`) of the signed-in identity, read from the unverified Fabric token; undefined for an opaque token. */
function oidOf(token: string): string | undefined {
  try {
    return JSON.parse(Buffer.from(token.replace(/^Bearer /, "").split(".")[1], "base64url").toString("utf8")).oid;
  } catch {
    return undefined;
  }
}

const ENDED = /^(dead|killed|error|failed|cancelled|canceled|succeeded|success|completed|stopped|shutting_down|notstarted)$/i;

/** `aihub fabric spark stop`: closes idle or stuck Spark sessions that block the capacity (Livy API session: DELETE; notebook session: cancel its job). Dev/feature workspaces only. */
async function sparkStop(s: Setup, client: FabricClient): Promise<void> {
  const t = await target(s, client, true);
  const one = s.v.session as string | undefined;
  if (!one && !s.v["all-mine"]) throw new AihubError("usage: aihub fabric spark stop --workspace W (--session <livyId> | --all-mine) [--dry-run] [--yes]");
  const all = await client.list<Session>(`/workspaces/${t.id}/spark/livySessions`);
  // --all-mine: only sessions the signed-in identity submitted (oid of the Fabric token; an opaque token cannot tell, then every active session counts)
  const me = one ? undefined : oidOf(await client.identity!.token("fabric"));
  const pick = one ? all.filter((x) => x.livyId?.toLowerCase() === one.toLowerCase()) : all.filter((x) => !ENDED.test(String(x.state ?? "")) && (!me || String((x as any).submitter?.id ?? "").toLowerCase() === me.toLowerCase()));
  if (!pick.length) {
    if (one) throw new AihubError(`no Spark session ${one} in ${where(t)}; list them with: aihub fabric spark sessions --workspace ${t.ws.name}`);
    return emit(s, { stopped: [] }, `no active Spark session in ${where(t)}`);
  }
  // the monitoring API names the item in `item.itemId` and writes the type in lower case ("lakehouse"); a Lakehouse Livy API session reports its own id as job id
  const itemOf = (x: Session) => String((x.item as { itemId?: string } | undefined)?.itemId ?? x.itemId);
  const isLivy = (x: Session) => String(x.itemType).toLowerCase() === "lakehouse" || !x.jobInstanceId;
  const how = (x: Session) => (isLivy(x) ? "close the Livy session" : "cancel the job");
  const plan = pick.map((x) => `${how(x)} ${x.livyId} (${String(x.state ?? "?")}, ${String(x.itemName ?? x.itemId ?? "?")}) in ${where(t)}`);
  if (s.v["dry-run"]) return dryRun(s, plan);
  if (!one && !s.v.yes) throw new AihubError(`--all-mine stops ${pick.length} session(s) in ${where(t)}; add --yes after checking with --dry-run`);
  const stopped: string[] = [];
  const failed: string[] = [];
  for (const x of pick) {
    try {
      if (isLivy(x)) await client.request("DELETE", `/workspaces/${t.id}/${String(x.itemType).toLowerCase() === "notebook" ? "notebooks" : "lakehouses"}/${itemOf(x)}/livyapi/versions/2023-12-01/sessions/${x.livyId}`);
      else await client.cancelJob(t.id, itemOf(x), x.jobInstanceId!);
      stopped.push(x.livyId);
    } catch (e) {
      failed.push(`${x.livyId}: ${(e as Error).message}`);
    }
  }
  emit(s, { stopped, failed }, `stopped ${stopped.length} Spark session(s) in ${where(t)}${failed.length ? `; failed: ${failed.join("; ")}` : ""}`);
  if (failed.length) throw new AihubError(`${failed.length} Spark session(s) could not be stopped`);
}

/** `aihub fabric spark sessions|app|logs|stop`: Spark sessions of a workspace or item, application views, driver/executor/Livy logs. */
export async function sparkCmd(s: Setup, sub: string | undefined): Promise<void> {
  const client = makeClient(s.ctx, s.v);
  if (sub === "stop") return sparkStop(s, client);
  const t = await target(s, client, false);
  if (sub === "sessions") {
    const item = s.v.item ? await itemArg(s, client, t.id) : undefined;
    const path = item ? `/workspaces/${t.id}/${segOf(item)}/${item.id}/livySessions` : `/workspaces/${t.id}/spark/livySessions`;
    const state = (s.v.state as string | undefined)?.toLowerCase();
    let rows = await client.list<Session>(path);
    if (state) rows = rows.filter((x) => String(x.state ?? "").toLowerCase() === state);
    rows = rows.slice(0, num(s, "top", 20));
    return emit(s, rows, rows.length ? [`${rows.length} Spark session(s) in ${where(t)}`, toTable([["livy", "state", "item", "application", "job"], ...rows.map((x) => [x.livyId, String(x.state ?? "-"), String(x.itemName ?? item?.displayName ?? "-"), x.sparkApplicationId ?? "-", x.jobInstanceId ?? "-"])])].join("\n") : "no Spark sessions");
  }
  const item = await itemArg(s, client, t.id);
  const session = await findSession(client, t.id, item, { livy: s.v.livy as string | undefined, job: s.v.job as string | undefined });
  const base = `/workspaces/${t.id}/${segOf(item)}/${item.id}/livySessions/${session.livyId}/applications`;
  const app = session.sparkApplicationId;
  if (sub === "app") {
    if (!app) throw new AihubError(`Spark session ${session.livyId} has no Spark application (yet)`);
    const view = ((s.v.view as string | undefined) ?? "application") as SparkView | "advice";
    if (![...SPARK_VIEWS, "advice"].includes(view)) throw new AihubError(`--view must be one of ${[...SPARK_VIEWS, "advice"].join(", ")}`);
    const at = "1"; // Spark application attempt used by the Fabric history server views
    const status = s.v.status as string | undefined;
    if (status && !/^[A-Za-z]{1,20}$/.test(status)) throw new AihubError("--status is one word such as failed");
    const full = !!s.v.full;
    const stage = s.v.stage as string | undefined;
    const get = async (p: string) => (await client.request("GET", `${base}/${app}/${p}`)).data;
    let data: any;
    let text: string;
    if (view === "application") {
      data = await get(at);
      text = JSON.stringify(slim(data), null, 1);
    } else if (view === "jobs") {
      const jobs = ((await get(`${at}/jobs${status ? `?status=${status.toLowerCase()}` : ""}`)) as any[]).map(sparkJob);
      data = jobs;
      text = `${jobs.length} job(s)\n${toTable([["job", "status", "tasks", "failed", "ms", "name"], ...jobs.slice(0, 50).map((j: any) => [j.jobId, j.status, j.numTasks, j.numFailedTasks, j.durationMs ?? "-", oneLine(j.name, 50)])])}`;
    } else if (view === "stages") {
      const stages = stage ? [await get(`${at}/stages/${stage}`)].flat() : ((await get(`${at}/stages${status ? `?status=${status.toLowerCase()}` : ""}`)) as any[]);
      data = stages.map((x: any) => sparkStage(x, full));
      text = `${stages.length} stage(s); worst first\n${stagesSummary(stages).join("\n")}`;
    } else if (view === "tasks") {
      if (!stage) throw new AihubError("--view tasks needs --stage <id> (view stages lists them)");
      const tasks = ((await get(`${at}/stages/${stage}/${num(s, "stage-attempt", 0)}/taskList?length=${Math.min(num(s, "top", 100), 1000)}${status ? `&status=${status.toUpperCase()}` : ""}`)) as any[]).map(sparkTask);
      data = tasks;
      text = `${tasks.length} task(s)\n${tasks.map((x: any) => `task ${x.taskId} ${x.status} executor ${x.executorId}${x.errorMessage ? `: ${oneLine(x.errorMessage, 200)}` : ""}`).join("\n")}`;
    } else if (view === "executors") {
      const ex = ((await get(`${at}/allexecutors`)) as any[]).map(sparkExecutor);
      data = ex;
      text = `${ex.length} executor(s)\n${toTable([["id", "active", "failed tasks", "gc ms", "container"], ...ex.map((x: any) => [x.id, x.isActive, x.failedTasks ?? 0, x.totalGCTime ?? "-", x.containerId ?? "-"])])}`;
    } else if (view === "sql") {
      const id = s.v["sql-id"] as string | undefined;
      const q = id ? await get(`${at}/sql/${id}?details=true&planDescription=true`) : await get(`${at}/sql?details=false&planDescription=${full}&offset=0&length=${Math.min(num(s, "top", 100), 1000)}`);
      data = Array.isArray(q) ? q.map((x: any) => sparkSql(x, full)) : sparkSql(q, true);
      text = JSON.stringify(slim(data), null, 1);
    } else if (view === "environment") {
      const e = await get(`${at}/environment`);
      data = { sparkProperties: (e.sparkProperties ?? []).map(([k, v]: [string, string]) => [k, /secret|password|token|key/i.test(k) ? "<redacted>" : v]), runtime: e.runtime };
      text = JSON.stringify(slim(data), null, 1);
    } else {
      data = await get(view);
      text = JSON.stringify(slim(data), null, 1);
    }
    return emit(s, { session: session.livyId, view, data }, `Spark session ${session.livyId} (${session.state ?? "?"}), view ${view}\n${text}`);
  }
  if (sub === "logs") return sparkLogs(s, client, t, item, session, base);
  throw new AihubError("usage: aihub fabric spark sessions|app|logs|stop --workspace W --item I [--livy ID|--job ID]");
}

/** Driver, executor, Livy or rolling driver log of a session, with tail/search/errors/cell windows. */
async function sparkLogs(s: Setup, client: FabricClient, t: Target, item: FabricItem, session: Session, base: string): Promise<void> {
  const type = ((s.v["log-type"] as string | undefined) ?? "driver").toLowerCase();
  const app = session.sparkApplicationId;
  const file = (s.v.file as string | undefined) ?? "stderr";
  // Fabric Spark monitoring API: Livy log https://learn.microsoft.com/en-us/fabric/data-engineering/livy-log,
  // driver log https://learn.microsoft.com/en-us/fabric/data-engineering/driver-log (paths below are those pages' URL patterns)
  let path: string;
  if (type === "livy") path = `${base}/none/logs?type=livy`;
  else {
    if (!app) throw new AihubError(`Spark session ${session.livyId} has no Spark application (yet)`);
    if (type === "driver") path = `${base}/${app}/logs?type=driver&fileName=${encodeURIComponent(file)}`;
    else if (type === "executor") path = `${base}/${app}/logs?type=executor&containerId=${encodeURIComponent(need(s.v, "container", "container id from spark app --view executors"))}&fileName=${encodeURIComponent(file)}`;
    else throw new AihubError("--log-type must be driver, executor or livy");
  }
  const r = await client.request("GET", path, undefined, { accept: "*/*" });
  let text = redact(r.text);
  const cell = failedCell(text);
  if (s.v.cell) {
    if (!cell) return emit(s, { cell: null }, "no failed notebook cell found in this log (the cell traceback is in the driver stdout: --file stdout)");
    return emit(s, { cell }, `failed cell ${cell.cell}, line ${cell.line}${cell.code ? `: ${cell.code}` : ""}\n${cell.exception ?? ""}`);
  }
  if (s.v.errors) text = errorsOnly(text);
  if (s.v.search) {
    const r2 = searchLines(text, s.v.search as string, num(s, "context", 2));
    return emit(s, r2, `${r2.matches.length} match(es)${r2.truncated ? " (truncated)" : ""} in ${type} log ${file}\n${r2.matches.map((m) => `-- line ${m.line}\n${m.text}`).join("\n")}`);
  }
  if (s.v.tail) text = tailLines(text, num(s, "tail", 100));
  const cause = classifyError(text);
  emit(s, { session: session.livyId, type, file, cause, text }, `${type} log ${type === "livy" ? "" : file} of session ${session.livyId}${cause.kind !== "unknown" ? ` (likely cause: ${cause.kind}: ${cause.hint})` : ""}\n${text.slice(0, 20_000)}`);
}

// ---- Livy statements ----------------------------------------------------------------------------------------------------

/** `aihub fabric livy run`: one Spark SQL or PySpark statement in a Lakehouse (legacy FabricLivyClient); the session is always closed. */
export async function livyCmd(s: Setup, sub: string | undefined): Promise<void> {
  if (sub !== "run") throw new AihubError("usage: aihub fabric livy run --workspace W --lakehouse L --code <text>|--code-file F [--kind sql|pyspark]");
  const client = makeClient(s.ctx, s.v);
  const code = s.v.code ? (s.v.code as string) : s.v["code-file"] ? readFileSync(s.v["code-file"] as string, "utf8") : "";
  if (!code.trim()) throw new AihubError("needs --code <text> or --code-file <file>");
  if (code.length > 20_000) throw new AihubError("the code is longer than 20000 characters");
  const k = ((s.v.kind as string | undefined) ?? "sql").toLowerCase();
  const kind = ["sql", "sparksql", "spark_sql"].includes(k) ? "sql" : ["pyspark", "python"].includes(k) ? "pyspark" : undefined;
  if (!kind) throw new AihubError(`--kind must be sql or pyspark (got '${k.slice(0, 40)}')`);
  const t = await target(s, client, true);
  const lh = await client.resolveItem(t.id, need(s.v, "lakehouse", "name|id"), "Lakehouse");
  const refusals = codeRefusals(code, { id: t.id, name: t.ws.name }, await client.workspaces());
  if (refusals.length) throw new AihubError(`Blocked before the run: ${refusals.join(" ")} Nothing was run.`);
  if (s.v["dry-run"]) return dryRun(s, [`run a ${kind} statement in ${lh.displayName} (${where(t)}): ${oneLine(code, 80)}`]);
  const base = `/workspaces/${t.id}/lakehouses/${lh.id}/livyapi/versions/2023-12-01/sessions`;
  const timeoutMs = num(s, "timeout", 300) * 1000;
  const deadline = Date.now() + timeoutMs;
  const poll = Number(s.ctx.env.AIHUB_POLL_MS ?? 3000);
  const created = await client.request("POST", base, { name: `aihub-${Date.now()}`, conf: {} });
  const sid = created.data?.id as string | undefined;
  if (!sid) throw new AihubError("Fabric started no Livy session (no id)");
  const progress: string[] = [];
  const wait = async (read: () => Promise<string>, final: string[]) => {
    let st = await read();
    while (!final.includes(st) && Date.now() < deadline) {
      if (progress.at(-1) !== st) progress.push(st);
      if (poll > 0) await new Promise((r) => setTimeout(r, poll));
      st = await read();
    }
    if (progress.at(-1) !== st) progress.push(st);
    return st;
  };
  try {
    const st = await wait(async () => String(((await client.request("GET", `${base}/${sid}`)).data as any).state ?? "unknown").toLowerCase(), ["idle", "busy", "error", "dead", "killed"]);
    if (!["idle", "busy"].includes(st)) throw new AihubError(`the Spark session ended as '${st}' before the statement could run; the session was closed`);
    const sub2 = await client.request("POST", `${base}/${sid}/statements`, { code, kind });
    const stmt = sub2.data?.id;
    if (stmt === undefined) throw new AihubError("Fabric accepted no Livy statement (no id)");
    let last: any = {};
    const sst = await wait(async () => {
      last = (await client.request("GET", `${base}/${sid}/statements/${stmt}`)).data;
      return String(last.state ?? "unknown");
    }, ["available", "error", "cancelled"]);
    if (!["available", "error", "cancelled"].includes(sst)) throw new AihubError(`the statement did not finish in ${num(s, "timeout", 300)}s (state ${sst}); the session was closed`);
    const out = last.output ?? {};
    const ok = sst === "available" && String(out.status ?? "ok").toLowerCase() === "ok";
    const max = num(s, "top", 100);
    const table = out.data?.["application/json"];
    const rows: unknown[] = table?.data ?? [];
    const result: Record<string, unknown> = { status: ok ? "ok" : "error", livyId: sid, statementId: stmt, kind, progress };
    if (!ok) result.error = redact([out.ename, out.evalue, (out.traceback ?? []).join("")].filter(Boolean).join("\n") || "Spark reported no details.").slice(0, 8000);
    if (table?.schema?.fields) Object.assign(result, { columns: table.schema.fields.map((f: any) => ({ name: f.name, type: typeof f.type === "string" ? f.type : JSON.stringify(f.type) })), rows: rows.slice(0, max), rowCount: Math.min(rows.length, max), truncated: rows.length > max });
    if (out.data?.["text/plain"]) result.text = redact(String(out.data["text/plain"])).slice(0, 8000);
    result.sessionClosed = true;
    emit(s, result, `${ok ? "statement ok" : "statement failed"} (${kind}, session ${sid})\n${ok ? (result.text ?? JSON.stringify(rows.slice(0, max))) : result.error}`);
    if (!ok) throw new AihubError("the Spark statement failed (see above)");
  } finally {
    try {
      await client.request("DELETE", `${base}/${sid}`);
    } catch {
      /* closing is best effort; the session times out by itself */
    }
  }
}

// ---- failure follow: root cause chain pipeline -> notebook -> Spark -------------------------------------------------------

interface Link {
  level: number;
  kind: string;
  name: string;
  status?: string;
  error?: string;
  detail?: string;
}

async function activityRuns(client: FabricClient, wsId: string, runId: string, job?: { start?: string; end?: string }): Promise<any[]> {
  const day = 86_400_000;
  const after = new Date((parseUtc(job?.start) || Date.now()) - day).toISOString();
  const before = new Date((parseUtc(job?.end) || Date.now()) + day).toISOString();
  const r = await client.request("POST", `/workspaces/${wsId}/datapipelines/pipelineruns/${runId}/queryactivityruns`, { filters: [], orderBy: [{ orderBy: "ActivityRunStart", order: "ASC" }], lastUpdatedAfter: after, lastUpdatedBefore: before });
  return Array.isArray(r.data) ? r.data : (r.data.value ?? r.data.data ?? []);
}

/** The deepest failure of a run: pipeline activities (nested pipelines too), then the notebook's Spark session log. */
export async function rootCause(client: FabricClient, wsId: string, item: FabricItem, job: JobInstance, links: Link[] = [], level = 0): Promise<Link[]> {
  const head = `${item.type} ${item.displayName} run ${job.id}`;
  links.push({ level, kind: item.type, name: item.displayName, status: job.status, error: oneLine(job.failureReason?.message, 300), detail: head });
  if (level > 5) return links;
  if (item.type === "DataPipeline") await pipelineLinks(client, wsId, job.id, job, links, level + 1);
  else if (item.type === "Notebook" || item.type === "SparkJobDefinition") await sparkLinks(client, wsId, item, job.id, links, level + 1);
  return links;
}

async function pipelineLinks(client: FabricClient, wsId: string, runId: string, job: { start?: string; end?: string; startTimeUtc?: string; endTimeUtc?: string }, links: Link[], level: number): Promise<void> {
  if (level > 6) return;
  let runs: any[];
  try {
    runs = await activityRuns(client, wsId, runId, { start: job.startTimeUtc ?? job.start, end: job.endTimeUtc ?? job.end });
  } catch (e) {
    links.push({ level, kind: "activity runs", name: "-", error: `not available (${e instanceof FabricHttpError ? `HTTP ${e.status}` : (e as Error).message})` });
    return;
  }
  for (const a of runs.filter((x) => /fail/i.test(String(x.status)))) {
    const err = a.error ? `${a.error.errorCode ?? ""}: ${oneLine(a.error.message, 400)}`.replace(/^: /, "") : "";
    links.push({ level, kind: `activity ${a.activityType ?? ""}`.trim(), name: a.activityName ?? "?", status: a.status, error: err });
    const out = a.output ?? {};
    const child = /pipeline/i.test(String(a.activityType)) ? (out.pipelineRunId ?? out.runId) : undefined;
    if (typeof child === "string" && guid.test(child)) await pipelineLinks(client, wsId, child, {}, links, level + 1);
    const nbId = a.input?.notebookId;
    if (/notebook/i.test(String(a.activityType)) && typeof nbId === "string" && guid.test(nbId)) {
      const wid = typeof a.input?.workspaceId === "string" && guid.test(a.input.workspaceId) ? a.input.workspaceId : wsId;
      const nbRun = [out.runId, out.jobInstanceId, out.sessionId].find((x) => typeof x === "string" && guid.test(x));
      await sparkLinks(client, wid, { id: nbId, displayName: String(a.activityName), type: "Notebook" }, nbRun, links, level + 1, { start: a.activityRunStart, end: a.activityRunEnd });
    }
  }
}

async function sparkLinks(client: FabricClient, wsId: string, item: FabricItem, jobId: string | undefined, links: Link[], level: number, window?: { start?: string; end?: string }): Promise<void> {
  try {
    const sessions = await client.list<Session>(`/workspaces/${wsId}/${segOf(item)}/${item.id}/livySessions`);
    let sess = jobId ? sessions.find((x) => String(x.jobInstanceId ?? "").toLowerCase() === jobId.toLowerCase()) : undefined;
    if (!sess && window?.start) {
      const t0 = parseUtc(window.start) - 60_000;
      sess = sessions.filter((x) => parseUtc(String(x.startDateTime ?? x.submittedDateTime)) >= t0).sort((a, b) => String(a.startDateTime).localeCompare(String(b.startDateTime)))[0];
    }
    if (!sess) {
      links.push({ level, kind: "spark session", name: item.displayName, error: "no Spark session found for this run" });
      return;
    }
    const base = `/workspaces/${wsId}/${segOf(item)}/${item.id}/livySessions/${sess.livyId}/applications`;
    let text = "";
    if (sess.sparkApplicationId) {
      for (const f of ["stderr", "stdout"]) {
        try {
          text += `\n${(await client.request("GET", `${base}/${sess.sparkApplicationId}/logs?type=driver&fileName=${f}`, undefined, { accept: "*/*" })).text}`;
        } catch {
          /* the other file may still answer */
        }
      }
    }
    text = redact(text);
    const cell = failedCell(text);
    const stack = extractStack(text.split("\n"), 8).join(" | ");
    const cause = classifyError(`${cell?.exception ?? ""} ${stack}`);
    links.push({
      level,
      kind: "spark session",
      name: `${item.displayName} (${sess.livyId}, ${sess.state ?? "?"})`,
      error: cell ? `cell ${cell.cell} line ${cell.line}: ${cell.code ?? ""} -> ${cell.exception ?? ""}` : oneLine(stack, 300),
      detail: cause.kind === "unknown" ? undefined : `likely cause ${cause.kind}: ${cause.hint}`,
    });
  } catch (e) {
    links.push({ level, kind: "spark session", name: item.displayName, error: `not available (${e instanceof FabricHttpError ? `HTTP ${e.status}` : (e as Error).message})` });
  }
}

/** Without --workspace, the per-branch workspace of the current branch ("<prefix> <branch label>"): sets s.v.workspace. */
export async function resolveBranchWorkspace(s: Setup, client: FabricClient): Promise<void> {
  if (s.v.workspace || !s.branch) return;
  const prefixes = [...(s.prefixes ?? [])];
  const w = branchWorkspace(await client.workspaces(), s.branch, prefixes, (x) => x.displayName);
  if (!w) throw new AihubError(`no single workspace named '${prefixes[0] ?? "<prefix>"} ${s.branch.split("/").pop()}' for branch ${s.branch}; pass --workspace, or set fabric.branchWorkspacePrefixes in team.yaml`);
  s.v.workspace = [w.displayName];
}

/** `aihub fabric failures`: newest failed (and active) runs of a branch's workspace, with the root cause chain. */
export async function failuresCmd(s: Setup): Promise<void> {
  const client = makeClient(s.ctx, s.v);
  let t: Target;
  await resolveBranchWorkspace(s, client);
  t = await target(s, client, false);
  const items = (await client.items(t.id)).filter((i) => ["DataPipeline", "Notebook"].includes(i.type)).slice(0, 50);
  const rows: { item: FabricItem; job: JobInstance }[] = [];
  for (const it of items) {
    try {
      for (const j of await client.jobs(t.id, it.id)) if (["Failed", "InProgress", "NotStarted"].includes(j.status)) rows.push({ item: it, job: j });
    } catch (e) {
      if (e instanceof FabricHttpError && e.status === 401) throw e;
    }
  }
  rows.sort((a, b) => String(b.job.startTimeUtc).localeCompare(String(a.job.startTimeUtc)));
  for (const r of rows) rememberRun(s.ctx.env, r.job.id, { workspaceId: t.id, workspaceName: t.ws.name, itemId: r.item.id, itemName: r.item.displayName, itemType: r.item.type });
  const failed = rows.filter((r) => r.job.status === "Failed");
  const active = rows.filter((r) => r.job.status !== "Failed");
  const lines = [`${failed.length} failed and ${active.length} active run(s) in ${where(t)}`];
  if (rows.length) lines.push(toTable([["started", "item", "status", "job", "first error"], ...rows.slice(0, 15).map((r) => [r.job.startTimeUtc ?? "-", r.item.displayName, r.job.status, r.job.id, oneLine(r.job.failureReason?.message, 80) || "-"])]));
  let chain: Link[] = [];
  if (failed[0]) {
    chain = await rootCause(client, t.id, failed[0].item, failed[0].job);
    lines.push(`root cause chain of the newest failure (${failed[0].item.displayName}):`);
    for (const l of chain) lines.push(`${"  ".repeat(l.level)}${l.kind} ${l.name}${l.status ? ` [${l.status}]` : ""}${l.error ? `: ${l.error}` : ""}${l.detail && l.level > 0 ? ` (${l.detail})` : ""}`);
    if (chain.some((l) => l.error)) {
      const c = causeOfChain(chain);
      lines.push(`likely cause: ${c.kind}: ${c.hint}`);
    }
    lines.push(`details: aihub fabric logs --workspace ${t.ws.name} --item ${failed[0].item.displayName} --job ${failed[0].job.id}`);
  }
  emit(s, { workspace: t.ws.name, failed: failed.map((r) => ({ item: r.item.displayName, job: r.job.id })), active: active.length, chain }, lines.join("\n"));
}

// ---- SQL (read-only) ----------------------------------------------------------------------------------------------------------

async function tediousQuery(ep: { host: string; port: number; database: string }, query: string, maxRows: number, timeoutSeconds: number, token: string) {
  const { Connection, Request } = await import("tedious");
  return new Promise<{ columns: string[]; rows: unknown[][] }>((resolve, reject) => {
    const conn = new Connection({
      server: ep.host,
      authentication: { type: "azure-active-directory-access-token", options: { token } },
      options: { port: ep.port, database: ep.database, encrypt: true, trustServerCertificate: false, readOnlyIntent: true, requestTimeout: timeoutSeconds * 1000, connectTimeout: 30_000, rowCollectionOnRequestCompletion: false },
    });
    const rows: unknown[][] = [];
    let columns: string[] = [];
    // Without an "error" listener a dropped socket is an unhandled event and kills the process with a stack trace (found by the live Fabric check).
    conn.on("error", (err) => reject(new AihubError(`the SQL connection failed: ${redact(err.message)} (host ${ep.host}:${ep.port}; a firewall, VPN or private link can block port ${ep.port})`)));
    conn.on("connect", (err) => {
      if (err) return reject(new AihubError(`could not connect to the SQL endpoint: ${redact(err.message)}`));
      const req = new Request(query, (e) => {
        conn.close();
        if (e) reject(new AihubError(`the query failed: ${redact(e.message).slice(0, 400)}`));
        else resolve({ columns, rows });
      });
      req.on("columnMetadata", (cols) => {
        columns = (Array.isArray(cols) ? cols : Object.values(cols)).map((c: any) => c.colName);
      });
      req.on("row", (cols: any) => {
        if (rows.length <= maxRows) rows.push((Array.isArray(cols) ? cols : Object.values(cols)).map((c: any) => (c.value instanceof Date ? c.value.toISOString() : c.value)));
      });
      conn.execSql(req);
    });
    conn.connect();
  });
}

/** `aihub fabric sql`: one read-only SELECT/WITH query against a Warehouse or Lakehouse SQL endpoint (legacy FabricSqlClient). */
export async function sqlCmd(s: Setup): Promise<void> {
  const q = s.v.query ? (s.v.query as string) : s.v["query-file"] ? readFileSync(s.v["query-file"] as string, "utf8") : "";
  const query = sqlGuard(q);
  const client = makeClient(s.ctx, s.v);
  const t = await target(s, client, false);
  // a Lakehouse always has a SQLEndpoint item with the same name: without --type look for the Lakehouse, then the Warehouse
  const it = s.v.type ? await itemArg(s, client, t.id) : await client.resolveItem(t.id, need(s.v, "item", "name|id"), "Lakehouse").catch(() => client.resolveItem(t.id, need(s.v, "item", "name|id"), "Warehouse")).catch(() => itemArg(s, client, t.id));
  const route = it.type === "Warehouse" ? "warehouses" : it.type === "Lakehouse" ? "lakehouses" : undefined;
  if (!route) throw new AihubError(`${it.type} '${it.displayName}' has no SQL endpoint (Warehouse or Lakehouse)`);
  const props = ((await client.request("GET", `/workspaces/${t.id}/${route}/${it.id}`)).data as any).properties ?? {};
  const conn: string | undefined = it.type === "Warehouse" ? props.connectionString : props.sqlEndpointProperties?.connectionString;
  if (!conn) throw new AihubError(`${it.displayName} has no SQL connection string yet (the SQL endpoint may still be provisioning)`);
  const { host, port } = parseSqlHost(conn);
  const max = Math.min(num(s, "top", 100), 5000);
  const ep = { host, port, database: it.displayName };
  if (s.v["dry-run"]) return dryRun(s, [`read-only query on ${it.displayName} (${host}): ${oneLine(query, 100)}`]);
  const token = (await client.identity!.token("sql")).replace(/^Bearer /, "");
  // tedious first; when the endpoint drops its connection (seen on a lakehouse SQL endpoint) Windows retries the same read-only query through .NET SqlClient.
  const run =
    s.ctx.sql ??
    (async (...a: Parameters<typeof tediousQuery>) => {
      try {
        return await tediousQuery(...a);
      } catch (e) {
        if (process.platform !== "win32" || !isDroppedConnection((e as Error).message)) throw e;
        return await powershellSqlQuery(...a).catch((e2) => {
          throw new AihubError(`${(e as Error).message}; the .NET SqlClient fallback failed too: ${(e2 as Error).message}`);
        });
      }
    });
  const r = await run(ep, query, max, num(s, "timeout", 60), token);
  const rows = r.rows.slice(0, max).map((row) => row.map((v) => (typeof v === "string" ? redact(v) : v)));
  emit(s, { readOnly: true, columns: r.columns, rowCount: rows.length, truncated: r.rows.length > max, rows }, `${rows.length} row(s)${r.rows.length > max ? ` (first ${max})` : ""} from ${it.displayName} [read-only]\n${r.columns.join(" | ")}\n${rows.map((x) => x.join(" | ")).join("\n")}`);
}

// ---- connections: create, update, delete ---------------------------------------------------------------------------------------

/** kv://vault/secret strings anywhere in a body are replaced by the secret read with az; nothing secret is printed. */
function resolveKv(body: unknown, s: Setup): unknown {
  const deps = { env: s.ctx.env, fetch: s.ctx.fetch, exec: s.ctx.exec };
  const walk = (v: unknown): unknown => (typeof v === "string" && v.startsWith("kv://") ? readKeyVaultSecret(deps, v) : Array.isArray(v) ? v.map(walk) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
  return walk(body);
}
/** Path of the first secret-looking field whose value is a literal (not a kv:// reference). */
function findInlineSecret(v: unknown, path = ""): string | undefined {
  if (Array.isArray(v)) return v.map((x, i) => findInlineSecret(x, `${path}[${i}]`)).find(Boolean);
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (/secret|password|credentialvalue|accountkey|token/i.test(k) && typeof x === "string" && x && !x.startsWith("kv://")) return `${path}.${k}`.replace(/^./, "");
      const r = findInlineSecret(x, `${path}.${k}`);
      if (r) return r;
    }
  }
  return undefined;
}
const redactKeys = (v: unknown): unknown => (Array.isArray(v) ? v.map(redactKeys) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /secret|password|key|token|credentialvalue/i.test(k) && typeof x === "string" ? "<redacted>" : redactKeys(x)])) : v);

export async function connectionWriteCmd(s: Setup, sub: string | undefined): Promise<void> {
  if (!["create", "update", "delete"].includes(sub ?? "")) throw new AihubError("usage: aihub fabric connection create|update|delete [--connection ID] --body-file F (secrets as kv://vault/secret)");
  const client = makeClient(s.ctx, s.v);
  const name = (s.v.name as string | undefined) ?? "";
  if (name) guardEnv({ name, environment: inferEnv(name) }, s.v["allow-env"] as string | undefined);
  if (sub === "delete") {
    const id = need(s.v, "connection", "connection id");
    const cur = (await client.request("GET", `/connections/${encodeURIComponent(id)}`)).data as { displayName?: string };
    if (s.v["confirm-name"] !== cur.displayName) throw new AihubError(`--confirm-name must be the exact connection name '${cur.displayName}'`);
    if (s.v["dry-run"]) return dryRun(s, [`delete connection ${cur.displayName} (${id})`]);
    await client.request("DELETE", `/connections/${encodeURIComponent(id)}`);
    return emit(s, { deleted: id }, `deleted connection ${cur.displayName}`);
  }
  const file = need(s.v, "body-file", "json file");
  let body: any;
  try {
    body = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch {
    throw new AihubError(`--body-file '${file}' must contain JSON`);
  }
  const inline = findInlineSecret(body);
  if (inline) throw new AihubError(`no secret may be inline in the body (${inline}): reference it as kv://<vault>/<secret>; nothing was sent`);
  const dn = body.displayName as string | undefined;
  if (dn) guardEnv({ name: dn, environment: inferEnv(dn) }, s.v["allow-env"] as string | undefined);
  const create = sub === "create";
  const path = create ? "/connections" : `/connections/${encodeURIComponent(need(s.v, "connection", "connection id"))}`;
  if (s.v["dry-run"]) return dryRun(s, [`${create ? "create" : "update"} connection ${dn ?? s.v.connection}`, `${create ? "POST" : "PATCH"} ${path}`, `body: ${redact(JSON.stringify(redactKeys(body))).slice(0, 400)}`]);
  const r = await client.request(create ? "POST" : "PATCH", path, resolveKv(body, s));
  emit(s, redactKeys(r.data), `${create ? "created" : "updated"} connection ${(r.data as any)?.displayName ?? dn ?? ""} ${(r.data as any)?.id ?? ""}`.trim());
}

// ---- user data functions, notebook smoke test ------------------------------------------------------------------------------------

export async function udfCmd(s: Setup, sub: string | undefined): Promise<void> {
  if (sub !== "invoke") throw new AihubError("usage: aihub fabric udf invoke --workspace W --item UDF --function F [--args-file params.json]");
  const client = makeClient(s.ctx, s.v);
  const t = await target(s, client, true);
  const it = await client.resolveItem(t.id, need(s.v, "item", "name|id"), "UserDataFunction");
  const fn = need(s.v, "function", "function name");
  const params = s.v["args-file"] ? JSON.parse(readFileSync(s.v["args-file"] as string, "utf8")) : undefined;
  const body = params ? { parameters: params } : {};
  const base = `/workspaces/${t.id}/userDataFunctions/${it.id}/functions/${encodeURIComponent(fn)}`;
  if (s.v["dry-run"]) return dryRun(s, [`invoke ${fn} of ${it.displayName} in ${where(t)}`, `POST ${base}/invoke`]);
  let data: unknown;
  try {
    data = (await client.request("POST", `${base}/invoke`, body)).data;
  } catch (e) {
    if (e instanceof FabricHttpError && e.status === 404) data = (await client.request("POST", base, body)).data;
    else if (e instanceof FabricHttpError && e.status === 401) data = (await client.request("POST", `${base}/invoke`, body, { powerbi: true })).data;
    else throw e;
  }
  emit(s, slim(data), `invoked ${fn}\n${JSON.stringify(slim(data), null, 1)}`);
}

const NOTEBOOK_LINE = /^(assert\s+-?\d+\s*(==|!=|<=|>=|<|>)\s*-?\d+|print\(\s*(?:'[^'\\\r\n]*'|"[^"\\\r\n]*")\s*\))$/;

/** `aihub fabric notebook-test prepare|run|verify`: an assertion-only smoke test in a notebook named "AIHub E2E ..." (legacy rules). */
export async function notebookTestCmd(s: Setup, sub: string | undefined): Promise<void> {
  if (!["prepare", "run", "verify"].includes(sub ?? "")) throw new AihubError("usage: aihub fabric notebook-test prepare|run|verify --workspace W --item 'AIHub E2E <name>' [--source-file F | --job ID]");
  const client = makeClient(s.ctx, s.v);
  const t = await target(s, client, sub !== "verify");
  const it = await itemArg(s, client, t.id);
  if (it.type !== "Notebook" || !it.displayName.startsWith("AIHub E2E")) throw new AihubError(`notebook tests run only in a Notebook whose name starts with "AIHub E2E" (got ${it.displayName}); create or name one in a dev workspace`);
  const stateFile = join(s.ctx.env.AIHUB_HOME || join(process.env.USERPROFILE || process.env.HOME || ".", ".aihub"), "fabric-notebook-tests.json");
  const read = (): Record<string, any> => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {});
  const save = (st: Record<string, any>) => {
    mkdirSync(join(stateFile, ".."), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(st));
  };
  const st = read();
  if (sub === "prepare") {
    const src = s.v["source-file"] ? readFileSync(s.v["source-file"] as string, "utf8") : need(s.v, "source", "assert/print lines");
    const lines = src.replace(/\r\n/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) throw new AihubError("the source is empty: pass assert and print lines");
    for (const l of lines) if (!NOTEBOOK_LINE.test(l)) throw new AihubError(`only \`assert <int> <op> <int>\` and \`print('<literal>')\` lines are allowed; got: ${l.slice(0, 80)}; nothing was written`);
    const source = lines.join("\n");
    const sha = (await import("node:crypto")).createHash("sha256").update(source).digest("hex");
    const text = `# Fabric notebook source\n\n# METADATA ********************\n\n# META {\n# META   "kernel_info": {\n# META     "name": "synapse_pyspark"\n# META   }\n# META }\n\n# CELL ********************\n\n${source}\n\n# METADATA ********************\n\n# META {\n# META   "language": "python",\n# META   "language_group": "synapse_pyspark"\n# META }\n`;
    if (s.v["dry-run"]) return dryRun(s, [`write the assertion-only smoke test (sha256 ${sha.slice(0, 12)}, ${lines.length} line(s)) into ${it.displayName} in ${where(t)}`]);
    await client.lro("POST", `/workspaces/${t.id}/items/${it.id}/updateDefinition`, { definition: { format: "fabricGitSource", parts: [{ path: "notebook-content.py", payload: Buffer.from(text).toString("base64"), payloadType: "InlineBase64" }] } });
    st[it.id] = { sha256: sha, prepared: new Date().toISOString() };
    save(st);
    return emit(s, { prepared: it.displayName, sha256: sha }, `prepared the smoke test in ${it.displayName} (sha256 ${sha.slice(0, 12)}); run it with: aihub fabric notebook-test run --workspace ${t.ws.name} --item "${it.displayName}"`);
  }
  const prep = st[it.id];
  if (!prep) throw new AihubError(`no smoke test was prepared for ${it.displayName}; run notebook-test prepare first`);
  if (sub === "run") {
    if (s.v["dry-run"]) return dryRun(s, [`run the prepared smoke test (sha256 ${String(prep.sha256).slice(0, 12)}) in ${it.displayName} (${where(t)})`]);
    const jobId = await client.startJob(t.id, it);
    st[it.id] = { ...prep, runId: jobId };
    save(st);
    return emit(s, { runId: jobId }, `started the smoke test: job ${jobId}; verify with: aihub fabric notebook-test verify --workspace ${t.ws.name} --item "${it.displayName}" --job ${jobId}`);
  }
  const job = need(s.v, "job", "run id");
  if (prep.runId !== job) throw new AihubError(`run ${job} is not the run of the prepared smoke test; run notebook-test run first`);
  const j = await client.jobStatus(t.id, it.id, job);
  const passed = j.status === "Completed" && !j.failureReason;
  emit(s, { passed, status: j.status, sha256: prep.sha256 }, `smoke test ${passed ? "PASSED" : `NOT passed (${j.status}${j.failureReason ? `: ${oneLine(j.failureReason.message, 120)}` : ""})`}`);
  if (!passed) throw new AihubError("the smoke test did not pass");
}

// ---- dbt ----------------------------------------------------------------------------------------------------------------------------------

/** `aihub fabric dbt detect|results|scaffold|run|upload|save-job|get-job` (legacy fabric_dbt_* tools). */
export async function dbtCmd(s: Setup, sub: string | undefined): Promise<void> {
  const root = s.root ?? s.ctx.cwd;
  const projectArg = s.v.project as string | undefined;
  if (sub === "detect") {
    const projects = findProjects(root);
    const dir = safeProjectDir(root, projectArg ?? projects[0]?.path);
    const prof = findProfiles(dir, s.ctx.env);
    const results = readRunResults(dir);
    let cli = "not found";
    try {
      cli = (s.ctx.spawn ?? defaultSpawn)("dbt", ["--version"], dir, 20_000).stdout.split("\n").slice(0, 6).join(" ").trim() || "dbt did not answer";
    } catch {
      /* no dbt on PATH */
    }
    const lines = [`${projects.length} dbt project(s)`, ...projects.map((p) => `  ${p.path}: ${p.name} (profile ${p.profile ?? "-"}, ${p.models} model(s), ${p.dataTests} test file(s))`), `profiles: ${prof.file ?? "none found"}`, ...prof.targets.map((x) => `  ${x.profile}/${x.target}: ${x.adapter} -> route ${x.route}${x.isDefault ? " (default)" : ""}`), `dbt cli: ${cli}`, results ? `last run: ${results.command ?? "?"}, ${JSON.stringify(results.counts)}` : "no run_results.json yet", "routes: warehouse (dbt-fabric), lakehouse (dbt-fabricspark), job (Fabric dbt job item)"];
    return emit(s, { projects, profiles: prof, results, cli }, lines.join("\n"));
  }
  if (sub === "results") {
    const dir = safeProjectDir(root, projectArg ?? findProjects(root)[0]?.path);
    const r = readRunResults(dir);
    if (!r) throw new AihubError("no target/run_results.json in the project: run dbt first");
    return emit(s, { ...r, logTail: logTail(dir) }, [`dbt ${r.command ?? ""}: ${JSON.stringify(r.counts)}`, ...r.failures.map((f) => `  ${f.status} ${f.id}: ${oneLine(f.message, 200)}`), logTail(dir) ? `log tail:\n${logTail(dir)}` : ""].filter(Boolean).join("\n"));
  }
  const client = makeClient(s.ctx, s.v);
  if (sub === "scaffold") {
    const route = need(s.v, "route", "warehouse|lakehouse|job") as "warehouse" | "lakehouse" | "job";
    if (!["warehouse", "lakehouse", "job"].includes(route)) throw new AihubError("--route must be warehouse, lakehouse or job");
    const name = need(s.v, "project-name", "dbt project name");
    const t = await target(s, client, true);
    const input: Parameters<typeof scaffoldFiles>[0] = { route, projectName: name, target: (s.v.target as string | undefined) ?? "dev", schema: (s.v.schema as string | undefined) ?? "dbo", workspaceId: t.id };
    if (route === "warehouse") {
      const wh = await client.resolveItem(t.id, need(s.v, "warehouse", "name|id"), "Warehouse");
      const props = ((await client.request("GET", `/workspaces/${t.id}/warehouses/${wh.id}`)).data as any).properties ?? {};
      input.server = parseSqlHost(String(props.connectionString ?? "")).host;
      input.database = wh.displayName;
    } else if (route === "lakehouse") {
      const lh = await client.resolveItem(t.id, need(s.v, "lakehouse", "name|id"), "Lakehouse");
      input.lakehouseId = lh.id;
      input.lakehouse = lh.displayName;
    }
    const dir = safeProjectDir(root, (s.v.folder as string | undefined) ?? name);
    const files = scaffoldFiles(input);
    if (s.v["dry-run"]) return dryRun(s, [`write ${Object.keys(files).length} file(s) to ${dir}: ${Object.keys(files).join(", ")}`, "no secret is written: authentication is the az login"]);
    const written = writeScaffold(dir, files);
    return emit(s, { dir, written }, `scaffolded dbt project ${name} (${route}) in ${dir}: ${written.join(", ")}`);
  }
  if (sub === "run") {
    const command = need(s.v, "command", COMMANDS.join("|"));
    if (!COMMANDS.includes(command)) throw new AihubError(`--command must be one of ${COMMANDS.join(", ")}`);
    for (const k of ["select", "exclude", "target"]) if (typeof s.v[k] === "string" && (s.v[k] as string).trim().startsWith("-")) throw new AihubError(`--${k} must not look like a flag`);
    const dir = safeProjectDir(root, projectArg ?? findProjects(root)[0]?.path);
    const needsWs = !["deps", "parse", "ls"].includes(command);
    if (needsWs) {
      const t = await target(s, client, true);
      const prof = findProfiles(dir, s.ctx.env);
      const proj = findProjects(root).find((p) => join(root, p.path) === dir || p.path === ".");
      const tg = prof.targets.find((x) => x.profile === (proj?.profile ?? x.profile) && (s.v.target ? x.target === s.v.target : x.isDefault)) ?? prof.targets[0];
      if (!tg) throw new AihubError("no profile target found: run `aihub fabric dbt detect`");
      // the profile target must live in the chosen workspace before anything runs
      if (tg.route === "warehouse") {
        const whs = await client.items(t.id, "Warehouse");
        const host = String(tg.fields.server ?? "").toLowerCase();
        let ok = false;
        for (const w of whs) {
          const p = ((await client.request("GET", `/workspaces/${t.id}/warehouses/${w.id}`)).data as any).properties ?? {};
          try {
            if (parseSqlHost(String(p.connectionString ?? "")).host === host.replace(/^tcp:/, "").split(",")[0] && w.displayName === tg.fields.database) ok = true;
          } catch {
            /* skip a warehouse without a usable host */
          }
        }
        if (!ok) throw new AihubError(`the profile target ${tg.profile}/${tg.target} (server ${host}, database ${String(tg.fields.database)}) is not a Warehouse in ${t.ws.name}; nothing ran`);
      } else if (tg.route === "lakehouse") {
        if (String(tg.fields.workspaceid).toLowerCase() !== t.id.toLowerCase() || !(await client.items(t.id, "Lakehouse")).some((l) => l.id.toLowerCase() === String(tg.fields.lakehouseid).toLowerCase())) throw new AihubError(`the profile target ${tg.profile}/${tg.target} is not a Lakehouse of ${t.ws.name}; nothing ran`);
      } else throw new AihubError(`the profile target ${tg.profile}/${tg.target} uses adapter '${tg.adapter}', not a Fabric adapter; nothing ran`);
    }
    const args = [command, "--project-dir", dir, ...(prof(dir, s) ? ["--profiles-dir", prof(dir, s)!] : []), ...(s.v.target ? ["--target", s.v.target as string] : []), ...(s.v.select ? ["--select", s.v.select as string] : []), ...(s.v.exclude ? ["--exclude", s.v.exclude as string] : []), ...(s.v["full-refresh"] ? ["--full-refresh"] : [])];
    if (s.v["dry-run"]) return dryRun(s, [`dbt ${args.join(" ")}`]);
    const r = (s.ctx.spawn ?? defaultSpawn)("dbt", args, dir, num(s, "timeout", 600) * 1000);
    const res = readRunResults(dir);
    const out = redact(`${r.stdout}\n${r.stderr}`).split("\n").slice(-40).join("\n");
    emit(s, { status: r.status === 0 ? "ok" : "error", exit: r.status, results: res, tail: out }, `dbt ${command} ${r.status === 0 ? "succeeded" : `failed (exit ${r.status})`}${res ? ` ${JSON.stringify(res.counts)}` : ""}\n${(res?.failures ?? []).map((f) => `  ${f.id}: ${oneLine(f.message, 200)}`).join("\n")}\n${out}`);
    if (r.status !== 0) throw new AihubError(`dbt ${command} failed`);
    return;
  }
  if (sub === "upload") {
    const t = await target(s, client, true);
    const lh = await client.resolveItem(t.id, need(s.v, "lakehouse", "name|id"), "Lakehouse");
    const dir = safeProjectDir(root, projectArg ?? findProjects(root)[0]?.path);
    const files = projectFiles(dir);
    const folder = ((s.v["folder-path"] as string | undefined) ?? `dbt/${dir.split(/[\\/]/).pop()}`).replace(/^\/+|\/+$/g, "");
    const sha = setHash(files);
    if (s.v["dry-run"]) return dryRun(s, [`upload ${files.length} file(s) (${files.reduce((n, f) => n + f.bytes.length, 0)} bytes, sha256 ${sha.slice(0, 12)}) to ${lh.displayName}/Files/${folder} in ${where(t)}`]);
    for (const f of files) {
      const url = `https://onelake.dfs.fabric.microsoft.com/${t.id}/${lh.id}/Files/${[...folder.split("/"), ...f.rel.split("/")].map(encodeURIComponent).join("/")}`;
      await client.request("PUT", `${url}?resource=file`, undefined, { storage: true });
      if (f.bytes.length) await client.request("PATCH", `${url}?action=append&position=0`, undefined, { storage: true, raw: new Uint8Array(f.bytes), headers: { "Content-Type": "application/octet-stream" } });
      await client.request("PATCH", `${url}?action=flush&position=${f.bytes.length}`, undefined, { storage: true });
    }
    return emit(s, { files: files.length, sha256: sha, folder }, `uploaded ${files.length} file(s) to ${lh.displayName}/Files/${folder} (sha256 ${sha.slice(0, 12)})`);
  }
  if (sub === "save-job") {
    const t = await target(s, client, true);
    const wh = await client.resolveItem(t.id, need(s.v, "warehouse", "name|id"), "Warehouse");
    const props = ((await client.request("GET", `/workspaces/${t.id}/warehouses/${wh.id}`)).data as any).properties ?? {};
    const dir = safeProjectDir(root, projectArg ?? findProjects(root)[0]?.path);
    const files = projectFiles(dir);
    const folderPath = ((s.v["folder-path"] as string | undefined) ?? "dbt").replace(/^\/+|\/+$/g, "");
    const def = jobDefinition({ folderPath, schema: (s.v.schema as string | undefined) ?? "dbo", warehouseId: wh.id, workspaceId: t.id, endPoint: String(props.connectionString ?? ""), operation: (s.v.operation as string | undefined) ?? "build", select: s.v.select as string | undefined, exclude: s.v.exclude as string | undefined, fullRefresh: !!s.v["full-refresh"], failFast: !!s.v["fail-fast"], threads: s.v.threads ? Number(s.v.threads) : undefined }, files);
    const name = need(s.v, "name", "job name");
    const existing = (await client.items(t.id, "DataBuildToolJob")).find((i) => i.displayName.toLowerCase() === name.toLowerCase());
    if (s.v["dry-run"]) return dryRun(s, [`${existing ? "update" : "create"} dbt job ${name} in ${where(t)} with ${files.length} project file(s)`]);
    if (existing) await client.lro("POST", `/workspaces/${t.id}/items/${existing.id}/updateDefinition`, { definition: def });
    else await client.lro("POST", `/workspaces/${t.id}/dataBuildToolJobs`, { displayName: name, ...(s.v.description ? { description: s.v.description } : {}), definition: def });
    return emit(s, { job: name, files: files.length }, `${existing ? "updated" : "created"} dbt job ${name} (${files.length} project file(s)); run it: aihub fabric api run_job --workspace ${t.ws.name} --item ${name} --arg jobType=Execute`);
  }
  if (sub === "get-job") {
    const t = await target(s, client, false);
    const jobs = await client.items(t.id, "DataBuildToolJob");
    if (!s.v.item) return emit(s, jobs, jobs.length ? toTable([["name", "id"], ...jobs.map((j) => [j.displayName, j.id])]) : "no dbt jobs in this workspace");
    const it = await client.resolveItem(t.id, s.v.item as string, "DataBuildToolJob");
    const def = (await client.lro("POST", `/workspaces/${t.id}/items/${it.id}/getDefinition`)).data?.definition?.parts as { path: string; payload: string }[] | undefined;
    const content = def?.find((p) => p.path === "dbt-content.json");
    const runs = (await client.jobs(t.id, it.id)).sort((a, b) => String(b.startTimeUtc).localeCompare(String(a.startTimeUtc))).slice(0, 5);
    return emit(s, { definition: content ? JSON.parse(Buffer.from(content.payload, "base64").toString("utf8")) : null, runs }, [`dbt job ${it.displayName}`, content ? Buffer.from(content.payload, "base64").toString("utf8") : "no definition", ...runs.map((r) => `run ${r.id}: ${r.status} ${durationText(r.startTimeUtc, r.endTimeUtc)}${r.failureReason ? ` ${oneLine(r.failureReason.message, 120)}` : ""}`)].join("\n"));
  }
  throw new AihubError("usage: aihub fabric dbt detect|results|scaffold|run|upload|save-job|get-job");
}

const prof = (dir: string, s: Setup): string | undefined => {
  if (existsSync(join(dir, "profiles.yml"))) return dir;
  return s.ctx.env.DBT_PROFILES_DIR;
};

function defaultSpawn(cmd: string, args: string[], cwd: string, timeoutMs: number) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: timeoutMs, shell: false });
  if (r.error) throw new AihubError(`could not run ${cmd}: ${r.error.message}`);
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

void routeOf;
void MAX_FILES;
