import { parse } from "yaml";
import { branchRef, findActivePr, getPr, shortBranch, type AdoClient } from "./ado.js";
import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { currentBranch } from "./git.js";
import { parsePrRef } from "./pr.js";
import { readUtf8 } from "./team.js";

export interface Build {
  id: number;
  buildNumber?: string;
  status?: string; // notStarted | inProgress | completed | cancelling | postponed
  result?: string; // succeeded | failed | partiallySucceeded | canceled
  sourceBranch?: string;
  reason?: string;
  queueTime?: string;
  finishTime?: string;
  definition?: { id: number; name: string };
}

interface TimelineRecord {
  id: string;
  parentId?: string | null;
  type: string;
  name: string;
  identifier?: string;
  result?: string | null;
  state?: string;
  order?: number;
  log?: { id: number } | null;
}

export interface SelectOpts {
  pr?: string;
  branch?: string;
  run?: number;
  definition?: string;
  top?: number;
}

const stateOf = (b: Build) => (b.status === "completed" ? (b.result ?? "completed") : (b.status ?? "unknown"));
const defName = (b: Build) => b.definition?.name ?? "pipeline";
const stamp = (t?: string) => (t ? t.slice(0, 16).replace("T", " ") : "-");

async function definitionId(client: AdoClient, name: string): Promise<number> {
  const defs = await client.list<{ id: number; name: string }>("build/definitions", { name });
  const hit = defs.find((d) => d.name.toLowerCase() === name.toLowerCase()) ?? defs[0];
  if (!hit) throw new AihubError(`no pipeline named '${name}'`);
  return hit.id;
}

async function buildsFor(client: AdoClient, branchName: string | undefined, def: number | undefined, top: number): Promise<Build[]> {
  const r = await client.get<{ value?: Build[] }>("build/builds", {
    ...(branchName ? { branchName } : {}),
    ...(def ? { definitions: def } : {}),
    queryOrder: "queueTimeDescending",
    $top: top,
  });
  return r.value ?? [];
}

/** Builds for the selection (newest first). Without flags: the current branch, through its active PR when there is one. */
export async function selectBuilds(client: AdoClient, root: string, o: SelectOpts): Promise<{ builds: Build[]; label: string }> {
  const top = o.top ?? 20;
  if (o.run) return { builds: [await client.get<Build>(`build/builds/${o.run}`)], label: `run ${o.run}` };
  const def = o.definition ? await definitionId(client, o.definition) : undefined;
  let branch = o.branch;
  let prId: number | undefined;
  if (o.pr) prId = parsePrRef(o.pr);
  else if (!branch) {
    branch = currentBranch(root);
    const active = await findActivePr(client, branch);
    if (active) prId = active.pullRequestId;
  }
  if (prId) {
    const pr = await getPr(client, prId);
    let builds = await buildsFor(client, `refs/pull/${prId}/merge`, def, top);
    if (!builds.length) builds = await buildsFor(client, branchRef(shortBranch(pr.sourceRefName)), def, top);
    return { builds, label: `PR !${prId}` };
  }
  return { builds: await buildsFor(client, branchRef(branch!), def, top), label: `branch ${branch}` };
}

export function latestPerDefinition(builds: Build[]): Build[] {
  const seen = new Set<number>();
  const out: Build[] = [];
  for (const b of builds) {
    const k = b.definition?.id ?? 0;
    if (!seen.has(k)) (seen.add(k), out.push(b));
  }
  return out;
}

// ---- timeline and logs ------------------------------------------------------

export async function failedSteps(client: AdoClient, buildId: number): Promise<{ stage: string; step: string; logId?: number }[]> {
  const t = await client.get<{ records?: TimelineRecord[] }>(`build/builds/${buildId}/timeline`);
  const recs = t.records ?? [];
  const byId = new Map(recs.map((r) => [r.id, r]));
  const stageOf = (r: TimelineRecord): string => {
    let p = r.parentId ? byId.get(r.parentId) : undefined;
    let name = "";
    while (p) {
      if (p.type === "Stage") return p.name;
      if (!name && p.type === "Job") name = p.name;
      p = p.parentId ? byId.get(p.parentId) : undefined;
    }
    return name;
  };
  return recs
    .filter((r) => r.type === "Task" && r.result === "failed")
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((r) => ({ stage: stageOf(r), step: r.name, logId: r.log?.id }));
}

const ERROR_RE = /##\[error\]|\berror\b|\bfailed\b|exception|traceback/i;

export function cleanLog(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, ""));
}

/** Last `n` lines, with error lines marked `>> `. */
export function excerpt(lines: string[], n: number): string[] {
  const tail = lines.filter((l, i, a) => l !== "" || i < a.length - 1).slice(-n);
  return tail.map((l) => (ERROR_RE.test(l) ? `>> ${l}` : `   ${l}`));
}

async function stepLog(client: AdoClient, buildId: number, logId: number): Promise<string[]> {
  return cleanLog(await client.getText(`build/builds/${buildId}/logs/${logId}`));
}

// ---- commands -----------------------------------------------------------------

export function parseDuration(s: string | undefined, fallbackMs: number): number {
  if (!s) return fallbackMs;
  const m = /^(\d+)\s*(s|m|h)?$/i.exec(s.trim());
  if (!m) throw new AihubError(`--timeout '${s}' is not a duration (use 90s, 30m or 1h)`);
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? "m").toLowerCase() as "s" | "m" | "h"];
}

const line = (b: Build) => `${defName(b)} #${b.buildNumber ?? b.id} (run ${b.id}): ${stateOf(b)}`;
const isDone = (b: Build) => b.status === "completed";
const isBad = (b: Build) => isDone(b) && b.result !== "succeeded" && b.result !== "partiallySucceeded";

async function failureReport(client: AdoClient, b: Build, tail = 30): Promise<string[]> {
  const out: string[] = [];
  const steps = await failedSteps(client, b.id);
  if (!steps.length) return [`  no failed step in the timeline of run ${b.id}`];
  for (const s of steps) {
    out.push(`  failed: ${s.stage ? `${s.stage} / ` : ""}${s.step}`);
  }
  const first = steps.find((s) => s.logId);
  if (first?.logId) out.push(...excerpt(await stepLog(client, b.id, first.logId), tail).map((l) => `  ${l}`));
  return out;
}

export async function pipelineStatus(ctx: Ctx, o: SelectOpts & { json?: boolean }): Promise<string> {
  const { root, client } = repoClient(ctx);
  const { builds, label } = await selectBuilds(client, root, o);
  const latest = o.run ? builds : latestPerDefinition(builds);
  if (!latest.length) return `${label}: no pipeline runs found`;
  if (o.json) return JSON.stringify(latest.map((b) => ({ id: b.id, name: defName(b), number: b.buildNumber, state: stateOf(b) })));
  const out = [label];
  for (const b of latest) {
    out.push(`  ${line(b)}`);
    if (isBad(b)) for (const l of (await failedSteps(client, b.id)).slice(0, 3)) out.push(`    failed: ${l.stage ? `${l.stage} / ` : ""}${l.step}`);
  }
  return out.join("\n");
}

export async function pipelineFollow(ctx: Ctx, o: SelectOpts & { timeout?: string; interval?: number }): Promise<void> {
  const { root, client } = repoClient(ctx);
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = ctx.now ?? Date.now;
  const timeout = parseDuration(o.timeout, 30 * 60_000);
  const interval = o.interval ?? 15_000;
  const start = now();
  const shown = new Map<number, string>();
  let empty = 0;
  for (;;) {
    const { builds, label } = await selectBuilds(client, root, o);
    const latest = o.run ? builds : latestPerDefinition(builds);
    if (!latest.length) {
      if (++empty > 4) throw new AihubError(`${label}: no pipeline run found after waiting; is a pipeline configured for it?`);
    } else {
      for (const b of latest) {
        const st = stateOf(b);
        if (shown.get(b.id) !== st) {
          shown.set(b.id, st);
          ctx.out(`[${stamp(new Date(now()).toISOString()).slice(11)}] ${line(b)}`);
        }
      }
      if (latest.every(isDone)) {
        const bad = latest.filter(isBad);
        for (const b of bad) {
          ctx.out(`${line(b)}`);
          for (const l of await failureReport(client, b)) ctx.out(l);
        }
        if (bad.length) throw new AihubError(`${bad.length} of ${latest.length} pipeline run(s) did not succeed`);
        ctx.out(`${label}: all ${latest.length} pipeline run(s) finished green`);
        return;
      }
    }
    if (now() - start >= timeout) throw new AihubError(`timeout after ${o.timeout ?? "30m"}: still ${latest.map(stateOf).join(", ") || "no run"}`);
    await sleep(interval);
  }
}

export async function pipelineRuns(ctx: Ctx, o: SelectOpts & { json?: boolean }): Promise<string> {
  const { root, client } = repoClient(ctx);
  const { builds, label } = await selectBuilds(client, root, { ...o, top: o.top ?? 10 });
  const rows = builds.slice(0, o.top ?? 10);
  if (o.json) return JSON.stringify(rows.map((b) => ({ id: b.id, result: stateOf(b), branch: b.sourceBranch && shortBranch(b.sourceBranch), time: b.queueTime, reason: b.reason, pipeline: defName(b) })));
  if (!rows.length) return `${label}: no pipeline runs found`;
  return [
    `${label}: ${rows.length} run(s)`,
    ...rows.map((b) => `${String(b.id).padEnd(7)} ${stateOf(b).padEnd(18)} ${(b.sourceBranch ?? "").replace(/^refs\/(heads\/)?/, "").padEnd(28)} ${stamp(b.queueTime)}  ${b.reason ?? ""}  ${defName(b)}`),
  ].join("\n");
}

export async function pipelineLogs(ctx: Ctx, o: { run: number; step?: string; search?: string; tail?: number; json?: boolean }): Promise<string> {
  const { client } = repoClient(ctx);
  const t = await client.get<{ records?: TimelineRecord[] }>(`build/builds/${o.run}/timeline`);
  const tasks = (t.records ?? []).filter((r) => r.type === "Task" && r.log?.id);
  const rank = (r: TimelineRecord) => (r.result === "failed" ? 0 : r.result === "canceled" ? 1 : 2);
  let sel = tasks.sort((a, b) => rank(a) - rank(b) || (a.order ?? 0) - (b.order ?? 0));
  if (o.step) sel = sel.filter((r) => r.name.toLowerCase().includes(o.step!.toLowerCase()));
  else if (!o.search) sel = sel.filter((r) => r.result === "failed");
  if (!sel.length) return o.step ? `run ${o.run}: no step matches '${o.step}'` : `run ${o.run}: no failed steps (use --step or --search)`;
  const out: string[] = [];
  const tail = o.tail ?? 40;
  for (const r of sel) {
    const lines = await stepLog(client, o.run, r.log!.id);
    if (o.search) {
      const needle = o.search.toLowerCase();
      const hits = lines.map((l, i) => ({ l, i })).filter((x) => x.l.toLowerCase().includes(needle));
      if (!hits.length) continue;
      out.push(`== ${r.name} [${r.result ?? r.state}] ${hits.length} match(es)`);
      for (const h of hits.slice(0, tail)) out.push(`${String(h.i + 1).padStart(5)}: ${h.l}`);
    } else {
      out.push(`== ${r.name} [${r.result ?? r.state}] last ${Math.min(tail, lines.length)} lines`);
      out.push(...excerpt(lines, tail));
    }
  }
  if (!out.length) return `run ${o.run}: no log line contains '${o.search}'`;
  return out.join("\n");
}

export async function pipelineRun(ctx: Ctx, o: { name?: string; branch?: string; paramsFile?: string; json?: boolean }): Promise<string> {
  if (!o.name) throw new AihubError("aihub pipeline run needs --name <pipeline>");
  const { root, client } = repoClient(ctx);
  const id = await definitionId(client, o.name);
  const branch = o.branch ?? currentBranch(root);
  let templateParameters: Record<string, string> | undefined;
  if (o.paramsFile) {
    const p = parse(readUtf8(o.paramsFile)) as Record<string, unknown> | null;
    if (!p || typeof p !== "object") throw new AihubError("--params-file must hold key: value pairs");
    templateParameters = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)]));
  }
  const b = await client.post<Build>("build/builds", {
    definition: { id },
    sourceBranch: branchRef(branch),
    ...(templateParameters ? { templateParameters } : {}),
  });
  return o.json ? JSON.stringify({ id: b.id, pipeline: o.name, branch }) : `queued ${o.name} on ${branch}: run ${b.id}`;
}

/** Re-runs the failed stage(s) of a finished run (or the named one); a run without stages is queued again as a new run. */
export async function pipelineRetry(ctx: Ctx, o: { run: number; stage?: string; json?: boolean }): Promise<string> {
  const { client } = repoClient(ctx);
  const t = await client.get<{ records?: (TimelineRecord & { identifier?: string })[] }>(`build/builds/${o.run}/timeline`);
  const stages = (t.records ?? []).filter((r) => r.type === "Stage");
  if (!stages.length) {
    const b = await client.get<Build>(`build/builds/${o.run}`);
    if (!b.definition?.id) throw new AihubError(`run ${o.run} has no pipeline definition`);
    const again = await client.post<Build>("build/builds", { definition: { id: b.definition.id }, sourceBranch: b.sourceBranch });
    return o.json ? JSON.stringify({ run: again.id, requeuedFrom: o.run }) : `run ${o.run} has no stages: queued ${defName(b)} again as run ${again.id}`;
  }
  const needle = o.stage?.toLowerCase();
  const pick = needle
    ? stages.filter((s) => s.name.toLowerCase() === needle || (s.identifier ?? "").toLowerCase() === needle)
    : stages.filter((s) => s.result === "failed" || s.result === "canceled");
  if (!pick.length) {
    throw new AihubError(
      needle
        ? `run ${o.run}: no stage '${o.stage}' (stages: ${stages.map((s) => s.name).join(", ")})`
        : `run ${o.run}: no failed stage to retry (stages: ${stages.map((s) => `${s.name} ${s.result ?? s.state}`).join(", ")}); pass --stage <name>`,
    );
  }
  for (const s of pick) {
    await client.patch(`build/builds/${o.run}/stages/${encodeURIComponent(s.identifier ?? s.name)}`, { state: "retry", forceRetryAllJobs: false }, { "api-version": "7.1-preview.1" });
  }
  return o.json
    ? JSON.stringify({ run: o.run, retried: pick.map((s) => s.name) })
    : `run ${o.run}: retrying stage ${pick.map((s) => s.name).join(", ")}; follow with aihub pipeline follow --run ${o.run}`;
}
