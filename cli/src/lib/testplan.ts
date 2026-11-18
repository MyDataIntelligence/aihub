import { trace } from "./trace.js";
import type { AdoClient } from "./ado.js";
import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { confirmDelete, cut, day, emit, table, top, type Flags } from "./devops.js";

const API = { "api-version": "7.1" };

interface Plan {
  id: number;
  name: string;
  state?: string;
  areaPath?: string;
  iteration?: string;
  startDate?: string;
  endDate?: string;
  rootSuite?: { id: number };
}

async function findPlan(c: AdoClient, ref: string): Promise<Plan> {
  if (/^\d+$/.test(ref)) return c.get<Plan>(`testplan/plans/${ref}`, API);
  const plans = await c.list<Plan>("testplan/plans", API);
  const hit = plans.filter((p) => p.name.toLowerCase() === ref.toLowerCase());
  if (hit.length !== 1) throw new AihubError(hit.length ? `test plan name '${ref}' is not unique; use the id` : `test plan '${ref}' not found; see: aihub testplan plans`);
  return hit[0];
}

export async function plans(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const all = await c.list<Plan>("testplan/plans", API);
  const f = typeof v.filter === "string" ? v.filter.toLowerCase() : "";
  const rows = all.filter((p) => !f || p.name.toLowerCase().includes(f)).slice(0, top(v, 100));
  emit(ctx, v, rows.map((p) => ({ id: p.id, name: p.name, state: p.state, iteration: p.iteration })), rows.length ? table([["id", "plan", "state", "iteration"], ...rows.map((p) => [String(p.id), p.name, p.state ?? "", p.iteration ?? ""])]) : "no test plans");
}

interface Suite {
  id: number;
  name: string;
  suiteType?: string;
  hasChildren?: boolean;
  parentSuite?: { id: number };
  children?: Suite[];
}

export async function suites(c: AdoClient, ctx: Ctx, v: Flags, planRef: string): Promise<void> {
  const p = await findPlan(c, planRef);
  const all = await c.list<Suite>(`testplan/Plans/${p.id}/suites`, API);
  const byParent = new Map<number | undefined, Suite[]>();
  for (const s of all) byParent.set(s.parentSuite?.id, [...(byParent.get(s.parentSuite?.id) ?? []), s]);
  const lines: string[] = [];
  const walk = (parent: number | undefined, depth: number) => {
    for (const s of byParent.get(parent) ?? []) {
      lines.push(`${"  ".repeat(depth)}${s.name}  (#${s.id}${s.suiteType ? `, ${s.suiteType.replace(/TestSuite$/i, "")}` : ""})`);
      walk(s.id, depth + 1);
    }
  };
  const roots = all.filter((s) => !s.parentSuite || !all.some((x) => x.id === s.parentSuite?.id)).map((s) => s.parentSuite?.id);
  for (const r of [...new Set(roots)]) walk(r, 0);
  emit(ctx, v, { plan: p.name, suites: all.map((s) => ({ id: s.id, name: s.name, parent: s.parentSuite?.id, type: s.suiteType })) }, lines.length ? [`${p.name} (#${p.id})`, ...lines].join("\n") : `${p.name} has no suites`);
}

export async function cases(c: AdoClient, ctx: Ctx, v: Flags, planRef: string, suite: number): Promise<void> {
  const p = await findPlan(c, planRef);
  const all = await c.list<{ workItem?: { id: number; name?: string } }>(`testplan/Plans/${p.id}/Suites/${suite}/TestCase`, API);
  const rows = all.slice(0, top(v, 200)).map((x) => ({ id: x.workItem?.id, title: x.workItem?.name }));
  emit(ctx, v, rows, rows.length ? rows.map((r) => `AB#${r.id} ${cut(r.title, 80)}`).join("\n") : "this suite has no test cases");
}

interface Point {
  id: number;
  testCaseReference?: { id?: number; name?: string };
  configuration?: { name?: string };
  tester?: { displayName?: string };
  results?: { outcome?: string; lastResultDetails?: { dateCompleted?: string } };
}

export async function points(c: AdoClient, ctx: Ctx, v: Flags, planRef: string, suite: number): Promise<void> {
  const p = await findPlan(c, planRef);
  const all = await c.list<Point>(`testplan/Plans/${p.id}/Suites/${suite}/TestPoint`, API);
  const f = typeof v.outcome === "string" ? v.outcome.toLowerCase() : "";
  const rows = all.map((x) => ({ id: x.id, caseId: x.testCaseReference?.id, name: x.testCaseReference?.name, outcome: x.results?.outcome ?? "unspecified", tester: x.tester?.displayName, config: x.configuration?.name })).filter((r) => !f || r.outcome.toLowerCase() === f).slice(0, top(v, 200));
  emit(ctx, v, rows, rows.length ? table([["point", "case", "outcome", "tester", "title"], ...rows.map((r) => [String(r.id), `AB#${r.caseId}`, r.outcome, r.tester ?? "", cut(r.name, 60)])]) : "no test points match");
}

/** Outcome names of the Test Plans API. */
const OUTCOMES = ["passed", "failed", "blocked", "notApplicable", "inconclusive", "notExecuted", "unspecified"];

export async function outcome(c: AdoClient, ctx: Ctx, v: Flags, planRef: string, suite: number): Promise<void> {
  const p = await findPlan(c, planRef);
  const ids = typeof v.points === "string" ? v.points.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0) : [];
  const out = String(v.outcome ?? "");
  if (!ids.length) throw new AihubError("--points <id,id> is required (see: aihub testplan points)");
  if (!OUTCOMES.includes(out)) throw new AihubError(`--outcome must be one of ${OUTCOMES.join(", ")}`);
  await c.patch(`testplan/Plans/${p.id}/Suites/${suite}/TestPoint`, ids.map((id) => ({ id, results: { outcome: out } })), API);
  emit(ctx, v, { plan: p.name, points: ids, outcome: out }, `${trace.dryRun ? "dry-run: would set" : "set"} ${ids.length} test point(s) of '${p.name}' to ${out}`);
}

export async function createPlan(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const name = typeof v.name === "string" ? v.name : "";
  if (!name) throw new AihubError("aihub testplan create-plan needs --name (optional: --area, --iteration, --start, --end)");
  const body: any = { name };
  if (typeof v.area === "string") body.areaPath = v.area;
  if (typeof v.iteration === "string") body.iteration = v.iteration;
  if (typeof v.start === "string") body.startDate = v.start;
  if (typeof v.end === "string") body.endDate = v.end;
  const made = await c.post<Plan>("testplan/plans", body, API);
  emit(ctx, v, { id: made.id, name }, `${trace.dryRun ? "dry-run: would create" : "created"} test plan '${name}'${made.id ? ` (#${made.id})` : ""}`);
}

export async function deletePlan(c: AdoClient, ctx: Ctx, v: Flags, planRef: string): Promise<void> {
  const p = await findPlan(c, planRef);
  confirmDelete(v, `test plan '${p.name}'`);
  await c.del(`testplan/plans/${p.id}`, API);
  emit(ctx, v, { id: p.id, deleted: !trace.dryRun }, `${trace.dryRun ? "dry-run: would delete" : "deleted"} test plan '${p.name}'`);
}

export async function createSuite(c: AdoClient, ctx: Ctx, v: Flags, planRef: string): Promise<void> {
  const p = await findPlan(c, planRef);
  const name = typeof v.name === "string" ? v.name : "";
  if (!name) throw new AihubError("aihub testplan create-suite needs --name (and --parent <suite id>, default the plan's root suite)");
  const parent = typeof v.parent === "string" ? Number(v.parent) : p.rootSuite?.id;
  const made = await c.post<Suite>(`testplan/Plans/${p.id}/suites`, { suiteType: "staticTestSuite", name, parentSuite: { id: parent } }, API);
  emit(ctx, v, { id: made.id, name, plan: p.name }, `${trace.dryRun ? "dry-run: would create" : "created"} suite '${name}' in '${p.name}'${made.id ? ` (#${made.id})` : ""}`);
}

export async function deleteSuite(c: AdoClient, ctx: Ctx, v: Flags, planRef: string, suite: number): Promise<void> {
  const p = await findPlan(c, planRef);
  confirmDelete(v, `test suite #${suite}`);
  await c.del(`testplan/Plans/${p.id}/suites/${suite}`, API);
  emit(ctx, v, { plan: p.name, suite, deleted: !trace.dryRun }, `${trace.dryRun ? "dry-run: would delete" : "deleted"} suite #${suite} of '${p.name}'`);
}

/** A test case is a work item: create it, then put it into the suite. */
export async function createCase(c: AdoClient, ctx: Ctx, v: Flags, planRef: string, suite: number): Promise<void> {
  const p = await findPlan(c, planRef);
  const title = typeof v.title === "string" ? v.title : "";
  if (!title) throw new AihubError("aihub testplan create-case needs --title (steps: --steps <text>)");
  const ops: any[] = [{ op: "add", path: "/fields/System.Title", value: title }];
  if (typeof v.steps === "string") ops.push({ op: "add", path: "/fields/System.Description", value: v.steps });
  const wi = await c.jsonPatch<{ id?: number }>("POST", "wit/workitems/$Test%20Case", ops);
  await c.post(`testplan/Plans/${p.id}/Suites/${suite}/TestCase`, [{ workItem: { id: wi.id ?? 0 } }], API);
  emit(ctx, v, { id: wi.id, title, suite }, `${trace.dryRun ? "dry-run: would create" : "created"} test case${wi.id ? ` AB#${wi.id}` : ""} '${title}' in suite #${suite}`);
}

// ---- test runs and results ------------------------------------------------------------------------------------------

export async function runs(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const q: Record<string, string | number> = { $top: top(v, 20), "api-version": "7.1" };
  if (typeof v.build === "string") q.buildUri = `vstfs:///Build/Build/${v.build}`;
  const r = await c.get<{ value?: { id: number; name: string; state?: string; totalTests?: number; passedTests?: number; completedDate?: string }[] }>("test/runs", q);
  const rows = (r.value ?? []).map((x) => ({ id: x.id, name: x.name, state: x.state, total: x.totalTests, passed: x.passedTests, date: day(x.completedDate) }));
  emit(ctx, v, rows, rows.length ? table([["run", "name", "state", "passed/total", "date"], ...rows.map((x) => [String(x.id), cut(x.name, 40), x.state ?? "", `${x.passed ?? 0}/${x.total ?? 0}`, x.date])]) : "no test runs match");
}

export async function results(c: AdoClient, ctx: Ctx, v: Flags, run: number): Promise<void> {
  const r = await c.get<{ value?: { id: number; testCaseTitle?: string; automatedTestName?: string; outcome?: string; errorMessage?: string; durationInMs?: number }[] }>(`test/runs/${run}/results`, { outcomes: typeof v.outcome === "string" ? v.outcome : "Failed", $top: top(v, 100), "api-version": "7.1" });
  const rows = (r.value ?? []).map((x) => ({ test: x.automatedTestName ?? x.testCaseTitle, outcome: x.outcome, message: cut(x.errorMessage, 200) }));
  emit(ctx, v, rows, rows.length ? rows.map((x) => `${x.outcome} ${x.test}${x.message ? `\n    ${x.message}` : ""}`).join("\n") : `run ${run} has no ${typeof v.outcome === "string" ? v.outcome : "failed"} results`);
}
