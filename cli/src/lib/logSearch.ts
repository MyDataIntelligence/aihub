import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { BrowseError, cached, guarded, pool, TTL, type Browse } from "./browse/core.js";
import { browseProjects } from "./browse/read.js";
import { configHome } from "./configHome.js";
import type { RawBuild, Rec } from "./pipelineView.js";

/**
 * Search in pipeline logs ("where did I see this error before?"). Only when asked (`--kinds logs`): the finished runs of the last
 * 30 days in the projects the user can read, failed and partially succeeded runs first, at most 200 step logs per search. A log of
 * a finished run never changes, so it is kept on disk, compressed, in the aihub cache folder (never in a work folder), at most
 * 200 MB (the least recently used go first). Downloads run 4 at a time.
 */

export interface LogSearchOptions {
  text: string;
  top: number;
  project?: string;
  /** days back (30) */
  sinceDays?: number;
  /** only failed and partially succeeded runs */
  failedOnly?: boolean;
  /** a pipeline id, or a part of its name */
  pipeline?: string;
  branch?: string;
  /** step logs per search (200) */
  maxLogs?: number;
}

export interface LogHit {
  line: number;
  text: string;
  ranges: [number, number][];
  run: number;
  runNumber: string;
  result: string;
  finishedAt: string | null;
  pipeline: { id: number; name: string };
  project: string;
  branch: string;
  stepId: string;
  stage: string | null;
  job: string | null;
  step: string;
}

export interface LogSearchResult {
  hits: LogHit[];
  count: number;
  logs: number;
  fromCache: number;
  runs: number;
  runsSearched: number;
  sinceDays: number;
  /** a wider period to search next ("search older…") */
  older: number | null;
}

export const MAX_LOGS = 200;
const MAX_HITS_PER_LOG = 3;
const MAX_LOG_CACHE_BYTES = () => (Number(process.env.AIHUB_LOG_CACHE_MB) || 200) * 1024 * 1024;

// ---- the disk cache ---------------------------------------------------------------------------------------------------

const logDir = (env: NodeJS.ProcessEnv) => join(configHome(env), "cache", "logs");
const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_");
const logFile = (env: NodeJS.ProcessEnv, org: string, project: string, run: number, log: number) => join(logDir(env), `${safe(org)}--${safe(project)}--${run}--${log}.txt.gz`);

export function readCachedLog(env: NodeJS.ProcessEnv, f: string): string | undefined {
  try {
    const text = gunzipSync(readFileSync(f)).toString("utf8");
    const now = new Date();
    utimesSync(f, now, now); // used: the last to go
    return text;
  } catch {
    return undefined;
  }
}

/** Writes a log and keeps the folder under the limit: the files used longest ago go first. */
export function writeCachedLog(env: NodeJS.ProcessEnv, f: string, text: string, limit = MAX_LOG_CACHE_BYTES()): void {
  try {
    mkdirSync(logDir(env), { recursive: true });
    writeFileSync(f, gzipSync(Buffer.from(text, "utf8")));
    const files = readdirSync(logDir(env)).map((n) => {
      const p = join(logDir(env), n);
      const st = statSync(p);
      return { p, size: st.size, at: st.mtimeMs };
    });
    let total = files.reduce((n, x) => n + x.size, 0);
    for (const x of files.sort((a, b) => a.at - b.at)) {
      if (total <= limit) break;
      if (x.p === f) continue;
      rmSync(x.p, { force: true });
      total -= x.size;
    }
  } catch {
    /* a read-only home only costs a download next time */
  }
}

// ---- matching ------------------------------------------------------------------------------------------------------------

/** "2026-11-27T10:15:03.1234567Z ##[error]x" -> "##[error]x": the time stamp Azure DevOps puts before every line. */
export const withoutStamp = (line: string) => line.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z ?/, "");

/** The lines that contain the text (any case), with the ranges of each occurrence; at most `max`. */
export function matchLines(text: string, q: string, max = MAX_HITS_PER_LOG): { line: number; text: string; ranges: [number, number][] }[] {
  const needle = q.toLowerCase();
  const out: { line: number; text: string; ranges: [number, number][] }[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const shown = withoutStamp(lines[i]).replace(/\s+$/, "");
    const low = shown.toLowerCase();
    const first = low.indexOf(needle);
    if (first < 0) continue;
    // a long line is cut around the first match
    const start = shown.length > 240 ? Math.max(0, first - 60) : 0;
    const cut = (start ? "…" : "") + shown.slice(start, start + 240);
    const lowCut = cut.toLowerCase();
    const ranges: [number, number][] = [];
    for (let at = lowCut.indexOf(needle); at >= 0 && ranges.length < 10; at = lowCut.indexOf(needle, at + needle.length)) ranges.push([at, at + needle.length]);
    out.push({ line: i + 1, text: cut, ranges });
  }
  return out;
}

const FAILED = ["failed", "partiallySucceeded"];
/** Failed and partially succeeded runs first, then the newest. */
export function runOrder(a: RawBuild, b: RawBuild): number {
  const fa = FAILED.includes(a.result ?? "") ? 0 : 1;
  const fb = FAILED.includes(b.result ?? "") ? 0 : 1;
  return fa - fb || (Date.parse(b.finishTime ?? "") || 0) - (Date.parse(a.finishTime ?? "") || 0);
}

/** The step logs of a run's timeline: failed steps first; jobs and stages are left out (their logs repeat the steps). */
export function stepLogs(recs: Rec[]): { rec: Rec; stage: string | null; job: string | null }[] {
  const byId = new Map(recs.map((r) => [r.id, r]));
  const up = (r: Rec, type: string): Rec | undefined => {
    let p = r.parentId ? byId.get(r.parentId) : undefined;
    while (p && p.type !== type) p = p.parentId ? byId.get(p.parentId) : undefined;
    return p;
  };
  return recs
    .filter((r) => r.type === "Task" && r.log?.id)
    .map((rec) => {
      const stage = up(rec, "Stage");
      return { rec, stage: stage && stage.identifier !== "__default" ? stage.name : null, job: up(rec, "Job")?.name ?? null };
    })
    .sort((a, b) => Number(b.rec.result === "failed") - Number(a.rec.result === "failed") || (a.rec.order ?? 0) - (b.rec.order ?? 0));
}

// ---- the search -------------------------------------------------------------------------------------------------------

export async function searchLogs(b: Browse, o: LogSearchOptions): Promise<LogSearchResult> {
  const q = o.text.trim();
  if (q.length < 3) throw new BrowseError("badInput", "log search needs at least 3 characters");
  const sinceDays = Math.min(Math.max(o.sinceDays ?? 30, 1), 365);
  const maxLogs = Math.min(Math.max(o.maxLogs ?? MAX_LOGS, 1), 1000);
  const minTime = new Date(b.now() - sinceDays * 86_400_000).toISOString();
  const { projects } = await browseProjects(b);
  const names = projects.map((p) => p.name).filter((n) => !o.project || n.toLowerCase() === o.project.toLowerCase()).slice(0, 25);
  if (o.project && !names.length) throw new BrowseError("notFound", `project '${o.project}' not found or not readable`);
  const pipeId = o.pipeline && /^\d+$/.test(o.pipeline) ? Number(o.pipeline) : undefined;
  const pipeName = o.pipeline && pipeId === undefined ? o.pipeline.toLowerCase() : undefined;

  // the finished runs of the period, per project (one list call each, kept 2 minutes)
  const runs: { run: RawBuild; project: string }[] = [];
  await pool(names, 4, async (p) => {
    try {
      const query: Record<string, string | number> = { minTime, statusFilter: "completed", queryOrder: "finishTimeDescending", $top: 200 };
      if (o.failedOnly) query.resultFilter = "failed,partiallySucceeded";
      if (pipeId) query.definitions = pipeId;
      if (o.branch) query.branchName = o.branch.startsWith("refs/") ? o.branch : `refs/heads/${o.branch}`;
      const list = await guarded(b, p, () =>
        cached(b, `log-runs|${b.org}|${p}|${JSON.stringify(query).replace(minTime, String(sinceDays))}`, TTL.short, () =>
          b.client.forProject(p).get<{ value?: RawBuild[] }>("build/builds", query).then((r) => r.value ?? []),
        ),
      );
      for (const run of list.data) if (!pipeName || (run.definition?.name ?? "").toLowerCase().includes(pipeName)) runs.push({ run, project: p });
    } catch {
      /* a project that cannot be read does not stop the others */
    }
  });
  runs.sort((x, y) => runOrder(x.run, y.run));

  // the step logs, run by run, until the budget is used (a timeline of a finished run never changes: kept for good)
  const work: { run: RawBuild; project: string; rec: Rec; stage: string | null; job: string | null }[] = [];
  let runsSearched = 0;
  for (let i = 0; i < runs.length && work.length < maxLogs; i += 4) {
    const batch = runs.slice(i, i + 4);
    const timelines = await pool(batch, 4, async (x) => {
      try {
        return (await cached(b, `timeline|${b.org}|${x.project}|${x.run.id}`, TTL.forever, () => b.client.forProject(x.project).get<{ records?: Rec[] }>(`build/builds/${x.run.id}/timeline`).then((r) => r.records ?? []))).data;
      } catch {
        return [] as Rec[];
      }
    });
    batch.forEach((x, k) => {
      if (work.length >= maxLogs) return;
      runsSearched++;
      for (const s of stepLogs(timelines[k])) if (work.length < maxLogs) work.push({ ...x, ...s });
    });
  }

  let fromCache = 0;
  const hits: LogHit[] = [];
  await pool(work, 4, async (w) => {
    const logId = w.rec.log!.id;
    const f = logFile(b.env, b.org, w.project, w.run.id, logId);
    let text = existsSync(f) ? readCachedLog(b.env, f) : undefined;
    if (text !== undefined) fromCache++;
    else {
      try {
        text = await b.client.forProject(w.project).getText(`build/builds/${w.run.id}/logs/${logId}`);
        writeCachedLog(b.env, f, text);
      } catch {
        return;
      }
    }
    for (const m of matchLines(text, q))
      hits.push({
        ...m,
        run: w.run.id,
        runNumber: w.run.buildNumber ?? String(w.run.id),
        result: w.run.result ?? "",
        finishedAt: w.run.finishTime ?? null,
        pipeline: { id: w.run.definition?.id ?? 0, name: w.run.definition?.name ?? "" },
        project: w.project,
        branch: (w.run.sourceBranch ?? "").replace(/^refs\/heads\//, ""),
        stepId: w.rec.id,
        stage: w.stage,
        job: w.job,
        step: w.rec.name,
      });
  });
  // the order of the runs (failed first, newest), then the place in the log
  const order = new Map(runs.map((x, i) => [x.run.id, i]));
  hits.sort((a, c) => (order.get(a.run) ?? 0) - (order.get(c.run) ?? 0) || a.stepId.localeCompare(c.stepId) || a.line - c.line);
  const older = sinceDays < 365 ? Math.min(sinceDays * 3, 365) : null;
  return { hits: hits.slice(0, Math.max(o.top, 1)), count: hits.length, logs: work.length, fromCache, runs: runs.length, runsSearched, sinceDays, older };
}
