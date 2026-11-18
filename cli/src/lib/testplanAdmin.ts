import type { AdoClient } from "./ado.js";
import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { cut, day, emit, encode, requireFlag, table, top, type Flags } from "./devops.js";

/**
 * `aihub testplan ...`: Azure DevOps Test Plans. Reads: plans, suites (tree), test cases, test points and their outcome,
 * test runs and results of a build (failed first). Writes (all with --dry-run): create-plan, create-suite, create-case, outcome.
 */
export const TESTPLAN_USAGE =
  "aihub testplan plans | suites --plan P | cases --plan P --suite S | points --plan P --suite S | outcome --plan P --suite S --point N --to passed|failed|blocked|notapplicable|active | " +
  "runs [--build N] | results --run N [--all] | create-plan --name N [--area A --iteration I] | create-suite --plan P --name N [--parent S] | create-case --plan P --suite S --title T [--steps-file f]";

const need = (v: Flags, key: string, hint: string): number => {
  const n = Number(requireFlag(v, key, hint));
  if (!Number.isInteger(n) || n <= 0) throw new AihubError(`--${key} must be a number`);
  return n;
};

interface Plan {
  id: number;
  name: string;
  state?: string;
  startDate?: string;
  endDate?: string;
  rootSuite?: { id: number };
  areaPath?: string;
  iteration?: string;
}
interface Suite {
  id: number;
  name: string;
  suiteType?: string;
  parentSuite?: { id?: number };
  children?: Suite[];
  hasChildren?: boolean;
}

export async function plans(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const list = await c.list<Plan>("testplan/plans", { includePlanDetails: false });
  const f = typeof v.filter === "string" ? v.filter.toLowerCase() : "";
  const rows = list.filter((p) => !f || p.name.toLowerCase().includes(f)).slice(0, top(v, 50));
  emit(ctx, v, rows.map((p) => ({ id: p.id, name: p.name, state: p.state, rootSuite: p.rootSuite?.id })), rows.length ? table([["plan", "state", "root suite", "name"], ...rows.map((p) => [String(p.id), p.state ?? "", String(p.rootSuite?.id ?? ""), cut(p.name, 60)])]) : "this project has no test plans");
}

export async function suites(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const plan = need(v, "plan", "test plan id");
  const all = await c.list<Suite>(`testplan/Plans/${plan}/suites`, { asTreeView: true });
  const lines: string[] = [];
  const flat: { id: number; name: string; type?: string; depth: number }[] = [];
  const walk = (s: Suite, d: number) => {
    lines.push(`${"  ".repeat(d)}${s.name} (${s.id}${s.suiteType ? `, ${s.suiteType}` : ""})`);
    flat.push({ id: s.id, name: s.name, type: s.suiteType, depth: d });
    (s.children ?? []).forEach((x) => walk(x, d + 1));
  };
  all.forEach((s) => walk(s, 0));
  // a flat answer (no tree view) is listed as it came
  emit(ctx, v, flat, lines.length ? lines.slice(0, top(v, 200)).join("\n") : `plan ${plan} has no suites`);
}

export async function cases(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const plan = need(v, "plan", "test plan id");
  const suite = need(v, "suite", "suite id");
  const list = await c.list<{ workItem?: { id?: number; name?: string; workItemFields?: Record<string, unknown>[] }; order?: number }>(`testplan/Plans/${plan}/Suites/${suite}/TestCase`);
  const rows = list.map((x) => ({ id: x.workItem?.id, title: x.workItem?.name ?? "" }));
  emit(ctx, v, rows, rows.length ? table([["case", "title"], ...rows.slice(0, top(v, 100)).map((r) => [String(r.id), cut(r.title, 80)])]) : `suite ${suite} has no test cases`);
}

interface Point {
  id: number;
  results?: { outcome?: string; lastResultDetails?: { dateCompleted?: string; runBy?: { displayName?: string } } };
  testCaseReference?: { id?: number; name?: string };
  tester?: { displayName?: string };
  configuration?: { name?: string };
}

export async function points(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const plan = need(v, "plan", "test plan id");
  const suite = need(v, "suite", "suite id");
  const list = await c.list<Point>(`testplan/Plans/${plan}/Suites/${suite}/TestPoint`);
  const rows = list.map((p) => ({ id: p.id, case: p.testCaseReference?.id, title: p.testCaseReference?.name ?? "", outcome: p.results?.outcome ?? "unspecified", tester: p.tester?.displayName ?? "", config: p.configuration?.name ?? "" }));
  const counts = rows.reduce<Record<string, number>>((a, r) => ((a[r.outcome.toLowerCase()] = (a[r.outcome.toLowerCase()] ?? 0) + 1), a), {});
  emit(ctx, v, { suite, counts, points: rows }, rows.length ? [`suite ${suite}: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ")}`, table([["point", "case", "outcome", "tester", "title"], ...rows.slice(0, top(v, 100)).map((r) => [String(r.id), String(r.case ?? ""), r.outcome, r.tester, cut(r.title, 60)])])].join("\n") : `suite ${suite} has no test points`);
}

const OUTCOMES: Record<string, string> = { passed: "Passed", failed: "Failed", blocked: "Blocked", notapplicable: "NotApplicable", active: "Active", unspecified: "Unspecified" };

export async function outcome(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const plan = need(v, "plan", "test plan id");
  const suite = need(v, "suite", "suite id");
  const point = need(v, "point", "test point id from `testplan points`");
  const to = OUTCOMES[String(requireFlag(v, "to", Object.keys(OUTCOMES).join("|")).toLowerCase())];
  if (!to) throw new AihubError(`--to must be one of ${Object.keys(OUTCOMES).join(", ")}`);
  await c.patch(`test/Plans/${plan}/Suites/${suite}/points/${point}`, { outcome: to });
  emit(ctx, v, { plan, suite, point, outcome: to }, `test point ${point} (suite ${suite}) set to ${to}`);
}

interface Run {
  id: number;
  name?: string;
  state?: string;
  totalTests?: number;
  passedTests?: number;
  unanalyzedTests?: number;
  startedDate?: string;
  completedDate?: string;
  build?: { id?: string };
}

export async function runs(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const build = typeof v.build === "string" ? Number(v.build) : undefined;
  if (typeof v.build === "string" && !(build && build > 0)) throw new AihubError("--build must be a build id");
  const list = (await c.get<{ value?: Run[] }>("test/runs", { ...(build ? { buildUri: `vstfs:///Build/Build/${build}` } : {}), $top: top(v, 20) })).value ?? [];
  const rows = list.map((r) => ({ id: r.id, name: r.name ?? "", state: r.state ?? "", total: r.totalTests ?? 0, passed: r.passedTests ?? 0, failed: (r.totalTests ?? 0) - (r.passedTests ?? 0), at: r.completedDate ?? r.startedDate }));
  emit(ctx, v, rows, rows.length ? table([["run", "when", "passed", "failed", "name"], ...rows.map((r) => [String(r.id), day(r.at), `${r.passed}/${r.total}`, String(r.failed), cut(r.name, 60)])]) : build ? `build ${build} published no test runs` : "no test runs");
}

export async function results(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const run = need(v, "run", "test run id");
  const list = (await c.get<{ value?: { id: number; outcome?: string; testCaseTitle?: string; automatedTestName?: string; errorMessage?: string; durationInMs?: number }[] }>(`test/runs/${run}/results`, { $top: 1000 })).value ?? [];
  const rank = (o?: string) => (o === "Failed" ? 0 : o === "Aborted" ? 1 : o === "NotExecuted" ? 2 : 3);
  const sorted = [...list].sort((a, b) => rank(a.outcome) - rank(b.outcome));
  const shown = (v.all ? sorted : sorted.filter((r) => r.outcome !== "Passed")).slice(0, top(v, 50));
  const counts = list.reduce<Record<string, number>>((a, r) => ((a[r.outcome ?? "?"] = (a[r.outcome ?? "?"] ?? 0) + 1), a), {});
  emit(ctx, v, { run, counts, results: shown }, [`run ${run}: ${Object.entries(counts).map(([k, n]) => `${n} ${k.toLowerCase()}`).join(", ") || "no results"}`, ...shown.map((r) => `  ${r.outcome}: ${cut(r.testCaseTitle ?? r.automatedTestName, 80)}${r.errorMessage ? ` - ${cut(r.errorMessage, 140)}` : ""}`)].join("\n"));
}

export async function createPlan(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const body: Record<string, unknown> = { name: requireFlag(v, "name") };
  if (typeof v.area === "string") body.areaPath = v.area;
  if (typeof v.iteration === "string") body.iteration = v.iteration;
  const r = await c.post<Plan>("testplan/plans", body);
  emit(ctx, v, { id: r.id, name: body.name, rootSuite: r.rootSuite?.id }, `test plan '${body.name}' created${r.id ? ` (${r.id}, root suite ${r.rootSuite?.id})` : ""}`);
}

export async function createSuite(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const plan = need(v, "plan", "test plan id");
  let parent = typeof v.parent === "string" ? Number(v.parent) : undefined;
  if (!parent) parent = (await c.get<Plan>(`testplan/plans/${plan}`)).rootSuite?.id;
  if (!parent) throw new AihubError(`could not find the root suite of plan ${plan}; pass --parent <suite id>`);
  const name = requireFlag(v, "name");
  const r = await c.post<Suite>(`testplan/Plans/${plan}/suites`, { suiteType: "staticTestSuite", name, parentSuite: { id: parent } });
  emit(ctx, v, { plan, id: r.id, name, parent }, `suite '${name}' created in plan ${plan}${r.id ? ` (${r.id})` : ""}`);
}

export async function createCase(c: AdoClient, ctx: Ctx, v: Flags): Promise<void> {
  const plan = need(v, "plan", "test plan id");
  const suite = need(v, "suite", "suite id");
  const title = requireFlag(v, "title");
  const ops: unknown[] = [{ op: "add", path: "/fields/System.Title", value: title }];
  const wi = await c.jsonPatch<{ id?: number }>("POST", `wit/workitems/$${encode("Test Case")}`, ops);
  const id = wi.id;
  if (id) await c.post(`testplan/Plans/${plan}/Suites/${suite}/TestCase`, [{ workItem: { id } }]);
  emit(ctx, v, { id, plan, suite, title }, `test case ${id ?? "(dry-run)"} '${title}' created and added to suite ${suite}`);
}
