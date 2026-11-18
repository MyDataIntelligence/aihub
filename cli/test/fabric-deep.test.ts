import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { branchLabel, branchWorkspace, classifyError, codeRefusals, errorsOnly, failedCell, normalizedName, parseSqlHost, searchLines, sparkStage, sqlGuard, stagesSummary, tailLines } from "../src/lib/fabric-diag.js";
import { buildTestPlan, testStrategy } from "../src/lib/fabric-testplan.js";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, sh, tmp, write, type Route } from "./helpers.js";

const WS = "11111111-1111-1111-1111-111111111111";
const ACC = "33333333-3333-3333-3333-333333333333";
const TEAM = `version: 1
repositories:
  - name: test-repo
    defaultTarget: main
fabric:
  branchWorkspacePrefixes: [team data]
  workspaces:
    - { name: DEV-test-project, id: ${WS}, environment: dev }
    - { name: ACC-test-project, id: ${ACC}, environment: acc }
  workspaceGroups:
    devs: { workspaces: [DEV-test-project], servicePrincipal: ci }
`;
const ENV = { AIHUB_FABRIC_TOKEN: "ft", AIHUB_ONELAKE_TOKEN: "ot", AIHUB_POWERBI_TOKEN: "pt", AIHUB_SQL_TOKEN: "sqltok", AIHUB_KUSTO_TOKEN: "kt", AIHUB_POLL_MS: "0" };

function repo(files: Record<string, string> = {}): string {
  const { dir } = makeRepo();
  write(dir, ".agents/skills/_shared/references/team.yaml", TEAM);
  for (const [f, c] of Object.entries(files)) write(dir, f, c);
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "team"]);
  return dir;
}
function go(routes: Route[], args: string[], o: { dir?: string; setup?: (c: any) => void; env?: Record<string, string> } = {}) {
  const f = fakeFetch(routes);
  const { ctx, lines, errs } = ctxFor(o.dir ?? repo(), f.fn);
  ctx.env = { ...ctx.env, ...ENV, ...(o.env ?? {}) };
  o.setup?.(ctx);
  return main(["fabric", ...args], ctx).then((code) => {
    if (process.env.DBG && !lines.length && errs.length) console.log("ERR", args.join(" "), errs);
    return { code, out: lines.join(String.fromCharCode(10)), errs, calls: f.calls };
  });
}
const get = (re: RegExp, body: unknown, extra: Record<string, unknown> = {}): Route => ({ match: re, respond: () => ({ body, ...extra }) as any });
const send = (method: string, re: RegExp, body: unknown = {}, extra: Record<string, unknown> = {}): Route => ({ method, match: re, respond: () => ({ body, ...extra }) as any });
const text = (re: RegExp, t: string): Route => ({ match: re, respond: () => ({ text: t }) });

const ITEMS = [
  { id: "nb-1", displayName: "nb_load", type: "Notebook" },
  { id: "pl-1", displayName: "pl_main", type: "DataPipeline" },
  { id: "lh-1", displayName: "lh_test", type: "Lakehouse" },
  { id: "wh-1", displayName: "wh_test", type: "Warehouse" },
  { id: "udf-1", displayName: "udf_calc", type: "UserDataFunction" },
  { id: "nbt-1", displayName: "AIHub E2E smoke", type: "Notebook" },
];
const items = get(new RegExp(`/workspaces/${WS}/items$`), { value: ITEMS });
const itemsOfType = (type: string): Route => get(new RegExp(`/workspaces/${WS}/items\\?type=${type}$`), { value: ITEMS.filter((i) => i.type === type) });

describe("diagnostics helpers", () => {
  const log = "INFO start\n2026-03-01 10:00:00 ERROR boom\n  at x\nINFO ok\nTraceback (most recent call last):\n  File a\nValueError: bad";
  it("log window: tail, search with context, errors only, failed cell", () => {
    expect(tailLines("a\nb\nc\n", 2)).toBe("b\nc");
    expect(() => tailLines("a", 0)).toThrow(/between 1/);
    const r = searchLines("a\nb\nmatch\nc\nd\nmatch2", "match", 1);
    expect(r.matches.map((m) => m.line)).toEqual([3, 6]);
    expect(r.matches[0].text).toBe("b\nmatch\nc");
    expect(() => searchLines("a", "(", 0)).toThrow(/valid regex/);
    expect(errorsOnly(log)).toContain("ERROR boom");
    expect(errorsOnly(log)).not.toContain("INFO ok");
    expect(errorsOnly(log)).toContain("ValueError: bad");
    const cell = failedCell("---\nCell In[8], line 3\n----> 3 df.select('x')\nAnalysisException: cannot resolve x\nmore");
    expect(cell).toMatchObject({ cell: 8, line: 3, code: "df.select('x')", exception: "AnalysisException: cannot resolve x" });
    expect(failedCell("nothing")).toBeUndefined();
  });
  it("classifies errors with a hint", () => {
    expect(classifyError("java.lang.OutOfMemoryError: Java heap space").kind).toBe("out-of-memory");
    expect(classifyError("ModuleNotFoundError: No module named 'x'").kind).toBe("missing-library");
    expect(classifyError("[UNRESOLVED_COLUMN] cannot resolve").kind).toBe("missing-column");
    expect(classifyError("HTTP 430 TooManyRequestsForCapacity").kind).toBe("capacity");
    expect(classifyError("qqq").kind).toBe("unknown");
  });
  it("finds the workspace of a branch by normalised name, ambiguity gives nothing", () => {
    expect(branchLabel("refs/heads/feature/12-export")).toBe("12-export");
    expect(normalizedName("Team_Data 12-Export")).toBe("teamdata12export");
    const ws = [{ displayName: "Team Data 12 Export" }, { displayName: "Other" }];
    expect(branchWorkspace(ws, "feature/12-export", ["team data"], (w) => w.displayName)?.displayName).toBe("Team Data 12 Export");
    expect(branchWorkspace([...ws, { displayName: "team-data-12-export" }], "feature/12-export", ["team data"], (w) => w.displayName)).toBeUndefined();
  });
  it("refuses code that points at ACC/PRD or unseen workspaces", () => {
    const visible = [{ id: WS, displayName: "DEV-test-project" }, { id: ACC, displayName: "ACC-test-project" }];
    const own = { id: WS, name: "DEV-test-project" };
    expect(codeRefusals("select * from t", own, visible)).toEqual([]);
    expect(codeRefusals(`spark.read.load("abfss://${ACC}@onelake.dfs.fabric.microsoft.com/x")`, own, visible)[0]).toMatch(/ACC/);
    expect(codeRefusals(`abfss://PRD-sales@onelake.dfs.fabric.microsoft.com/x`, own, visible)[0]).toMatch(/ACC or PRD/);
    expect(codeRefusals(`abfss://Ghost@onelake.dfs.fabric.microsoft.com/x`, own, visible)[0]).toMatch(/not visible/);
    expect(codeRefusals(`id = "${ACC}"`, own, visible)[0]).toMatch(/ACC and PRD are never a destination/);
    expect(codeRefusals(`abfss://DEV-test-project@onelake.dfs.fabric.microsoft.com/x`, own, visible)).toEqual([]);
  });
  it("SQL guard accepts one SELECT/WITH and refuses everything else", () => {
    expect(sqlGuard("select 1;")).toBe("select 1");
    expect(sqlGuard("with a as (select [delete] from t where x = 'drop') select * from a -- insert")).toContain("with a");
    for (const bad of ["delete from t", "select 1; select 2", "select * into x from t", "exec sp_x", "select 1 /* open", "with a as (select 1) update t set a=1", "select 'open"]) expect(() => sqlGuard(bad)).toThrow(/Refused|longer|needs/);
    expect(() => sqlGuard("")).toThrow(/needs --query/);
    expect(parseSqlHost("tcp:abc.datawarehouse.fabric.microsoft.com,1433")).toEqual({ host: "abc.datawarehouse.fabric.microsoft.com", port: 1433 });
    expect(parseSqlHost("Data Source=x.pbidedicated.windows.net;Initial Catalog=d").host).toBe("x.pbidedicated.windows.net");
    expect(() => parseSqlHost("evil.example.com")).toThrow(/only \*\.fabric/);
  });
  it("shapes Spark stages and ranks failed ones first", () => {
    const stages = [{ stageId: 1, status: "COMPLETE", executorRunTime: 9000 }, { stageId: 2, status: "FAILED", numFailedTasks: 3, executorRunTime: 100, failureReason: "Job aborted\nstack" }];
    expect(stagesSummary(stages)[0]).toMatch(/^stage 2: FAILED, 3 failed task/);
    expect(sparkStage({ stageId: 1, details: "long", status: "x" }, false).details).toBeUndefined();
  });
});

describe("test plan and strategy", () => {
  const PL = (logical: string) => JSON.stringify({ properties: { activities: [{ name: "RunLoad", type: "TridentNotebook", typeProperties: { notebookId: logical } }] } });
  const files: Record<string, string> = {
    "fabric/lh_core.Lakehouse/.platform": JSON.stringify({ metadata: { type: "Lakehouse", displayName: "lh_core" }, config: { logicalId: "aaaa1111-0000-0000-0000-000000000001" } }),
    "fabric/nb_load.Notebook/.platform": JSON.stringify({ metadata: { type: "Notebook", displayName: "nb_load" }, config: { logicalId: "bbbb2222-0000-0000-0000-000000000002" } }),
    "fabric/nb_load.Notebook/notebook-content.py": "# uses lakehouse aaaa1111-0000-0000-0000-000000000001\n",
    "fabric/pl_main.DataPipeline/.platform": JSON.stringify({ metadata: { type: "DataPipeline", displayName: "pl_main" }, config: { logicalId: "cccc3333-0000-0000-0000-000000000003" } }),
    "fabric/pl_main.DataPipeline/pipeline-content.json": PL("bbbb2222-0000-0000-0000-000000000002"),
    "fabric/udf_calc.UserDataFunction/.platform": JSON.stringify({ metadata: { type: "UserDataFunction", displayName: "udf_calc" }, config: { logicalId: "dddd4444-0000-0000-0000-000000000004" } }),
    "fabric/udf_calc.UserDataFunction/function_app.py": "@udf.function()\ndef add(a: int, b: int) -> int:\n    return a + b\n",
    "dbt/dbt_project.yml": "name: shop\nmodel-paths: [models]\n",
    "dbt/models/m.sql": "select 1",
    "fabric/dbt_job.DataBuildToolJob/.platform": JSON.stringify({ metadata: { type: "DataBuildToolJob", displayName: "dbt_job" } }),
  };
  it("adds the callers of a changed item and orders referenced before caller", () => {
    const dir = tmp();
    for (const [f, c] of Object.entries(files)) write(dir, f, c);
    const plan = buildTestPlan(dir, Object.keys(files), ["fabric/lh_core.Lakehouse/.platform"]);
    expect(plan.steps.map((s) => `${s.item.type}:${s.item.name}${s.via ? `<-${s.via.name}` : ""}`)).toEqual(["Lakehouse:lh_core", "Notebook:nb_load<-lh_core", "DataPipeline:pl_main<-nb_load"]);
    expect(plan.steps[2].activity).toBe("RunLoad");
    const udf = buildTestPlan(dir, Object.keys(files), ["fabric/udf_calc.UserDataFunction/function_app.py"]);
    expect(udf.steps[0].functions).toEqual([{ name: "add", params: "a: int, b: int" }]);
    const dbt = buildTestPlan(dir, Object.keys(files), ["dbt/models/m.sql"]);
    expect(dbt.dbtModels).toEqual(["dbt/models/m.sql"]);
    expect(dbt.steps.map((s) => s.item.name)).toContain("dbt_job");
  });
  it("routes repositories by team.yaml and gates TEST on an exact deployed commit", () => {
    const cfg = { integrationRepositories: ["Team Data"], robotGatedRepositories: ["orchestration"] };
    expect(testStrategy("team_data", "dev", cfg).strategy).toBe("azure-devops-integration");
    expect(testStrategy("shop", "dev", cfg).strategy).toBe("fabric-api");
    expect(testStrategy("orchestration", "test", cfg).executable).toBe(false);
    expect(testStrategy("orchestration", "test", cfg, "abc", "ABC").strategy).toBe("robot-integration");
    expect(testStrategy("shop", "test", cfg).strategy).toBe("fabric-api");
  });
  it("fabric plan shows callers, UDF functions and dbt models", async () => {
    const dir = repo();
    sh(dir, ["push", "origin", "main"]);
    sh(dir, ["checkout", "-b", "feature/1-x"]);
    for (const [f, c] of Object.entries(files)) write(dir, f, c);
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "items"]);
    sh(dir, ["checkout", "-q", "main"]);
    write(dir, "x.txt", "x");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "base"]);
    sh(dir, ["checkout", "-q", "feature/1-x"]);
    const r = await go([], ["plan", "--workspace", "DEV-test-project"], { dir });
    expect(r.out).toContain("Notebook nb_load");
    expect(r.out).toContain("functions: add(a: int, b: int)");
  });
});

describe("spark monitoring", () => {
  const sessions = get(/notebooks\/nb-1\/livySessions$/, { value: [{ livyId: "L1", sparkApplicationId: "application_1_0001", state: "Failed", jobInstanceId: "job-1", itemName: "nb_load" }] });
  const appBase = /notebooks\/nb-1\/livySessions\/L1\/applications\/application_1_0001\//;
  it("lists sessions of a workspace and of an item", async () => {
    const a = await go([get(new RegExp(`/workspaces/${WS}/spark/livySessions$`), { value: [{ livyId: "L9", state: "Idle", itemName: "nb_x" }] })], ["spark", "sessions", "--workspace", "DEV-test-project"]);
    expect(a.out).toContain("L9 | Idle | nb_x");
    const b = await go([items, sessions], ["spark", "sessions", "--workspace", "DEV-test-project", "--item", "nb_load", "--state", "failed"]);
    expect(b.out).toContain("L1 | Failed | nb_load | application_1_0001 | job-1");
  });
  it("app views: failed stages first, tasks with the executor error, executors with container ids, SQL", async () => {
    const r = [
      items,
      sessions,
      get(new RegExp(appBase.source + "1/stages\\?status=failed$"), [{ stageId: 7, status: "FAILED", numFailedTasks: 2, executorRunTime: 5000, failureReason: "Job aborted" }]),
      get(new RegExp(appBase.source + "1/stages/7/0/taskList"), [{ taskId: 1, status: "FAILED", executorId: "3", errorMessage: "java.lang.OutOfMemoryError" }]),
      get(new RegExp(appBase.source + "1/allexecutors$"), [{ id: "1", isActive: false, failedTasks: 2, attributes: { CONTAINER_ID: "container_1" } }]),
      get(new RegExp(appBase.source + "1/sql\\?"), [{ id: 0, status: "COMPLETED", description: "q", nodes: [1, 2] }]),
    ];
    const stages = await go(r, ["spark", "app", "--workspace", "DEV-test-project", "--item", "nb_load", "--job", "job-1", "--view", "stages", "--status", "failed"]);
    expect(stages.out).toContain("stage 7: FAILED, 2 failed task(s)");
    const tasks = await go(r, ["spark", "app", "--workspace", "DEV-test-project", "--item", "nb_load", "--livy", "L1", "--view", "tasks", "--stage", "7"]);
    expect(tasks.out).toContain("OutOfMemoryError");
    const ex = await go(r, ["spark", "app", "--workspace", "DEV-test-project", "--item", "nb_load", "--livy", "L1", "--view", "executors"]);
    expect(ex.out).toContain("container_1");
    const sql = await go(r, ["spark", "app", "--workspace", "DEV-test-project", "--item", "nb_load", "--livy", "L1", "--view", "sql"]);
    expect(sql.out).toContain('"nodes": 2');
    const bad = await go(r, ["spark", "app", "--workspace", "DEV-test-project", "--item", "nb_load", "--livy", "L1", "--view", "nope"]);
    expect(bad.errs[0]).toContain("--view must be one of");
    const none = await go(r, ["spark", "app", "--workspace", "DEV-test-project", "--item", "nb_load", "--livy", "ZZ"]);
    expect(none.errs[0]).toContain("no Spark session with id ZZ");
  });
  it("logs: driver stderr with the documented URL, tail, search, errors, failed cell and the likely cause", async () => {
    const stderr = "INFO a\n2026-03-01 10:00:00 ERROR boom\nTraceback (most recent call last):\nOutOfMemoryError: Java heap space";
    const stdout = "x\nCell In[4], line 2\n----> 2 collect()\nMemoryError: no";
    const routes = [items, sessions, text(/logs\?type=driver&fileName=stderr$/, stderr), text(/logs\?type=driver&fileName=stdout$/, stdout), text(/applications\/none\/logs\?type=livy$/, "livy line")];
    const base = ["spark", "logs", "--workspace", "DEV-test-project", "--item", "nb_load", "--job", "job-1"];
    const a = await go(routes, base);
    expect(a.out).toContain("likely cause: out-of-memory");
    expect(a.calls.some((c) => c.url.endsWith("/livySessions/L1/applications/application_1_0001/logs?type=driver&fileName=stderr"))).toBe(true);
    expect((await go(routes, [...base, "--tail", "1"])).out).toContain("OutOfMemoryError");
    expect((await go(routes, [...base, "--search", "boom", "--context", "0"])).out).toContain("1 match(es)");
    expect((await go(routes, [...base, "--errors"])).out).not.toContain("INFO a");
    const cell = await go(routes, [...base, "--file", "stdout", "--cell"]);
    expect(cell.out).toContain("failed cell 4, line 2: collect()");
    expect((await go(routes, [...base, "--log-type", "livy"])).out).toContain("livy line");
    expect(a.calls.find((c) => c.url.includes("type=driver"))!.headers.Authorization).toBe("Bearer ft");
  });
});

describe("livy run", () => {
  const sessionBase = new RegExp(`/workspaces/${WS}/lakehouses/lh-1/livyapi/versions/2023-12-01/sessions`);
  function routes(opts: { stmt?: any; state?: string } = {}): Route[] {
    return [
      items,
      get(new RegExp(`/v1/workspaces$`), { value: [{ id: WS, displayName: "DEV-test-project" }, { id: ACC, displayName: "ACC-test-project" }] }),
      send("POST", new RegExp(sessionBase.source + "$"), { id: "S1" }),
      get(new RegExp(sessionBase.source + "/S1$"), { state: opts.state ?? "idle" }),
      send("POST", new RegExp(sessionBase.source + "/S1/statements$"), { id: 0 }),
      get(new RegExp(sessionBase.source + "/S1/statements/0$"), opts.stmt ?? { state: "available", output: { status: "ok", data: { "application/json": { schema: { fields: [{ name: "n", type: "long" }] }, data: [[1], [2], [3]] } } } }),
      send("DELETE", new RegExp(sessionBase.source + "/S1$")),
    ];
  }
  const args = ["livy", "run", "--workspace", "DEV-test-project", "--lakehouse", "lh_test", "--code", "select n from t"];
  it("runs a statement, returns the table and always closes the session", async () => {
    const r = await go(routes(), [...args, "--top", "2", "--json"]);
    const j = JSON.parse(r.out).result;
    expect(j).toMatchObject({ status: "ok", rowCount: 2, truncated: true, sessionClosed: true });
    expect(r.calls.at(-1)!.method).toBe("DELETE");
  });
  it("a failing statement exits 1 with the redacted error, still closes the session", async () => {
    const r = await go(routes({ stmt: { state: "available", output: { status: "error", ename: "AnalysisException", evalue: "bad token=abcdefgh", traceback: [] } } }), args);
    expect(r.code).toBe(1);
    expect(r.out).toContain("AnalysisException");
    expect(r.out).not.toContain("abcdefgh");
    expect(r.calls.at(-1)!.method).toBe("DELETE");
  });
  it("a dead session is reported and closed; ACC code and ACC workspaces are refused; dry-run runs nothing", async () => {
    const dead = await go(routes({ state: "dead" }), args);
    expect(dead.errs[0]).toContain("ended as 'dead'");
    expect(dead.calls.at(-1)!.method).toBe("DELETE");
    const acc = await go(routes(), ["livy", "run", "--workspace", "DEV-test-project", "--lakehouse", "lh_test", "--code", `spark.read.load("abfss://${ACC}@onelake.dfs.fabric.microsoft.com/Tables/t")`]);
    expect(acc.errs[0]).toContain("Blocked before the run");
    expect(acc.calls.some((c) => c.method === "POST")).toBe(false);
    const ws = await go(routes(), ["livy", "run", "--workspace", "ACC-test-project", "--lakehouse", "x", "--code", "select 1"]);
    expect(ws.errs[0]).toContain("is ACC");
    const dry = await go(routes(), [...args, "--dry-run"]);
    expect(dry.calls.some((c) => c.method === "POST")).toBe(false);
    expect((await go(routes(), ["livy", "run", "--workspace", "DEV-test-project", "--lakehouse", "lh_test", "--code", "x", "--kind", "scala"])).errs[0]).toContain("sql or pyspark");
  });
});

describe("failures: root cause chain", () => {
  const PL_RUN = "pjob-1";
  const CHILD = "22222222-aaaa-bbbb-cccc-000000000001";
  const NB = "99999999-aaaa-bbbb-cccc-000000000009";
  const NB_RUN = "88888888-aaaa-bbbb-cccc-000000000008";
  const routes = [
    get(/\/v1\/workspaces$/, { value: [{ id: WS, displayName: "Team Data 12 Export" }] }),
    get(new RegExp(`/workspaces/${WS}/items$`), { value: ITEMS }),
    get(/items\/nb-1\/jobs\/instances$/, { value: [{ id: "ok1", status: "Completed", startTimeUtc: "2026-03-01T08:00:00Z" }] }),
    get(/items\/pl-1\/jobs\/instances$/, { value: [{ id: PL_RUN, status: "Failed", startTimeUtc: "2026-03-01T09:00:00Z", endTimeUtc: "2026-03-01T09:05:00Z", failureReason: { errorCode: "ActivityFailed", message: "Activity ExecuteChild failed" } }, { id: "act", status: "InProgress", startTimeUtc: "2026-03-01T09:10:00Z" }] }),
    send("POST", new RegExp(`pipelineruns/${PL_RUN}/queryactivityruns$`), [{ activityName: "ExecuteChild", activityType: "ExecutePipeline", status: "Failed", error: { errorCode: "ChildFailed", message: "child failed" }, output: { pipelineRunId: CHILD } }]),
    send("POST", new RegExp(`pipelineruns/${CHILD}/queryactivityruns$`), [{ activityName: "RunNb", activityType: "TridentNotebook", status: "Failed", activityRunStart: "2026-03-01T09:01:00Z", error: { errorCode: "NotebookFailed", message: "notebook failed" }, input: { notebookId: NB, workspaceId: WS }, output: { runId: NB_RUN } }]),
    get(new RegExp(`notebooks/${NB}/livySessions$`), { value: [{ livyId: "LS", jobInstanceId: NB_RUN, sparkApplicationId: "application_9_0001", state: "Failed" }] }),
    text(/logs\?type=driver&fileName=stderr$/, "INFO x"),
    text(/logs\?type=driver&fileName=stdout$/, "Cell In[3], line 1\n----> 1 spark.table('gone')\nAnalysisException: Table or view not found: gone"),
  ];
  it("follows pipeline -> child pipeline -> notebook -> Spark driver log and names the cause", async () => {
    const r = await go(routes, ["failures", "--branch", "feature/12-export"], { setup: (c) => (c.env.AIHUB_HOME = tmp()) });
    expect(r.code).toBe(0);
    expect(r.out).toContain("1 failed and 1 active run(s)");
    const chain = r.out.split("root cause chain")[1];
    expect(chain).toContain("DataPipeline pl_main [Failed]");
    expect(chain).toContain("activity ExecutePipeline ExecuteChild [Failed]: ChildFailed: child failed");
    expect(chain).toContain("activity TridentNotebook RunNb");
    expect(chain).toContain("spark session AIHub".slice(0, 0) + "spark session");
    expect(chain).toContain("cell 3 line 1: spark.table('gone') -> AnalysisException: Table or view not found: gone");
    expect(r.out).toContain("likely cause: missing-table-or-path");
    expect(r.out).toContain("aihub fabric logs --workspace Team Data 12 Export --item pl_main --job pjob-1");
  });
  it("needs a single workspace for the branch", async () => {
    const r = await go([get(/\/v1\/workspaces$/, { value: [{ id: "1", displayName: "x" }] })], ["failures", "--branch", "feature/12-export"]);
    expect(r.errs[0]).toContain("no single workspace named 'team data");
  });
});

describe("sql", () => {
  const routes = [items, get(new RegExp(`/workspaces/${WS}/warehouses/wh-1$`), { properties: { connectionString: "abc.datawarehouse.fabric.microsoft.com" } })];
  it("runs a guarded read-only query with the SQL token and masks secrets in the rows", async () => {
    const seen: any[] = [];
    const sql = async (ep: any, q: string, max: number, to: number, tok: string) => {
      seen.push({ ep, q, max, tok });
      return { columns: ["id", "note"], rows: [[1, "token=abcdefgh1234"], [2, "ok"], [3, "z"]] };
    };
    const r = await go(routes, ["sql", "--workspace", "DEV-test-project", "--item", "wh_test", "--query", "select id, note from t;", "--top", "2"], { setup: (c) => (c.sql = sql) });
    expect(seen[0]).toMatchObject({ ep: { host: "abc.datawarehouse.fabric.microsoft.com", port: 1433, database: "wh_test" }, q: "select id, note from t", max: 2, tok: "sqltok" });
    expect(r.out).toContain("2 row(s) (first 2)");
    expect(r.out).not.toContain("abcdefgh1234");
    expect(r.out).toContain("[read-only]");
  });
  it("refuses writes before any call, foreign hosts, and items without a SQL endpoint", async () => {
    const w = await go(routes, ["sql", "--workspace", "DEV-test-project", "--item", "wh_test", "--query", "drop table t"]);
    expect(w.errs[0]).toContain("Refused");
    expect(w.calls).toHaveLength(0);
    const h = await go([items, get(/warehouses\/wh-1$/, { properties: { connectionString: "evil.example.com" } })], ["sql", "--workspace", "DEV-test-project", "--item", "wh_test", "--query", "select 1"], { setup: (c) => (c.sql = async () => ({ columns: [], rows: [] })) });
    expect(h.errs[0]).toContain("only *.fabric");
    const nb = await go([items], ["sql", "--workspace", "DEV-test-project", "--item", "nb_load", "--query", "select 1"]);
    expect(nb.errs[0]).toContain("no SQL endpoint");
  });
});

describe("connections, udf, notebook tests", () => {
  const SECRET = "kv-secret-value-123";
  it("connection create resolves kv:// references with az and never prints the secret; dry-run masks it", async () => {
    const f = join(tmp(), "c.json");
    writeFileSync(f, JSON.stringify({ displayName: "sql-test", connectivityType: "ShareableCloud", credentialDetails: { credentials: { credentialType: "Basic", username: "u", password: "kv://vault1/pw" } } }));
    const exec = (cmd: string, a: string[]) => (cmd === "az" && a.includes("vault1") ? `${SECRET}\n` : "");
    const ok = await go([send("POST", /\/connections$/, { id: "c1", displayName: "sql-test", credentialDetails: { credentials: { password: SECRET } } })], ["connection", "create", "--body-file", f], { setup: (c) => (c.exec = exec) });
    expect(ok.calls.at(-1)!.body.credentialDetails.credentials.password).toBe(SECRET);
    expect(ok.out).not.toContain(SECRET);
    const dry = await go([], ["connection", "create", "--body-file", f, "--dry-run"], { setup: (c) => (c.exec = exec) });
    expect(dry.out).toContain("<redacted>");
    expect(dry.out).not.toContain("kv://vault1/pw");
    const prd = join(tmp(), "p.json");
    writeFileSync(prd, JSON.stringify({ displayName: "PRD sales" }));
    expect((await go([], ["connection", "create", "--body-file", prd])).errs[0]).toContain("is PRD");
  });
  it("connection delete needs the exact name", async () => {
    const r = [get(/connections\/c1$/, { displayName: "sql-test" }), send("DELETE", /connections\/c1$/)];
    expect((await go(r, ["connection", "delete", "--connection", "c1", "--confirm-name", "wrong"])).errs[0]).toContain("exact connection name 'sql-test'");
    expect((await go(r, ["connection", "delete", "--connection", "c1", "--confirm-name", "sql-test"])).out).toContain("deleted connection sql-test");
  });
  it("udf invoke tries /invoke, then falls back on 404", async () => {
    const ok = await go([items, send("POST", /functions\/add\/invoke$/, { output: 3 })], ["udf", "invoke", "--workspace", "DEV-test-project", "--item", "udf_calc", "--function", "add"]);
    expect(ok.out).toContain("invoked add");
    const fb = await go([items, { method: "POST", match: /functions\/add\/invoke$/, respond: () => ({ status: 404, body: {} }) }, send("POST", /functions\/add$/, { output: 4 })], ["udf", "invoke", "--workspace", "DEV-test-project", "--item", "udf_calc", "--function", "add"]);
    expect(fb.out).toContain('"output": 4');
  });
  it("notebook test: only assert/print lines, only in an 'AIHub E2E' notebook, verified against the prepared run", async () => {
    const env = { AIHUB_HOME: tmp() };
    const base = ["--workspace", "DEV-test-project", "--item", "AIHub E2E smoke"];
    const bad = await go([items], ["notebook-test", "prepare", ...base, "--source", "import os"], { env });
    expect(bad.errs[0]).toContain("only `assert");
    const wrong = await go([items], ["notebook-test", "prepare", "--workspace", "DEV-test-project", "--item", "nb_load", "--source", "assert 1 == 1"], { env });
    expect(wrong.errs[0]).toContain("AIHub E2E");
    const prep = await go([items, send("POST", /updateDefinition$/)], ["notebook-test", "prepare", ...base, "--source", "assert 1 == 1\nprint('ok')"], { env });
    expect(prep.out).toContain("prepared the smoke test");
    const part = prep.calls.at(-1)!.body.definition.parts[0];
    expect(Buffer.from(part.payload, "base64").toString()).toContain("assert 1 == 1");
    const run = await go([items, send("POST", /jobs\/instances\?jobType=RunNotebook$/, {}, { status: 202, headers: { location: "https://x/v1/workspaces/w/items/nbt-1/jobs/instances/run-7" } })], ["notebook-test", "run", ...base], { env });
    expect(run.out).toContain("job run-7");
    const ver = await go([items, get(/items\/nbt-1\/jobs\/instances\/run-7$/, { id: "run-7", status: "Completed" })], ["notebook-test", "verify", ...base, "--job", "run-7"], { env });
    expect(ver.out).toContain("PASSED");
    expect((await go([items], ["notebook-test", "verify", ...base, "--job", "other"], { env })).errs[0]).toContain("not the run of the prepared");
    expect((await go([items], ["notebook-test", "run", ...base], { env: { AIHUB_HOME: tmp() } })).errs[0]).toContain("no smoke test was prepared");
  });
});

describe("dbt", () => {
  const PROJECT = {
    "dbt_project.yml": "name: shop\nprofile: shop\nmodel-paths: [models]\n",
    "models/a.sql": "select 1",
    "profiles.yml": "shop:\n  target: dev\n  outputs:\n    dev:\n      type: fabric\n      server: abc.datawarehouse.fabric.microsoft.com\n      database: wh_test\n      schema: dbo\n      password: hunter2\n      authentication: CLI\n",
    "target/run_results.json": JSON.stringify({ args: { which: "build" }, results: [{ status: "success", unique_id: "model.shop.a" }, { status: "error", unique_id: "model.shop.b", message: "Database Error token=abcdefgh1234" }] }),
    "logs/dbt.log": "line1\nline2",
  };
  const whRoutes = [get(new RegExp(`/workspaces/${WS}/items\\?type=Warehouse$`), { value: [ITEMS[3]] }), get(new RegExp(`/workspaces/${WS}/warehouses/wh-1$`), { properties: { connectionString: "abc.datawarehouse.fabric.microsoft.com" } })];

  it("detect masks credentials, results lists failures with redacted messages", async () => {
    const dir = repo(PROJECT);
    const a = await go([], ["dbt", "detect"], { dir, setup: (c) => (c.spawn = () => ({ status: 0, stdout: "Core: 1.9.0\n", stderr: "" })) });
    expect(a.out).toContain("1 dbt project(s)");
    expect(a.out).toContain("shop/dev: fabric -> route warehouse (default)");
    expect(a.out).not.toContain("hunter2");
    expect(a.out).toContain("Core: 1.9.0");
    const b = await go([], ["dbt", "results"], { dir });
    expect(b.out).toContain("error model.shop.b: Database Error");
    expect(b.out).not.toContain("abcdefgh1234");
    expect(b.out).toContain("line2");
  });

  it("run proves the profile target is a warehouse of the workspace, then spawns dbt without a shell", async () => {
    const dir = repo(PROJECT);
    const seen: any[] = [];
    const spawn = (cmd: string, args: string[], cwd: string) => (seen.push({ cmd, args, cwd }), { status: 0, stdout: "ok", stderr: "" });
    const r = await go(whRoutes, ["dbt", "run", "--workspace", "DEV-test-project", "--command", "build", "--select", "a+", "--full-refresh"], { dir, setup: (c) => (c.spawn = spawn) });
    expect(r.code).toBe(0);
    expect(seen[0].cmd).toBe("dbt");
    expect(seen[0].args).toEqual(expect.arrayContaining(["build", "--select", "a+", "--full-refresh", "--project-dir"]));
    expect(r.out).toContain("dbt build succeeded");
    const other = repo({ ...PROJECT, "profiles.yml": PROJECT["profiles.yml"].replace("wh_test", "other_db") });
    const bad = await go(whRoutes, ["dbt", "run", "--workspace", "DEV-test-project", "--command", "build"], { dir: other, setup: (c) => (c.spawn = spawn) });
    expect(bad.errs[0]).toContain("is not a Warehouse in DEV-test-project");
    expect(seen).toHaveLength(1);
    expect((await go(whRoutes, ["dbt", "run", "--workspace", "DEV-test-project", "--command", "build", "--select=--vars"], { dir, setup: (c) => (c.spawn = spawn) })).errs[0]).toContain("must not look like a flag");
    expect((await go(whRoutes, ["dbt", "run", "--workspace", "DEV-test-project", "--command", "clean"], { dir })).errs[0]).toContain("--command must be one of");
    expect((await go(whRoutes, ["dbt", "run", "--workspace", "ACC-test-project", "--command", "build"], { dir })).errs[0]).toContain("is ACC");
    const fail = await go(whRoutes, ["dbt", "run", "--workspace", "DEV-test-project", "--command", "build"], { dir, setup: (c) => (c.spawn = () => ({ status: 2, stdout: "", stderr: "boom" })) });
    expect(fail.code).toBe(1);
  });

  it("scaffold writes a project without secrets and refuses to overwrite", async () => {
    const dir = repo();
    const a = await go([items, ...whRoutes], ["dbt", "scaffold", "--route", "warehouse", "--workspace", "DEV-test-project", "--warehouse", "wh_test", "--project-name", "demo"], { dir });
    expect(a.out).toContain("scaffolded dbt project demo");
    const profiles = readFileSync(join(dir, "demo", "profiles.yml"), "utf8");
    expect(profiles).toContain("authentication: CLI");
    expect(profiles).toContain("database: wh_test");
    expect(profiles).not.toMatch(/password|secret/i);
    expect(existsSync(join(dir, "demo", "models", "marts", "mart_example.sql"))).toBe(true);
    const again = await go([items, ...whRoutes], ["dbt", "scaffold", "--route", "warehouse", "--workspace", "DEV-test-project", "--warehouse", "wh_test", "--project-name", "demo"], { dir });
    expect(again.errs[0]).toContain("refusing to overwrite");
  });

  it("upload sends the project (without profiles.yml) to OneLake; save-job builds the definition; get-job decodes it", async () => {
    const dir = repo(PROJECT);
    const dfs: Route[] = [{ method: "PUT", match: /onelake/, respond: () => ({ body: {} }) }, { method: "PATCH", match: /onelake/, respond: () => ({ body: {} }) }];
    const up = await go([items, ...dfs], ["dbt", "upload", "--workspace", "DEV-test-project", "--lakehouse", "lh_test", "--folder-path", "dbt/shop"], { dir });
    const urls = up.calls.filter((c) => c.method === "PUT").map((c) => decodeURIComponent(c.url));
    expect(urls.some((u) => u.includes("Files/dbt/shop/models/a.sql"))).toBe(true);
    expect(urls.some((u) => u.includes("profiles.yml"))).toBe(false);
    expect(up.out).toContain("uploaded");
    const save = await go([items, itemsOfType("DataBuildToolJob"), ...whRoutes.slice(1), send("POST", /dataBuildToolJobs$/, { id: "j1" }, { status: 201 })], ["dbt", "save-job", "--workspace", "DEV-test-project", "--warehouse", "wh_test", "--name", "dbt_job", "--schema", "analytics"], { dir });
    expect(save.out).toContain("created dbt job dbt_job");
    const def = save.calls.at(-1)!.body.definition.parts;
    const content = JSON.parse(Buffer.from(def.find((p: any) => p.path === "dbt-content.json").payload, "base64").toString());
    expect(content).toMatchObject({ project: { projectType: "OneLake", folderPath: "dbt" }, profile: { profileType: "DataWarehouse", schema: "analytics", connectionSettings: { properties: { typeProperties: { workspaceId: WS, artifactId: "wh-1" } } } } });
    expect(def.some((p: any) => p.path === "Code/dbt/models/a.sql")).toBe(true);
    expect(def.some((p: any) => p.path.endsWith("profiles.yml"))).toBe(false);
  });
});

describe("servicePrincipal per group", () => {
  it("a group object carries its service principal name", async () => {
    const { saveSpFile } = await import("../src/lib/fabric-auth.js");
    const home = tmp();
    saveSpFile({ env: { AIHUB_HOME: home } }, { principals: { ci: { tenant: "t1", clientId: "c1", secretRef: "kv://v/s" } } });
    const r = await go([items, send("POST", /oauth2/, { access_token: "sp-tok", expires_in: 3600 })], ["run", "--workspaces", "devs", "--item", "nb_load", "--dry-run"], { env: { AIHUB_HOME: home, AIHUB_FABRIC_TOKEN: "" }, setup: (c) => (c.exec = () => "secret-value") });
    expect(r.code).toBe(0);
    const login = r.calls.find((c) => c.url.includes("oauth2"))!;
    expect(String(login.body)).toContain("client_id=c1");
    expect(r.calls.find((c) => c.url.includes("/items"))!.headers.Authorization).toBe("Bearer sp-tok");
  });
});

describe("remaining legacy rows", () => {
  it("domain, deployment, ML endpoint, Databricks discovery and eventstream state run through api", async () => {
    const d = await go([get(/admin\/domains\/d1$/, { id: "d1", displayName: "Sales" })], ["api", "get_domain", "--arg", "domainId=d1"]);
    expect(d.out).toContain("Sales");
    const ops = await go([get(/deploymentPipelines\/dp1\/operations$/, { value: [{ id: "o1" }] })], ["api", "list_deployment_operations", "--arg", "deploymentPipelineId=dp1"]);
    expect(ops.out).toContain("1 operations");
    const db = await go([items, get(/azureDatabricks\/catalogs\?databricksWorkspaceConnectionId=c1&maxResults=50$/, { value: [{ name: "main" }] })], ["api", "discover_databricks_catalog", "--workspace", "DEV-test-project", "--arg", "connectionId=c1", "--arg", "maxResults=50"]);
    expect(db.out).toContain("1 catalogs");
    const es = await go([items, send("POST", /eventstreams\/.*\/topology\/resume$/)], ["api", "set_eventstream_state", "--workspace", "DEV-test-project", "--item", "nb_load", "--arg", "action=resume", "--arg", "startType=Now"]);
    expect(es.calls.at(-1)!.body).toEqual({ startType: "Now" });
    const acc = await go([items], ["api", "save_custom_pool", "--workspace", "ACC-test-project", "--dry-run"]);
    expect(acc.errs[0]).toContain("is ACC");
  });
  it("uploads an environment library as multipart to the staging, refusing odd file names", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "mylib-1.0-py3-none-any.whl"), "PK-binary");
    writeFileSync(join(dir, "bad.exe"), "x");
    const envItems = get(new RegExp(`/workspaces/${WS}/items$`), { value: [{ id: "env-1", displayName: "env_main", type: "Environment" }] });
    const up = await go([envItems, { method: "POST", match: /environments\/env-1\/staging\/libraries$/, respond: () => ({ body: {} }) }], ["environment", "upload-library", "--workspace", "DEV-test-project", "--item", "env_main", "--file", join(dir, "mylib-1.0-py3-none-any.whl")]);
    expect(up.out).toContain("uploaded mylib-1.0-py3-none-any.whl");
    expect(up.calls.at(-1)!.headers["Content-Type"]).toMatch(/^multipart\/form-data; boundary=/);
    const bad = await go([envItems], ["environment", "upload-library", "--workspace", "DEV-test-project", "--item", "env_main", "--file", join(dir, "bad.exe")]);
    expect(bad.errs[0]).toContain("must end in");
  });
  it("a connection body with an inline secret is refused", async () => {
    const f = join(tmp(), "c.json");
    writeFileSync(f, JSON.stringify({ displayName: "sql-test", credentialDetails: { credentials: { password: "plain-secret" } } }));
    const r = await go([], ["connection", "create", "--body-file", f]);
    expect(r.errs[0]).toContain("no secret may be inline");
    expect(r.errs[0]).not.toContain("plain-secret");
  });
});

describe("sql on a lakehouse with a same-named SQL endpoint", () => {
  it("picks the Lakehouse instead of reporting the name as ambiguous", async () => {
    const both = get(new RegExp(`/workspaces/${WS}/items$`), { value: [{ id: "lh-1", displayName: "lh_test", type: "Lakehouse" }, { id: "ep-1", displayName: "lh_test", type: "SQLEndpoint" }] });
    const lh = get(new RegExp(`/workspaces/${WS}/lakehouses/lh-1$`), { properties: { sqlEndpointProperties: { connectionString: "abc.datawarehouse.fabric.microsoft.com" } } });
    const seen: any[] = [];
    const r = await go([both, lh], ["sql", "--workspace", "DEV-test-project", "--item", "lh_test", "--query", "select 1 as x"], { setup: (c) => (c.sql = async (ep: any) => (seen.push(ep), { columns: ["x"], rows: [[1]] })) });
    expect(r.code).toBe(0);
    expect(seen[0]).toMatchObject({ host: "abc.datawarehouse.fabric.microsoft.com", database: "lh_test" });
  });
});

describe("spark stop", () => {
  const me = "49284f26-fb77-4714-b6fb-1bcc024e090e";
  const jwt = (oid: string) => `h.${Buffer.from(JSON.stringify({ oid })).toString("base64url")}.s`;
  const sess = [
    { livyId: "L-job", state: "Idle", submitter: { id: me }, item: { itemId: "nb-1" }, itemName: "nb_load", itemType: "notebook", jobInstanceId: "J1" },
    { livyId: "L-api", state: "Busy", submitter: { id: me }, item: { itemId: "lh-1" }, itemName: "lh_test", itemType: "lakehouse", jobInstanceId: "L-api" },
    { livyId: "L-other", state: "Idle", submitter: { id: "someone-else" }, item: { itemId: "nb-1" }, itemName: "nb_load", itemType: "notebook", jobInstanceId: "J2" },
    { livyId: "L-done", state: "Succeeded", submitter: { id: me }, item: { itemId: "nb-1" }, itemName: "nb_load", itemType: "notebook", jobInstanceId: "J3" },
  ];
  const list = get(new RegExp(`/workspaces/${WS}/spark/livySessions$`), { value: sess });
  const routes = [list, send("POST", /items\/nb-1\/jobs\/instances\/J1\/cancel$/, {}), send("DELETE", /lakehouses\/lh-1\/livyapi\/versions\/2023-12-01\/sessions\/L-api$/, {})];
  const env = { AIHUB_FABRIC_TOKEN: jwt(me) };
  it("--all-mine stops only my active sessions: job sessions by cancelling the job, Livy API sessions by closing them", async () => {
    const r = await go(routes, ["spark", "stop", "--workspace", "DEV-test-project", "--all-mine"], { env });
    expect(r.code).toBe(0);
    expect(r.out).toContain("stopped L-job");
    expect(r.out).toContain("stopped L-api");
    expect(r.out).not.toContain("L-other");
    expect(r.calls.filter((c) => c.method !== "GET").map((c) => c.method + " " + c.url.split("/workspaces/")[1].replace(WS + "/", ""))).toEqual(["POST items/nb-1/jobs/instances/J1/cancel", "DELETE lakehouses/lh-1/livyapi/versions/2023-12-01/sessions/L-api"]);
  });
  it("--dry-run changes nothing; --session of a finished session is a no-op; ACC is refused; flags are required", async () => {
    const dry = await go(routes, ["spark", "stop", "--workspace", "DEV-test-project", "--all-mine", "--dry-run"], { env });
    expect(dry.out).toContain("dry-run");
    expect(dry.calls.every((c) => c.method === "GET")).toBe(true);
    const done = await go(routes, ["spark", "stop", "--workspace", "DEV-test-project", "--session", "L-done"], { env });
    expect(done.out).toContain("nothing to stop");
    expect(done.calls.every((c) => c.method === "GET")).toBe(true);
    const acc = await go(routes, ["spark", "stop", "--workspace", "ACC-test-project", "--all-mine"], { env });
    expect(acc.errs[0]).toContain("is ACC");
    expect(acc.calls).toHaveLength(0);
    expect((await go(routes, ["spark", "stop", "--workspace", "DEV-test-project"], { env })).errs[0]).toContain("usage: aihub fabric spark stop");
    expect((await go(routes, ["spark", "stop", "--workspace", "DEV-test-project", "--all-mine"])).errs[0]).toContain("cannot tell who you are");
  });
  it("a failing stop is reported and the exit code is 1", async () => {
    const r = await go([list, send("POST", /cancel$/, { error: "x" }, { status: 500 }), routes[2]], ["spark", "stop", "--workspace", "DEV-test-project", "--all-mine"], { env });
    expect(r.code).toBe(1);
    expect(r.out).toContain("could not stop L-job");
    expect(r.out).toContain("stopped L-api");
  });
  it("fabric run prints the stop hint when the capacity is full", async () => {
    const r = await go([items, send("POST", /jobs\/instances\?jobType=/, { errorCode: "TooManyRequestsForCapacity", message: "TooManyRequestsForCapacity" }, { status: 430 })], ["run", "--workspace", "DEV-test-project", "--item", "nb_load"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("aihub fabric spark stop --workspace DEV-test-project --all-mine");
  });
});
