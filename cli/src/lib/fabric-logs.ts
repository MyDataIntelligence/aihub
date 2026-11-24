import { AihubError } from "./errors.js";
import { FabricHttpError, type FabricClient, type FabricItem, type JobInstance } from "./fabric.js";
import { durationText, oneLine, parseUtc, type LogSection } from "./fabric-ops.js";

/** Item types that have a job scheduler worth scanning. */
export const JOB_ITEM_TYPES = ["Notebook", "DataPipeline", "SparkJobDefinition", "Lakehouse", "Dataflow", "CopyJob"];

const why = (e: unknown) => (e instanceof FabricHttpError ? `HTTP ${e.status}` : e instanceof Error ? e.message : String(e));

async function attempt<T>(source: string, title: string, fn: () => Promise<T>, sections: LogSection[], build: (r: T) => Partial<LogSection>): Promise<void> {
  try {
    sections.push({ source, title, available: true, lines: [], ...build(await fn()) });
  } catch (e) {
    if (e instanceof FabricHttpError && e.status === 401) throw e;
    sections.push({ source, title, available: false, lines: [], note: `${source} answered ${why(e)}; open the Monitoring hub in Fabric for this part` });
  }
}

const txt = (s: string) => s.split(/\r?\n/).filter((l, i, a) => l.length || i < a.length - 1);

/** Everything Fabric exposes about one job run, each part with the endpoint it came from. */
export async function collectJobLogs(client: FabricClient, wsId: string, item: FabricItem, jobId: string): Promise<{ job: JobInstance; sections: LogSection[] }> {
  const job = await client.jobStatus(wsId, item.id, jobId);
  const sections: LogSection[] = [];
  const sched: string[] = [`status: ${job.status}${job.jobType ? ` (${job.jobType}, ${job.invokeType ?? "?"})` : ""}`];
  if (job.startTimeUtc) sched.push(`started: ${job.startTimeUtc}${job.endTimeUtc ? `, ended: ${job.endTimeUtc} (${durationText(job.startTimeUtc, job.endTimeUtc)})` : ""}`);
  if (job.failureReason) sched.push(`failure: ${job.failureReason.errorCode ?? "unknown"}: ${(job.failureReason.message ?? "no details").replace(/\s+/g, " ").trim()}`);
  sections.push({ source: "item job scheduler", title: "job instance", available: true, lines: sched });

  if (item.type === "Notebook" || item.type === "SparkJobDefinition") {
    const base = item.type === "Notebook" ? "notebooks" : "sparkJobDefinitions";
    let sessions: any[] = [];
    await attempt(`${base} Livy sessions`, "Spark session", () => client.list<any>(`/workspaces/${wsId}/${base}/${item.id}/livySessions`), sections, (all) => {
      sessions = all.filter((s) => String(s.jobInstanceId ?? "").toLowerCase() === jobId.toLowerCase());
      return sessions.length
        ? { lines: sessions.map((s) => `session ${s.livyId ?? s.id}: ${s.state ?? "?"}, application ${s.sparkApplicationId ?? "-"}, started ${s.startDateTime ?? "-"}, ended ${s.endDateTime ?? "-"}`) }
        : { lines: [], note: `no Spark session is linked to job ${jobId}` };
    });
    for (const s of sessions) {
      const sid = s.livyId ?? s.id;
      const app = s.sparkApplicationId;
      await attempt("Spark monitoring Livy log", `Livy log (session ${sid})`, () => client.request("GET", `/workspaces/${wsId}/${base}/${item.id}/livySessions/${sid}/applications/none/logs?type=livy`, undefined, { accept: "text/plain" }), sections, (r) => {
        return { lines: txt(r.text), raw: true };
      });
      if (!app) continue;
      // Endpoints verified against Microsoft Learn (2026-11): driver log
      //   https://learn.microsoft.com/en-us/fabric/data-engineering/driver-log
      //   GET .../{notebooks|sparkJobDefinitions|lakehouses}/{itemId}/livySessions/{livyId}/applications/{appId}/logs?type=driver&fileName={stderr|stdout}
      // Livy log https://learn.microsoft.com/en-us/fabric/data-engineering/livy-log  (.../applications/none/logs?type=livy)
      for (const f of ["stderr", "stdout"] as const) {
        const url = `/workspaces/${wsId}/${base}/${item.id}/livySessions/${sid}/applications/${app}/logs?type=driver&fileName=${f}`;
        await attempt("Spark monitoring driver log", `driver ${f} (session ${sid})`, () => client.request("GET", url, undefined, { accept: "text/plain" }), sections, (r) => {
          return { lines: txt(r.text), raw: true };
        });
      }
    }
  } else if (item.type === "DataPipeline") {
    const day = 86_400_000;
    const after = new Date((parseUtc(job.startTimeUtc) || Date.now()) - day).toISOString();
    const before = new Date((parseUtc(job.endTimeUtc) || Date.now()) + day).toISOString();
    await attempt(
      "pipeline queryActivityRuns",
      "activity runs",
      async () => {
        const r = await client.request("POST", `/workspaces/${wsId}/datapipelines/pipelineruns/${jobId}/queryactivityruns`, {
          filters: [],
          orderBy: [{ orderBy: "ActivityRunStart", order: "ASC" }],
          lastUpdatedAfter: after,
          lastUpdatedBefore: before,
        });
        return (Array.isArray(r.data) ? r.data : (r.data.value ?? r.data.data ?? [])) as any[];
      },
      sections,
      (runs) => {
        if (!runs.length) return { lines: [], note: "Fabric returned no activity runs for this pipeline run" };
        const lines: string[] = [];
        const ordered = [...runs].sort((a, b) => Number(/fail/i.test(String(b.status))) - Number(/fail/i.test(String(a.status))));
        for (const a of ordered) {
          lines.push(`${a.activityName ?? "?"} (${a.activityType ?? "?"}): ${a.status ?? "?"}${a.durationInMs != null ? `, ${Math.round(a.durationInMs / 1000)}s` : ""}`);
          if (a.error && (a.error.message || a.error.errorCode)) lines.push(`  error ${a.error.errorCode ?? ""}: ${oneLine(a.error.message, 400)}`.replace("error : ", "error: "));
          if (/fail/i.test(String(a.status)) && a.output) lines.push(`  output: ${oneLine(typeof a.output === "string" ? a.output : JSON.stringify(a.output), 400)}`);
        }
        return { lines };
      },
    );
  } else if (item.type === "Eventstream" || item.type === "KQLDatabase" || item.type === "Eventhouse" || item.type === "Warehouse") {
    sections.push({
      source: "none",
      title: "run history",
      available: false,
      lines: [],
      note: `${item.type} has no job or run-history REST API (it streams or queries continuously); use the Monitoring hub, or for query insights run SQL/KQL against the item`,
    });
  } else if (item.type === "Dataflow") {
    sections.push({
      source: "item job scheduler",
      title: "refresh details",
      available: true,
      lines: [],
      note: "the Fabric REST API exposes only the job instance for dataflow refreshes (status and failure reason above); per-query detail is in the Monitoring hub",
    });
  }
  return { job, sections };
}

export interface RunRow {
  itemId: string;
  item: string;
  type: string;
  jobId: string;
  status: string;
  start?: string;
  end?: string;
  duration: string;
  invoke?: string;
  errorCode?: string;
  error: string;
}

export interface WorkspaceRuns {
  rows: RunRow[];
  scanned: number;
  skipped: { item: string; why: string }[];
  source: string;
}

const STATUS_ALIASES: Record<string, string[]> = { failed: ["Failed"], active: ["InProgress", "NotStarted"], running: ["InProgress"], done: ["Completed"], ok: ["Completed"], cancelled: ["Cancelled"] };

/** All job instances across the workspace's runnable items, filtered; items without a job scheduler are skipped and counted. */
export async function workspaceRuns(
  client: FabricClient,
  wsId: string,
  o: { since?: Date; status?: string; item?: string; type?: string; search?: string; top?: number },
): Promise<WorkspaceRuns> {
  const all = await client.items(wsId);
  const wanted = o.item ? all.filter((i) => i.id.toLowerCase() === o.item!.toLowerCase() || i.displayName.toLowerCase() === o.item!.toLowerCase()) : all;
  if (o.item && !wanted.length) throw new AihubError(`item '${o.item}' not found in this workspace`);
  let scanned = 0;
  const scan = wanted.filter((i) => (o.type ? i.type.toLowerCase() === o.type.toLowerCase() : JOB_ITEM_TYPES.includes(i.type)));
  const statuses = o.status ? o.status.split(",").flatMap((s) => STATUS_ALIASES[s.trim().toLowerCase()] ?? [s.trim()]).map((s) => s.toLowerCase()) : undefined;
  const rows: RunRow[] = [];
  const skipped: { item: string; why: string }[] = [];
  for (const it of scan) {
    let jobs: JobInstance[];
    try {
      jobs = await client.jobs(wsId, it.id);
    } catch (e) {
      if (e instanceof FabricHttpError && e.status === 401) throw e;
      skipped.push({ item: it.displayName, why: why(e) });
      continue;
    }
    for (const j of jobs) {
      if (o.since && j.startTimeUtc && parseUtc(j.startTimeUtc) < o.since.getTime()) continue;
      if (statuses && !statuses.includes(String(j.status).toLowerCase())) continue;
      const msg = j.failureReason?.message ?? "";
      if (o.search && !`${it.displayName} ${j.failureReason?.errorCode ?? ""} ${msg}`.toLowerCase().includes(o.search.toLowerCase())) continue;
      rows.push({
        itemId: it.id,
        item: it.displayName,
        type: it.type,
        jobId: j.id,
        status: j.status,
        start: j.startTimeUtc,
        end: j.endTimeUtc,
        duration: durationText(j.startTimeUtc, j.endTimeUtc),
        invoke: j.invokeType,
        errorCode: j.failureReason?.errorCode,
        error: oneLine(msg.split(/\r?\n/).find((l) => l.trim()) ?? "", 120),
      });
    }
  }
  // semantic models have no Fabric job scheduler: their refresh history comes from the Power BI REST API
  const models = wanted.filter((i) => i.type === "SemanticModel" && (!o.type || o.type.toLowerCase() === "semanticmodel"));
  if (models.length) scanned++;
  for (const m of models) {
    let hist: RefreshEntry[];
    try {
      hist = await refreshHistory(client, wsId, m.id, 20);
    } catch (e) {
      if (e instanceof FabricHttpError && e.status === 401) throw e;
      skipped.push({ item: m.displayName, why: `refresh history ${why(e)}` });
      continue;
    }
    for (const h of hist) {
      if (o.since && h.start && parseUtc(h.start) < o.since.getTime()) continue;
      if (statuses && !statuses.includes(h.status.toLowerCase())) continue;
      if (o.search && !`${m.displayName} ${h.errorCode ?? ""} ${h.error}`.toLowerCase().includes(o.search.toLowerCase())) continue;
      rows.push({ itemId: m.id, item: m.displayName, type: m.type, jobId: h.id, status: h.status, start: h.start, end: h.end, duration: durationText(h.start, h.end), invoke: h.kind, errorCode: h.errorCode, error: oneLine(h.error, 120) });
    }
  }
  rows.sort((a, b) => parseUtc(b.start) - parseUtc(a.start) || a.item.localeCompare(b.item));
  scanned += scan.length;
  return {
    rows: o.top ? rows.slice(0, o.top) : rows,
    scanned,
    skipped,
    source: `item job scheduler (GET items/{id}/jobs/instances)${models.length ? " + Power BI refresh history for semantic models" : ""}`,
  };
}

export interface RefreshEntry {
  id: string;
  kind?: string;
  status: string;
  start?: string;
  end?: string;
  errorCode?: string;
  error: string;
}

const PBI = "https://api.powerbi.com/v1.0/myorg";

/** Semantic model refresh history (Power BI REST); Unknown means in progress there. */
export async function refreshHistory(client: FabricClient, wsId: string, modelId: string, top: number): Promise<RefreshEntry[]> {
  const r = await client.request("GET", `${PBI}/groups/${wsId}/datasets/${modelId}/refreshes?$top=${top}`, undefined, { powerbi: true });
  return ((r.data.value ?? []) as any[]).map((h) => {
    let code: string | undefined;
    let msg = "";
    if (h.serviceExceptionJson) {
      try {
        const j = JSON.parse(h.serviceExceptionJson) as { errorCode?: string; errorDescription?: string };
        code = j.errorCode;
        msg = j.errorDescription ?? "";
      } catch {
        msg = String(h.serviceExceptionJson);
      }
    }
    const st = String(h.status ?? "Unknown");
    return { id: String(h.requestId ?? h.id ?? "-"), kind: h.refreshType, status: st === "Unknown" ? "InProgress" : st, start: h.startTime, end: h.endTime, errorCode: code, error: msg };
  });
}

/** Refresh history of one semantic model as log sections (used by `fabric logs --item <model>`). */
export async function collectRefreshLogs(client: FabricClient, wsId: string, item: FabricItem, top: number): Promise<LogSection[]> {
  const sections: LogSection[] = [];
  await attempt("Power BI refresh history", "refreshes", () => refreshHistory(client, wsId, item.id, top), sections, (h) => ({
    lines: h.map((x) => `${x.start ?? "-"} ${x.status} ${x.kind ?? ""} ${durationText(x.start, x.end)} request ${x.id}${x.error || x.errorCode ? ` | ${x.errorCode ?? ""}: ${oneLine(x.error, 300)}` : ""}`),
    note: h.length ? undefined : "no refreshes recorded",
  }));
  return sections;
}
