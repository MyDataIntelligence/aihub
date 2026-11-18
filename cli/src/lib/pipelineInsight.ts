import { parse as parseYaml } from "yaml";
import { trace } from "./trace.js";
import type { AdoClient } from "./ado.js";
import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { cut, day, emit, encode, guardStage, table, top, type Flags } from "./devops.js";
import { findGroup } from "./library.js";

interface Build {
  id: number;
  buildNumber?: string;
  status?: string;
  result?: string;
  sourceBranch?: string;
  sourceVersion?: string;
  reason?: string;
  queueTime?: string;
  startTime?: string;
  finishTime?: string;
  parameters?: string;
  templateParameters?: Record<string, string>;
  definition?: { id: number; name: string };
  requestedFor?: { displayName?: string };
}

const getBuild = (c: AdoClient, id: number) => c.get<Build>(`build/builds/${id}`);

export function seconds(start?: string, finish?: string): number | undefined {
  if (!start) return undefined;
  const a = Date.parse(start);
  const b = finish ? Date.parse(finish) : NaN;
  return Number.isNaN(a) || Number.isNaN(b) ? undefined : Math.max(0, Math.round((b - a) / 1000));
}

export function dur(s: number | undefined): string {
  if (s === undefined) return "";
  return s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m` : s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

// ---- timeline ---------------------------------------------------------------------------------------------------

interface Rec {
  id: string;
  parentId?: string | null;
  type: string;
  name: string;
  state?: string;
  result?: string | null;
  startTime?: string;
  finishTime?: string;
  order?: number;
  attempt?: number;
  issues?: { type?: string; message?: string }[];
  previousAttempts?: { attempt?: number; timelineId?: string }[];
  log?: { id: number } | null;
}

export async function timeline(c: AdoClient, ctx: Ctx, v: Flags, run: number): Promise<void> {
  const b = await getBuild(c, run);
  const t = await c.get<{ records?: Rec[] }>(`build/builds/${run}/timeline`);
  const recs = t.records ?? [];
  const kids = new Map<string, Rec[]>();
  for (const r of recs) kids.set(r.parentId ?? "", [...(kids.get(r.parentId ?? "") ?? []), r]);
  for (const list of kids.values()) list.sort((a, b2) => (a.order ?? 0) - (b2.order ?? 0));
  const shown = (r: Rec) => (r.type === "Task" ? !!v.tasks || /failed|canceled|abandoned/i.test(r.result ?? "") || (r.issues ?? []).length > 0 : ["Stage", "Phase", "Job"].includes(r.type));
  const lines: string[] = [];
  const data: any[] = [];
  const walk = (parent: string, depth: number) => {
    for (const r of kids.get(parent) ?? []) {
      if (r.type === "Checkpoint" || r.type.startsWith("Checkpoint.")) continue;
      const bad = /failed|canceled|abandoned/i.test(r.result ?? "");
      const next = r.type === "Phase" ? depth : depth + 1;
      if (shown(r) && !(v.failed && !bad && r.type === "Task") && r.type !== "Phase") {
        const d = dur(seconds(r.startTime, r.finishTime));
        const mark = r.result ? String(r.result) : String(r.state ?? "");
        const retry = (r.attempt ?? 1) > 1 || (r.previousAttempts ?? []).length ? ` (attempt ${r.attempt ?? 1}, ${(r.previousAttempts ?? []).length} earlier)` : "";
        lines.push(`${"  ".repeat(depth)}${r.type.toLowerCase()} ${r.name} ${mark}${d ? ` ${d}` : ""}${retry}`);
        const issues = (r.issues ?? []).filter((i) => i.type === "error" || v.warnings);
        for (const i of issues.slice(0, 5)) lines.push(`${"  ".repeat(depth + 1)}${i.type}: ${cut(i.message, 200)}`);
        data.push({ type: r.type, name: r.name, result: r.result ?? r.state, seconds: seconds(r.startTime, r.finishTime), attempt: r.attempt, issues: (r.issues ?? []).map((i) => ({ type: i.type, message: i.message })), log: r.log?.id });
      }
      walk(r.id, shown(r) && r.type !== "Phase" ? next : depth);
    }
  };
  walk("", 0);
  const head = `run ${run} ${b.definition?.name ?? ""} ${b.buildNumber ?? ""}: ${b.result ?? b.status} ${dur(seconds(b.startTime ?? b.queueTime, b.finishTime))} on ${String(b.sourceBranch ?? "").replace("refs/heads/", "")}`;
  emit(ctx, v, { run, result: b.result ?? b.status, branch: b.sourceBranch, records: data }, [head, ...lines].join("\n"));
}

// ---- tests ---------------------------------------------------------------------------------------------------------

interface TestRun {
  id: number;
  name: string;
  state?: string;
  totalTests?: number;
  passedTests?: number;
  incompleteTests?: number;
  notApplicableTests?: number;
  unanalyzedTests?: number;
}

interface TestResult {
  id: number;
  testCaseTitle?: string;
  automatedTestName?: string;
  outcome?: string;
  errorMessage?: string;
  stackTrace?: string;
  durationInMs?: number;
}

async function failedResults(c: AdoClient, build: number, limit: number): Promise<{ run: TestRun; results: TestResult[] }[]> {
  const runs = (await c.get<{ value?: TestRun[] }>("test/runs", { buildUri: `vstfs:///Build/Build/${build}`, "api-version": "7.1" })).value ?? [];
  const out: { run: TestRun; results: TestResult[] }[] = [];
  for (const r of runs) {
    const res = await c.get<{ value?: TestResult[] }>(`test/runs/${r.id}/results`, { outcomes: "Failed", $top: limit, detailsToInclude: "None", "api-version": "7.1" }).catch(() => ({ value: [] as TestResult[] }));
    out.push({ run: r, results: res.value ?? [] });
  }
  return out;
}

const nameOf = (r: TestResult) => r.automatedTestName ?? r.testCaseTitle ?? "";

export async function tests(c: AdoClient, ctx: Ctx, v: Flags, run: number): Promise<void> {
  const b = await getBuild(c, run);
  const groups = await failedResults(c, run, top(v, 50));
  const failed = groups.flatMap((g) => g.results);
  // flaky marker: the same test in the failed results of the previous runs of this pipeline
  const history = Math.max(0, Number(typeof v.history === "string" ? v.history : 5));
  const prior: Set<string>[] = [];
  if (history && b.definition?.id && failed.length) {
    const prev = (await c.get<{ value?: Build[] }>("build/builds", { definitions: b.definition.id, $top: history + 1, queryOrder: "queueTimeDescending", statusFilter: "completed" })).value ?? [];
    for (const p of prev.filter((x) => x.id !== run).slice(0, history)) prior.push(new Set((await failedResults(c, p.id, 200)).flatMap((g) => g.results.map(nameOf))));
  }
  const totals = groups.reduce((a, g) => ({ total: a.total + (g.run.totalTests ?? 0), passed: a.passed + (g.run.passedTests ?? 0) }), { total: 0, passed: 0 });
  const rows = failed.map((r) => {
    const n = nameOf(r);
    const times = prior.filter((s) => s.has(n)).length;
    const flaky = prior.length === 0 ? undefined : times === 0 ? "new" : times === prior.length ? "failing in all previous runs" : `intermittent: failed in ${times} of ${prior.length} previous runs`;
    return { test: n, message: cut(r.errorMessage, 300), stack: (r.stackTrace ?? "").split("\n").slice(0, 3).join(" | ").slice(0, 300), flaky };
  });
  const head = `run ${run}: ${groups.length} test run(s), ${totals.total} test(s), ${totals.passed} passed, ${failed.length} failed`;
  emit(ctx, v, { run, testRuns: groups.length, total: totals.total, passed: totals.passed, failed: rows }, [head, ...rows.flatMap((r) => [`  FAILED ${r.test}${r.flaky ? `  [${r.flaky}]` : ""}`, ...(r.message ? [`    ${r.message}`] : []), ...(r.stack ? [`    at ${r.stack}`] : [])])].join("\n"));
}

// ---- coverage, variables, compare ---------------------------------------------------------------------------------------

export async function coverage(c: AdoClient, ctx: Ctx, v: Flags, run: number): Promise<void> {
  const r = await c.get<{ coverageData?: { coverageStats?: { label?: string; covered?: number; total?: number }[] }[] }>("test/codecoverage", { buildId: run, "api-version": "7.1-preview.1" });
  const stats = (r.coverageData ?? []).flatMap((d) => d.coverageStats ?? []).map((s) => ({ label: s.label, covered: s.covered ?? 0, total: s.total ?? 0, percent: s.total ? Math.round((1000 * (s.covered ?? 0)) / s.total) / 10 : 0 }));
  emit(ctx, v, { run, coverage: stats }, stats.length ? table([["metric", "covered", "total", "%"], ...stats.map((s) => [s.label ?? "", String(s.covered), String(s.total), String(s.percent)])]) : `run ${run} published no code coverage`);
}

function queueParams(b: Build): Record<string, string> {
  let p: Record<string, unknown> = {};
  try {
    p = b.parameters ? (JSON.parse(b.parameters) as Record<string, unknown>) : {};
  } catch {
    p = {};
  }
  return { ...Object.fromEntries(Object.entries(p).map(([k, x]) => [k, String(x)])), ...(b.templateParameters ?? {}) };
}

export async function vars(c: AdoClient, ctx: Ctx, v: Flags, run: number): Promise<void> {
  const b = await getBuild(c, run);
  const def = await c.get<{ variables?: Record<string, { value?: string; isSecret?: boolean; allowOverride?: boolean }>; variableGroups?: { id: number; name?: string }[] }>(`build/definitions/${b.definition?.id}`);
  const defined = Object.entries(def.variables ?? {}).map(([k, x]) => ({ name: k, value: x.isSecret ? "***" : x.value ?? "", secret: !!x.isSecret }));
  const groups = (def.variableGroups ?? []).map((g) => g.name ?? String(g.id));
  const q = queueParams(b);
  const sys = { "Build.SourceBranch": b.sourceBranch, "Build.SourceVersion": b.sourceVersion, "Build.Reason": b.reason, "Build.BuildNumber": b.buildNumber, "Build.RequestedFor": b.requestedFor?.displayName };
  emit(ctx, v, { run, pipeline: b.definition?.name, variables: defined, variableGroups: groups, queueTimeParameters: q, system: sys }, [
    `run ${run} ${b.definition?.name ?? ""}`,
    ...Object.entries(sys).map(([k, x]) => `  ${k} = ${x ?? ""}`),
    ...(groups.length ? [`  variable groups: ${groups.join(", ")} (see: aihub library show --group <name>)`] : []),
    ...defined.map((d) => `  ${d.name} = ${d.value}${d.secret ? " (secret)" : ""}`),
    ...Object.entries(q).map(([k, x]) => `  queue-time ${k} = ${/pass|secret|token|key/i.test(k) ? "***" : x}`),
  ].join("\n"));
}

export async function compare(c: AdoClient, ctx: Ctx, v: Flags, a: number, b2: number): Promise<void> {
  const [A, B] = [await getBuild(c, a), await getBuild(c, b2)];
  const [ta, tb] = [await c.get<{ records?: Rec[] }>(`build/builds/${a}/timeline`), await c.get<{ records?: Rec[] }>(`build/builds/${b2}/timeline`)];
  const stages = (t: { records?: Rec[] }) => Object.fromEntries((t.records ?? []).filter((r) => r.type === "Stage").map((r) => [r.name, { result: r.result ?? r.state, seconds: seconds(r.startTime, r.finishTime) }]));
  const [sa, sb] = [stages(ta), stages(tb)];
  const names = [...new Set([...Object.keys(sa), ...Object.keys(sb)])];
  const stageRows = names.map((n) => ({ stage: n, a: sa[n], b: sb[n] }));
  const [pa, pb] = [queueParams(A), queueParams(B)];
  const paramNames = [...new Set([...Object.keys(pa), ...Object.keys(pb)])].filter((k) => pa[k] !== pb[k]);
  let commits: string[] = [];
  if (A.sourceVersion && B.sourceVersion && A.sourceVersion !== B.sourceVersion) {
    const r = await c.get<{ value?: { commitId: string; comment?: string }[] }>(`${c.repoPath()}/commits`, { "searchCriteria.fromCommitId": A.sourceVersion, "searchCriteria.toCommitId": B.sourceVersion, "searchCriteria.$top": 30 }).catch(() => ({ value: [] as { commitId: string; comment?: string }[] }));
    commits = (r.value ?? []).map((x) => `${x.commitId.slice(0, 8)} ${cut(x.comment, 70)}`);
  }
  const text = [
    `run ${a}: ${A.result ?? A.status} on ${String(A.sourceBranch).replace("refs/heads/", "")} @ ${String(A.sourceVersion).slice(0, 8)}`,
    `run ${b2}: ${B.result ?? B.status} on ${String(B.sourceBranch).replace("refs/heads/", "")} @ ${String(B.sourceVersion).slice(0, 8)}`,
    `commits between: ${commits.length ? "\n  " + commits.join("\n  ") : A.sourceVersion === B.sourceVersion ? "none (same commit)" : "not available (different branches or history)"}`,
    `parameters that differ: ${paramNames.length ? paramNames.map((k) => `${k}: ${pa[k] ?? "-"} -> ${pb[k] ?? "-"}`).join("; ") : "none"}`,
    table([["stage", `#${a}`, `#${b2}`, "duration change"], ...stageRows.map((r) => [r.stage, `${r.a?.result ?? "-"} ${dur(r.a?.seconds)}`.trim(), `${r.b?.result ?? "-"} ${dur(r.b?.seconds)}`.trim(), r.a?.seconds !== undefined && r.b?.seconds !== undefined ? `${r.b.seconds - r.a.seconds >= 0 ? "+" : ""}${r.b.seconds - r.a.seconds}s` : ""])]),
  ].join("\n");
  emit(ctx, v, { a: { run: a, result: A.result, commit: A.sourceVersion }, b: { run: b2, result: B.result, commit: B.sourceVersion }, commits, parameterChanges: paramNames, stages: stageRows }, text);
}

// ---- triggers and schedules (read from the YAML of the pipeline) -------------------------------------------------------------

interface Def {
  id: number;
  name: string;
  process?: { yamlFilename?: string; type?: number };
  repository?: { id?: string; type?: string; defaultBranch?: string };
  triggers?: { triggerType?: string; branchFilters?: string[]; schedules?: unknown[] }[];
}

async function defOf(c: AdoClient, ref: string): Promise<Def> {
  if (/^\d+$/.test(ref)) return c.get<Def>(`build/definitions/${ref}`);
  const defs = await c.list<Def>("build/definitions", { name: ref });
  const hit = defs.filter((d) => d.name.toLowerCase() === ref.toLowerCase());
  if (hit.length !== 1) throw new AihubError(hit.length ? `pipeline name '${ref}' is not unique; use the id` : `pipeline '${ref}' not found; see: aihub pipeline def list`);
  return c.get<Def>(`build/definitions/${hit[0].id}`);
}

async function yamlOf(c: AdoClient, d: Def, branch?: string): Promise<any> {
  if (!d.process?.yamlFilename || d.repository?.type !== "TfsGit" || !d.repository.id) return undefined;
  const text = await c.getText(`git/repositories/${d.repository.id}/items`, { path: d.process.yamlFilename, "versionDescriptor.version": branch ?? String(d.repository.defaultBranch ?? "main").replace("refs/heads/", ""), "versionDescriptor.versionType": "branch", $format: "text" });
  return parseYaml(text);
}

const list = (x: unknown): string[] => (Array.isArray(x) ? x.map(String) : x && typeof x === "object" ? Object.entries(x as Record<string, unknown>).flatMap(([k, y]) => (Array.isArray(y) ? y.map((z) => `${k}:${String(z)}`) : [])) : x === "none" ? ["none"] : []);

export async function triggerShow(c: AdoClient, ctx: Ctx, v: Flags, ref: string): Promise<void> {
  const d = await defOf(c, ref);
  let missing = "";
  const y = await yamlOf(c, d, typeof v.branch === "string" ? v.branch : undefined).catch((e) => {
    if (e instanceof AihubError && /\(404\)/.test(e.message)) {
      missing = `${d.process?.yamlFilename} does not exist on ${typeof v.branch === "string" ? v.branch : "the default branch"}`;
      return undefined;
    }
    throw e;
  });
  const trig = y?.trigger;
  const ci = trig === "none" || trig === false ? { disabled: true } : Array.isArray(trig) ? { branches: { include: trig } } : trig ?? (y ? { default: "every push to every branch" } : undefined);
  const pr = y?.pr === "none" ? { disabled: true } : Array.isArray(y?.pr) ? { branches: { include: y.pr } } : y?.pr;
  const res = y?.resources ?? {};
  const data = {
    pipeline: d.name,
    yaml: d.process?.yamlFilename,
    ci,
    pr,
    schedules: (y?.schedules ?? []).map((s: any) => ({ cron: s.cron, displayName: s.displayName, branches: list(s.branches?.include), always: !!s.always })),
    resources: { repositories: (res.repositories ?? []).map((r: any) => r.repository), pipelines: (res.pipelines ?? []).map((p: any) => `${p.pipeline}${p.source ? ` (${p.source})` : ""}${p.trigger ? " [trigger]" : ""}`), containers: (res.containers ?? []).map((x: any) => x.container) },
    parameters: (y?.parameters ?? []).map((p: any) => `${p.name}${p.default !== undefined ? ` = ${JSON.stringify(p.default)}` : ""}`),
    classicTriggers: (d.triggers ?? []).map((t) => t.triggerType),
  };
  const lines = [
    `${d.name} (${d.process?.yamlFilename ?? "classic"})${missing ? `  NOTE: ${missing}` : ""}`,
    `  ci trigger: ${data.ci ? JSON.stringify(data.ci) : "none in YAML"}`,
    `  pr trigger: ${data.pr ? JSON.stringify(data.pr) : "none in YAML (branch policies may still build it)"}`,
    `  schedules: ${data.schedules.length ? data.schedules.map((s: any) => `${s.cron}${s.branches.length ? ` on ${s.branches.join(",")}` : ""}${s.always ? " (always)" : ""}`).join("; ") : "none"}`,
    `  resources: repos ${data.resources.repositories.join(", ") || "-"}; pipelines ${data.resources.pipelines.join(", ") || "-"}; containers ${data.resources.containers.join(", ") || "-"}`,
    `  parameters: ${data.parameters.join(", ") || "none"}`,
  ];
  emit(ctx, v, data, lines.join("\n"));
}

export async function scheduleList(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const defs = await c.list<Def>("build/definitions", { $top: top(v, 100), includeAllProperties: true });
  const rows: { pipeline: string; id: number; source: string; schedule: string }[] = [];
  for (const d of defs) {
    for (const t of d.triggers ?? []) if (t.triggerType === "schedule") for (const s of t.schedules ?? []) rows.push({ pipeline: d.name, id: d.id, source: "classic", schedule: JSON.stringify(s) });
    if (d.process?.yamlFilename && d.repository?.type === "TfsGit") {
      const y = await yamlOf(c, d).catch(() => undefined);
      for (const s of y?.schedules ?? []) rows.push({ pipeline: d.name, id: d.id, source: "yaml", schedule: `${s.cron}${s.branches?.include ? ` on ${list(s.branches.include).join(",")}` : ""}${s.always ? " (always)" : ""}` });
    }
  }
  const f = typeof v.filter === "string" ? v.filter.toLowerCase() : "";
  const out = rows.filter((r) => !f || r.pipeline.toLowerCase().includes(f));
  emit(ctx, v, out, out.length ? table([["id", "pipeline", "source", "schedule"], ...out.map((r) => [String(r.id), r.pipeline, r.source, r.schedule])]) : "no scheduled pipelines");
}

// ---- pipeline permissions (authorize a pipeline to use a resource) ---------------------------------------------------------

export async function authorize(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const spec = typeof v.resource === "string" ? v.resource : "";
  const m = /^(environment|variablegroup|endpoint|securefile|queue):(.+)$/.exec(spec);
  if (!m) throw new AihubError("--resource <environment|variablegroup|endpoint|securefile|queue>:<name>, for example environment:dev or variablegroup:vg-dev");
  const [, kind, name] = m;
  guardStage(name, v, `${kind}`);
  const defs = await c.list<{ id: number; name: string }>("build/definitions", { name: String(v.pipeline ?? "") });
  const pipe = defs.find((d) => d.name.toLowerCase() === String(v.pipeline ?? "").toLowerCase() || String(d.id) === v.pipeline);
  if (!pipe) throw new AihubError(`pipeline '${v.pipeline ?? ""}' not found; see: aihub pipeline def list`);
  let rid: string;
  if (kind === "variablegroup") rid = String((await findGroup(c, name)).id);
  else if (kind === "environment") {
    const e = (await c.list<{ id: number; name: string }>("pipelines/environments", { name, "api-version": "7.1-preview.1" })).find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!e) throw new AihubError(`environment '${name}' not found`);
    rid = String(e.id);
  } else if (kind === "endpoint") {
    const e = (await c.list<{ id: string; name: string }>("serviceendpoint/endpoints", { endpointNames: name, "api-version": "7.1" })).find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!e) throw new AihubError(`service connection '${name}' not found`);
    rid = e.id;
  } else if (kind === "securefile") {
    const r = await c.get<{ value?: { id: string; name: string }[] }>("distributedtask/securefiles", { "api-version": "7.1-preview.1" });
    const e = (r.value ?? []).find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!e) throw new AihubError(`secure file '${name}' not found`);
    rid = e.id;
  } else rid = name;
  await c.patch(`pipelines/pipelinePermissions/${kind}/${encode(rid)}`, { pipelines: [{ id: pipe.id, authorized: !v.revoke }] }, { "api-version": "7.1-preview.1" });
  emit(ctx, v, { pipeline: pipe.name, resource: spec, authorized: !v.revoke }, `${trace.dryRun ? "dry-run: would " : ""}${v.revoke ? "revoke" : "authorize"} pipeline '${pipe.name}' for ${spec}`);
}

export { day };
