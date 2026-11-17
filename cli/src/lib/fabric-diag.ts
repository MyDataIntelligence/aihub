import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AihubError } from "./errors.js";
import { inferEnv } from "./fabric.js";

// ---- log window (legacy FabricLogWindow) ----------------------------------------------------------

export const MAX_MATCHES = 200;
export const MAX_CONTEXT = 20;
export const MAX_TAIL_LINES = 5000;

const ERROR_RECORD = /^(?:\[?\d{2,4}[-/]\d{2}[-/]\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]?\s+(?:\[[^\]]*\]\s+)?)?(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL)\b/;

/** The last `lines` lines of a text. */
export function tailLines(text: string, lines: number): string {
  if (!Number.isInteger(lines) || lines < 1 || lines > MAX_TAIL_LINES) throw new AihubError(`--tail must be between 1 and ${MAX_TAIL_LINES} lines`);
  return text.replace(/\n+$/, "").split("\n").slice(-lines).join("\n");
}

/** Lines matching a case-insensitive regex with `context` lines around them; overlapping blocks merge. */
export function searchLines(text: string, pattern: string, context: number): { matches: { line: number; text: string }[]; truncated: boolean } {
  if (pattern.length > 500) throw new AihubError("--search must be a regex of at most 500 characters");
  if (!Number.isInteger(context) || context < 0 || context > MAX_CONTEXT) throw new AihubError(`--context must be between 0 and ${MAX_CONTEXT} lines`);
  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch (e) {
    throw new AihubError(`--search is not a valid regex: ${(e as Error).message}`);
  }
  const lines = text.split("\n");
  const matches: { line: number; text: string }[] = [];
  let lastEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i])) continue;
    if (matches.length >= MAX_MATCHES) return { matches, truncated: true };
    const from = Math.max(i - context, lastEnd + 1);
    const to = Math.min(lines.length - 1, i + context);
    if (from > to) continue;
    matches.push({ line: i + 1, text: lines.slice(from, to + 1).join("\n") });
    lastEnd = to;
  }
  return { matches, truncated: false };
}

/** Only ERROR/FATAL/CRITICAL records with their continuation lines (stack traces, tracebacks). */
export function errorsOnly(text: string): string {
  let keep = false;
  return text
    .split("\n")
    .filter((line) => {
      const m = ERROR_RECORD.exec(line);
      if (m) keep = ["ERROR", "FATAL", "CRITICAL"].includes(m[1].toUpperCase());
      else if (line.includes("Traceback (most recent call last)")) keep = true;
      return keep;
    })
    .join("\n");
}

const CELL = /Cell In\s*\[(\d+)\],\s*line (\d+)/;
const EXCEPTION = /^[A-Za-z_][\w.]*(Error|Exception|Exit|Interrupt|Warning)(:.*)?$/;

/** The notebook cell that failed, from an IPython traceback in the driver stdout. */
export function failedCell(text: string): { cell: number; line: number; code?: string; source: string; exception?: string } | undefined {
  const lines = text.split("\n");
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (CELL.test(lines[i])) {
    at = i;
    break;
  }
  if (at < 0) return undefined;
  const m = CELL.exec(lines[at])!;
  const source: string[] = [];
  let exception: string | undefined;
  for (let i = at + 1; i < Math.min(lines.length, at + 60); i++) {
    if (EXCEPTION.test(lines[i].trim())) {
      exception = lines[i].trim();
      break;
    }
    if (lines[i].trim()) source.push(lines[i]);
  }
  const arrow = source.find((l) => l.trimStart().startsWith("---->"));
  return { cell: Number(m[1]), line: Number(m[2]), code: arrow?.trimStart().replace(/^---->/, "").trim().replace(/^\d+\s+/, ""), source: source.slice(0, 20).join("\n"), exception };
}

// ---- error classification ----------------------------------------------------------------------------

export interface Cause {
  kind: string;
  hint: string;
}
const CAUSES: [RegExp, Cause][] = [
  [/OutOfMemoryError|Container killed by YARN for exceeding memory|java heap space/i, { kind: "out-of-memory", hint: "raise the Spark pool or environment memory, reduce partitions or shuffles, avoid collect()" }],
  [/AnalysisException.*(cannot resolve|column .* not found|UNRESOLVED_COLUMN)|UNRESOLVED_COLUMN/i, { kind: "missing-column", hint: "a column was renamed or dropped upstream: compare the source schema with the query" }],
  [/Table or view not found|TABLE_OR_VIEW_NOT_FOUND|Path does not exist|is not a Delta table|doesn't exist/i, { kind: "missing-table-or-path", hint: "check the lakehouse attached to the notebook and whether the upstream step ran first" }],
  [/ModuleNotFoundError|ImportError|No module named/i, { kind: "missing-library", hint: "add the library to the Fabric environment and publish it, or %pip install it in the notebook" }],
  [/Forbidden|403|Unauthorized|401|PermissionDenied|AuthorizationFailed|does not have (?:permission|access)/i, { kind: "permission", hint: "the running identity lacks access to the workspace, lakehouse, connection or storage path" }],
  [/Timeout|timed out|TimeoutException/i, { kind: "timeout", hint: "look for a stuck dependency or a long shuffle; retry once, then check capacity throttling" }],
  [/430|TooManyRequestsForCapacity|capacity.*(throttl|exceeded)/i, { kind: "capacity", hint: "the capacity is full: wait, cancel idle Spark sessions, or use a bigger capacity" }],
  [/ConcurrentAppendException|ConcurrentDeleteReadException|MetadataChangedException|ProtocolChangedException|conflict/i, { kind: "delta-conflict", hint: "two writers touched the same Delta table: serialise the runs or retry" }],
  [/Connection (?:refused|reset)|UnknownHost|SSLHandshake|Could not connect/i, { kind: "connection", hint: "a source or sink endpoint is unreachable: check the connection, gateway and firewall" }],
  [/SyntaxError|ParseException|IndentationError/i, { kind: "syntax", hint: "the code or SQL does not parse: open the failing cell or statement" }],
  [/ZeroDivisionError|ValueError|TypeError|KeyError|IndexError|AttributeError|NullPointerException/i, { kind: "code-error", hint: "an exception in the notebook code: see the failing cell and its input data" }],
  [/Spark session .*(dead|killed|failed to start)|SessionFailed|LIVY_SESSION/i, { kind: "spark-session", hint: "the Spark session ended: check the Livy log and capacity, then rerun" }],
];

/** Classify an error text into a short cause with a hint (best effort, first match wins). */
export function classifyError(text: string): Cause {
  for (const [re, c] of CAUSES) if (re.test(text)) return c;
  return { kind: "unknown", hint: "read the first error line and the stack excerpt; no known pattern matched" };
}

// ---- spark monitoring shapes (legacy FabricDiagnosticsParser views) -------------------------------------------

const pick = (o: Record<string, any>, keys: string[]) => Object.fromEntries(keys.filter((k) => o[k] !== undefined && o[k] !== null).map((k) => [k, o[k]]));
const dur = (o: Record<string, any>, a: string, b: string) => {
  const s = Date.parse(String(o[a]).replace(/GMT$/, "Z"));
  const e = Date.parse(String(o[b]).replace(/GMT$/, "Z"));
  return Number.isFinite(s) && Number.isFinite(e) && e >= s ? { durationMs: e - s } : {};
};

export const SPARK_VIEWS = ["application", "jobs", "stages", "tasks", "executors", "sql", "environment", "resourceUsage"] as const;
export type SparkView = (typeof SPARK_VIEWS)[number];

export const sparkJob = (v: any) =>
  ({ ...pick(v, ["jobId", "name", "description", "status", "jobGroup", "submissionTime", "completionTime", "numTasks", "numCompletedTasks", "numFailedTasks", "numKilledTasks", "numSkippedTasks", "numActiveStages", "numCompletedStages", "numFailedStages", "numSkippedStages", "stageIds"]), ...dur(v, "submissionTime", "completionTime") });
export const sparkStage = (v: any, full: boolean) =>
  ({
    ...pick(v, ["stageId", "attemptId", "name", "description", "status", "submissionTime", "firstTaskLaunchedTime", "completionTime", "numTasks", "numCompleteTasks", "numFailedTasks", "numKilledTasks", "executorRunTime", "executorCpuTime", "jvmGcTime", "inputBytes", "inputRecords", "outputBytes", "outputRecords", "shuffleReadBytes", "shuffleWriteBytes", "memoryBytesSpilled", "diskBytesSpilled", "peakExecutionMemory", "failureReason", ...(full ? ["details"] : [])]),
    ...dur(v, "submissionTime", "completionTime"),
  });
export const sparkTask = (v: any) => pick(v, ["taskId", "index", "attempt", "partitionId", "launchTime", "duration", "executorId", "host", "status", "taskLocality", "speculative", "errorMessage"]);
export const sparkExecutor = (v: any) => ({
  ...pick(v, ["id", "hostPort", "isActive", "addTime", "removeTime", "removeReason", "totalCores", "maxTasks", "maxMemory", "memoryUsed", "diskUsed", "activeTasks", "completedTasks", "failedTasks", "totalTasks", "totalDuration", "totalGCTime", "totalInputBytes", "totalShuffleRead", "totalShuffleWrite"]),
  ...(v.attributes?.CONTAINER_ID ? { containerId: v.attributes.CONTAINER_ID } : {}),
  ...(v.attributes?.LOG_FILES ? { logFiles: v.attributes.LOG_FILES } : {}),
});
export const sparkSql = (v: any, full: boolean) => ({ ...pick(v, ["id", "status", "description", "submissionTime", "duration", "runningJobIds", "successJobIds", "failedJobIds", ...(full ? ["planDescription"] : [])]), ...(Array.isArray(v.nodes) ? { nodes: v.nodes.length } : {}) });

/** One-line summary of a stage list: the failed or slowest stages first, to find the culprit fast. */
export function stagesSummary(stages: any[]): string[] {
  const rank = (s: any) => (s.status === "FAILED" ? 0 : 1);
  return [...stages]
    .sort((a, b) => rank(a) - rank(b) || (b.executorRunTime ?? 0) - (a.executorRunTime ?? 0))
    .slice(0, 5)
    .map((s) => `stage ${s.stageId}: ${s.status}, ${s.numFailedTasks ?? 0} failed task(s), run ${Math.round((s.executorRunTime ?? 0) / 1000)}s, spill ${s.diskBytesSpilled ?? 0}B${s.failureReason ? `, ${String(s.failureReason).split("\n")[0].slice(0, 120)}` : ""}`);
}

// ---- workspace of a branch (legacy FabricFollowPolicy) ---------------------------------------------------------------

/** Lowercase letters and digits only: "team_data 12-export" and "Team Data 12 Export" are one name. */
export const normalizedName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The branch part: "feature/12-export" and "refs/heads/feature/12-export" give "12-export". */
export function branchLabel(branch: string): string {
  const b = branch.replace(/^refs\/heads\//, "");
  return b.includes("feature/") ? b.slice(b.indexOf("feature/") + 8) : b.slice(b.lastIndexOf("/") + 1);
}

/** The one workspace of a branch: per accepted prefix exactly one normalised match; two equal names are ambiguous (undefined). */
export function branchWorkspace<T>(workspaces: T[], branch: string, prefixes: string[], name: (w: T) => string): T | undefined {
  const named = workspaces.map((w) => [w, normalizedName(name(w))] as const);
  for (const p of prefixes) {
    const wanted = normalizedName(`${p} ${branchLabel(branch)}`);
    const hits = named.filter(([, n]) => n === wanted);
    if (hits.length === 1) return hits[0][0];
    if (hits.length > 1) return undefined;
  }
  return undefined;
}

// ---- destination guard for code (legacy FabricDestinationGuard.codeRefusals) --------------------------------------------

const GUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const ABFSS = /abfss?:\/\/([^@/\s'"]+)@/gi;
const ONELAKE = /(?<![@\w.-])onelake\.(?:dfs|blob)\.fabric\.microsoft\.com\/([^/\s'"]+)/gi;
const ZERO = "00000000-0000-0000-0000-000000000000";

/** Refusals for code that names the abfss path or GUID of another workspace that is ACC/PRD or not visible. */
export function codeRefusals(code: string, own: { id: string; name: string }, visible: { id: string; displayName: string }[]): string[] {
  const out: string[] = [];
  const named = [...[...code.matchAll(ABFSS)].map((m) => m[1]), ...[...code.matchAll(ONELAKE)].map((m) => m[1])];
  const isGuid = (x: string) => new RegExp(`^${GUID.source}$`).test(x);
  for (const ref of new Set(named)) {
    if (ref.toLowerCase() === own.id.toLowerCase() || ref.toLowerCase() === own.name.toLowerCase()) continue;
    const target = visible.find((w) => (isGuid(ref) ? w.id.toLowerCase() === ref.toLowerCase() : w.displayName.toLowerCase() === ref.toLowerCase()));
    if (target) {
      if (inferEnv(target.displayName) !== "dev") out.push(`The code's path to "${ref}" points at workspace "${target.displayName}" (${inferEnv(target.displayName).toUpperCase()}). ACC and PRD are never a destination. Refused.`);
    } else if (inferEnv(ref) !== "dev") out.push(`The code's path points at workspace "${ref}", which says ACC or PRD. ACC and PRD are never a destination. Refused.`);
    else out.push(`The code's path points at workspace "${ref}", which is not visible, so it cannot be checked. Refused.`);
  }
  for (const id of new Set([...code.matchAll(GUID)].map((m) => m[0]))) {
    if (id === ZERO || id.toLowerCase() === own.id.toLowerCase() || named.some((n) => n.toLowerCase() === id.toLowerCase())) continue;
    const t = visible.find((w) => w.id.toLowerCase() === id.toLowerCase());
    if (t && inferEnv(t.displayName) !== "dev") out.push(`The code names workspace ${id} ("${t.displayName}", ${inferEnv(t.displayName).toUpperCase()}). ACC and PRD are never a destination. Refused.`);
  }
  return [...new Set(out)];
}

// ---- SQL guard (legacy FabricSqlGuard) ----------------------------------------------------------------------------

const FORBIDDEN = new Set(["INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME", "INTO", "EXEC", "EXECUTE", "SP_EXECUTESQL", "GRANT", "REVOKE", "DENY", "BACKUP", "RESTORE", "DBCC", "KILL", "SHUTDOWN", "RECONFIGURE", "USE", "BULK", "COPY", "OPENROWSET", "OPENQUERY", "OPENDATASOURCE", "WAITFOR", "DECLARE", "SET", "BEGIN", "COMMIT", "ROLLBACK", "SAVE", "TRAN", "TRANSACTION", "CHECKPOINT", "ENABLE", "DISABLE", "WRITETEXT", "UPDATETEXT", "READTEXT"]);
export const MAX_QUERY_CHARS = 20_000;

/** One SELECT/WITH query only: comments, literals and quoted identifiers are stripped first, then every changing keyword is refused. */
export function sqlGuard(query: string): string {
  const refuse = (why: string) => new AihubError(`Refused: fabric sql runs one read-only SELECT or WITH query; ${why}. Nothing was run.`);
  const text = query.trim();
  if (!text) throw new AihubError("needs --query <one SELECT or WITH query>");
  if (text.length > MAX_QUERY_CHARS) throw refuse(`it is longer than ${MAX_QUERY_CHARS} characters`);
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === "-" && n === "-") {
      while (i < text.length && text[i] !== "\n") i++;
      out += " ";
    } else if (c === "/" && n === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw refuse("a /* comment is not closed");
      i = end + 2;
      out += " ";
    } else if (c === "'" || c === '"' || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      for (;;) {
        if (j >= text.length) throw refuse("a quote or bracket is not closed");
        if (text[j] === close) {
          if (text[j + 1] === close) j += 2;
          else break;
        } else j++;
      }
      i = j + 1;
      out += " ";
    } else {
      out += c;
      i++;
    }
  }
  const body = out.trim().replace(/;\s*$/, "");
  if (body.includes(";")) throw refuse("only one statement is allowed (nothing after ';')");
  const words = body.toUpperCase().match(/[A-Z_][A-Z0-9_]*/g) ?? [];
  if (words[0] !== "SELECT" && words[0] !== "WITH") throw refuse("it must start with SELECT or WITH");
  const bad = words.find((w) => FORBIDDEN.has(w));
  if (bad) throw refuse(`it contains ${bad} (bracket a column of that name: [${bad}])`);
  return text.replace(/;\s*$/, "");
}

/** `host`, `host,1433`, `tcp:host,1433` or an ADO.NET string; only Fabric SQL hosts are accepted. */
export function parseSqlHost(connection: string): { host: string; port: number } {
  const server = connection.includes("=") ? (connection.split(";").map((p) => p.trim()).find((p) => ["data source", "server", "address", "addr"].includes(p.split("=")[0].trim().toLowerCase()))?.split("=").slice(1).join("=") ?? connection) : connection;
  const t = server.trim().replace(/^tcp:/, "");
  const host = t.split(",")[0].split(":")[0].trim();
  const port = Number(t.split(",")[1]) || 1433;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.(fabric\.microsoft\.com|pbidedicated\.windows\.net)$/i.test(host)) throw new AihubError("Fabric returned an unexpected SQL host; only *.fabric.microsoft.com hosts are queried.");
  return { host: host.toLowerCase(), port };
}

// ---- run index: where a run or session was last seen, so --job/--livy work without workspace and item -------------------

export interface Seen {
  workspaceId: string;
  workspaceName?: string;
  itemId: string;
  itemName?: string;
  itemType?: string;
}
const MAX_SEEN = 500;

function indexFile(env: NodeJS.ProcessEnv): string {
  const home = env.AIHUB_HOME || join(process.env.USERPROFILE || process.env.HOME || ".", ".aihub");
  return join(home, "fabric-run-index.json");
}

export function rememberRun(env: NodeJS.ProcessEnv, id: string, seen: Seen): void {
  try {
    const f = indexFile(env);
    const all: Record<string, Seen> = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
    delete all[id.toLowerCase()];
    all[id.toLowerCase()] = seen;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SEEN))) delete all[k];
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify(all));
  } catch {
    /* the index is a convenience */
  }
}

export function lookupRun(env: NodeJS.ProcessEnv, id: string): Seen | undefined {
  try {
    return (JSON.parse(readFileSync(indexFile(env), "utf8")) as Record<string, Seen>)[id.toLowerCase()];
  } catch {
    return undefined;
  }
}
