import { describe, expect, it } from "vitest";
import { commands, main } from "../src/router.js";
import {
  checkSkips,
  firstFailureOf,
  mergeParameters,
  mergeVariables,
  planStages,
  recState,
  remoteOf,
  runState,
  treeOf,
  variablesOf,
  yamlFacts,
  type Rec,
} from "../src/lib/pipelineView.js";
import { ctxFor, fakeFetch, makeRepo, sh, tmp, write, type Route } from "./helpers.js";
import { join } from "node:path";

const ME = "11111111-2222-3333-4444-555555555555";
const NOW = Date.parse("2026-11-26T14:20:00Z");
const midnightIso = (() => {
  const d = new Date(NOW);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
})();

const build = (id: number, extra: object = {}) => ({
  id,
  buildNumber: `20261126.${id}`,
  status: "completed",
  result: "succeeded",
  queueTime: "2026-11-26T13:00:00Z",
  startTime: "2026-11-26T13:00:03Z",
  finishTime: "2026-11-26T13:06:44Z",
  sourceBranch: "refs/heads/feature/4711-orderexport",
  sourceVersion: "3f9a2c1".padEnd(40, "0"),
  reason: "manual",
  requestedFor: { id: ME, displayName: "Test User" },
  definition: { id: 7, name: "orders-ci" },
  repository: { id: "repo-a-id", name: "test-repo", type: "TfsGit" },
  ...extra,
});

const TL: Rec[] = [
  { id: "sB", type: "Stage", name: "Build", identifier: "Build", state: "completed", result: "succeeded", order: 1, startTime: "2026-11-26T13:00:05Z", finishTime: "2026-11-26T13:01:17Z" },
  { id: "pB", parentId: "sB", type: "Phase", name: "build", state: "completed", result: "succeeded", order: 1 },
  { id: "jB", parentId: "pB", type: "Job", name: "Job build", state: "completed", result: "succeeded", order: 1, workerName: "vm-ubuntu-14", startTime: "2026-11-26T13:00:05Z", finishTime: "2026-11-26T13:01:13Z" },
  { id: "tB1", parentId: "jB", type: "Task", name: "Build wheel", state: "completed", result: "succeeded", order: 1, log: { id: 3 }, startTime: "2026-11-26T13:00:10Z", finishTime: "2026-11-26T13:01:02Z" },
  { id: "sT", type: "Stage", name: "Test", identifier: "Test", state: "completed", result: "failed", order: 2, startTime: "2026-11-26T13:01:20Z", finishTime: "2026-11-26T13:05:00Z" },
  { id: "pT", parentId: "sT", type: "Phase", name: "pytest", state: "completed", result: "failed", order: 1 },
  { id: "jT", parentId: "pT", type: "Job", name: "Job pytest", state: "completed", result: "failed", order: 1, workerName: "vm-ubuntu-14" },
  { id: "tT1", parentId: "jT", type: "Task", name: "Install requirements", state: "completed", result: "succeeded", order: 1, log: { id: 8 } },
  { id: "tT2", parentId: "jT", type: "Task", name: "Run pytest", state: "completed", result: "failed", order: 2, errorCount: 2, log: { id: 9 }, startTime: "2026-11-26T13:01:50Z", finishTime: "2026-11-26T13:04:41Z" },
  { id: "cT", parentId: "jT", type: "Checkpoint", name: "Checkpoint", state: "completed", result: "succeeded", order: 3 },
  { id: "sD", type: "Stage", name: "Deploy dev", identifier: "DeployDev", state: "completed", result: "skipped", order: 3 },
];

const YAML = `
parameters:
  - name: runIntegration
    type: boolean
    default: false
  - name: pythonVersion
    type: string
    default: "3.11"
    values: ["3.10", "3.11", "3.12"]
  - name: environment
    displayName: Environment
    default: dev
stages:
  - stage: Build
  - stage: Test
  - stage: DeployDev
    displayName: Deploy dev
    dependsOn: Test
`;

const LOG9 = [
  "2026-11-26T13:04:30.0000000Z collected 148 items",
  "2026-11-26T13:04:39.0000000Z FAILED notebooks/test_orders.py::test_empty_customer_number - AssertionError: customer_number must not be empty",
  "2026-11-26T13:04:39.0000000Z notebooks/test_orders.py:41: AssertionError",
  "2026-11-26T13:04:40.0000000Z ##[error]Bash exited with code '1'.",
].join("\n");

const DEF = {
  id: 7,
  process: { yamlFilename: "ci/orders-ci.yml", type: 2 },
  repository: { id: "repo-a-id", type: "TfsGit" },
  variables: {
    BuildConfiguration: { value: "release", allowOverride: true },
    debugLogging: { value: "false", allowOverride: true },
    DB_PASSWORD: { isSecret: true, allowOverride: true },
    locked: { value: "x" },
  },
};

function baseRoutes(b: object): Route[] {
  return [
    { match: /_apis\/connectionData/, respond: () => ({ body: { authenticatedUser: { id: ME, providerDisplayName: "Test User" } } }) },
    { match: /build\/builds\/2046\/timeline/, respond: () => ({ body: { records: TL } }) },
    { match: /build\/builds\/2046\/logs\/9/, respond: () => ({ text: LOG9 }) },
    { match: /build\/builds\/2046\?/, respond: () => ({ body: b }) },
    { match: /build\/definitions\/7\?/, respond: () => ({ body: DEF }) },
    { match: /git\/repositories\/repo-a-id\/items\?/, respond: () => ({ body: { content: YAML } }) },
    { match: /git\/repositories\/repo-a-id\/commits\/3f9a2c1/, respond: () => ({ body: { comment: "Guard empty customer number\n\nbody" } }) },
    {
      match: /git\/repositories\/repo-a-id\/commits\?/,
      respond: () => ({ body: { value: [{ commitId: "8b1d7e0".padEnd(40, "0"), comment: "Fix amount filter" }, { commitId: "3f9a2c1".padEnd(40, "0"), comment: "Guard empty customer number" }] } }),
    },
    { match: /git\/repositories\/repo-a-id\/pullrequests\?/, respond: () => ({ body: { value: [{ pullRequestId: 812 }] } }) },
    { match: /test\/runs\?/, respond: () => ({ body: { value: [{ id: 50, totalTests: 148, passedTests: 146 }] } }) },
    {
      match: /test\/runs\/50\/results\?/,
      respond: () => ({ body: { value: [{ automatedTestName: "notebooks.test_orders.test_empty_customer_number", automatedTestStorage: "notebooks/test_orders.py", errorMessage: "AssertionError: customer_number must not be empty", stackTrace: "def test_empty_customer_number():\n>       assert x\nE       AssertionError\n\nnotebooks/test_orders.py:41: AssertionError" }] } }),
    },
  ];
}

function world(routes: Route[]) {
  const { dir } = makeRepo();
  const f = fakeFetch(routes);
  const c = ctxFor(dir, f.fn);
  c.ctx.now = () => NOW;
  return { ...c, f, dir };
}

async function json(args: string[], w: ReturnType<typeof world>) {
  const code = await main(args, w.ctx, commands);
  if (code !== 0) throw new Error(w.errs.join("\n"));
  return JSON.parse(w.lines.join("\n"));
}

describe("pipeline view: mappings", () => {
  it("run and record states", () => {
    expect(runState({ status: "inProgress" })).toBe("running");
    expect(runState({ status: "notStarted" })).toBe("queued");
    expect(runState({ status: "completed", result: "failed" })).toBe("failed");
    expect(runState({ status: "completed", result: "canceled" })).toBe("canceled");
    expect(recState({ state: "completed", result: "succeededWithIssues" })).toBe("partiallySucceeded");
    expect(recState({ state: "completed", result: "skipped" })).toBe("skipped");
    expect(recState({ state: "completed", result: "abandoned" })).toBe("canceled");
    expect(recState({ state: "pending" })).toBe("pending");
  });

  it("the tree has stages, jobs (through phases) and steps, without checkpoints, and says why a stage did not run", () => {
    const t = treeOf(TL, (r) => `u/${r.id}`, yamlFacts(YAML).stageDeps);
    expect(t.map((s) => [s.name, s.state, s.durationSeconds])).toEqual([
      ["Build", "succeeded", 72],
      ["Test", "failed", 220],
      ["Deploy dev", "skipped", null],
    ]);
    expect(t[1].jobs[0].steps.map((s) => s.name)).toEqual(["Install requirements", "Run pytest"]);
    expect(t[1].jobs[0].steps[1]).toMatchObject({ errorCount: 2, logId: 9, durationSeconds: 171, webUrl: "u/tT2" });
    expect(t[1].errorCount).toBe(2);
    expect(t[2]).toMatchObject({ dependsOn: ["Test"], notRunReason: "Test failed" });
  });

  it("YAML facts: parameter types and values, stage dependencies (default: the stage before)", () => {
    const y = yamlFacts(YAML);
    expect(y.parameters.map((p) => [p.name, p.type, p.values])).toEqual([
      ["runIntegration", "boolean", null],
      ["pythonVersion", "string", ["3.10", "3.11", "3.12"]],
      ["environment", "string", null],
    ]);
    expect([...y.stageDeps!.entries()]).toEqual([
      ["Build", []],
      ["Test", ["Build"]],
      ["DeployDev", ["Test"]],
    ]);
    expect(yamlFacts("extends:\n  template: x.yml\n").stageDeps).toBeUndefined();
    expect(yamlFacts(": not yaml [").parameters).toEqual([]);
  });

  it("variables: queue-time values win, secrets never carry a value", () => {
    const v = variablesOf(DEF.variables, JSON.stringify({ debugLogging: "true", DB_PASSWORD: "leak?", "system.debug": "true" }));
    expect(v).toEqual([
      { name: "BuildConfiguration", value: "release", isSecret: false, settable: true },
      { name: "debugLogging", value: "true", isSecret: false, settable: true },
      { name: "DB_PASSWORD", value: null, isSecret: true, settable: true },
      { name: "locked", value: "x", isSecret: false, settable: false },
      { name: "system.debug", value: "true", isSecret: false, settable: true },
    ]);
  });

  it("the first failed test with its file:line from the stack trace", () => {
    expect(firstFailureOf({ automatedTestName: "notebooks.test_orders.test_zero", automatedTestStorage: "notebooks/test_orders.py", stackTrace: "x\nnotebooks/orders.py:15: KeyError\nnotebooks/test_orders.py:60: in test_zero" })).toEqual({
      test: "test_zero",
      message: null,
      file: "notebooks/test_orders.py",
      line: 60,
    });
  });

  it("skips: only stages nothing depends on, unless the dependents are skipped too", () => {
    const st = planStages([{ identifier: "Build", name: "Build" }, { identifier: "Test", name: "Test" }, { identifier: "DeployDev", name: "Deploy dev" }], yamlFacts(YAML).stageDeps);
    expect(st.map((s) => [s.identifier, s.requiredBy, s.canSkip])).toEqual([
      ["Build", ["Test"], false],
      ["Test", ["DeployDev"], false],
      ["DeployDev", [], true],
    ]);
    expect(checkSkips(st, ["deploy dev"])).toEqual(["DeployDev"]);
    expect(checkSkips(st, ["Test", "DeployDev"])).toEqual(["Test", "DeployDev"]);
    expect(() => checkSkips(st, ["Test"])).toThrow(/DeployDev depends on it/);
    expect(() => checkSkips(st, ["Lint"])).toThrow(/no stage 'Lint'/);
  });

  it("parameters are checked against type and allowed values; variables need 'settable', a secret only when given", () => {
    const plan = yamlFacts(YAML).parameters.map((p) => ({ ...p, value: p.name === "runIntegration" ? "false" : String(p.default) }));
    expect(mergeParameters(plan, { runIntegration: true })).toEqual({ all: { runIntegration: "true", pythonVersion: "3.11", environment: "dev" }, changed: ["runIntegration"] });
    expect(() => mergeParameters(plan, { runIntegration: "yes" })).toThrow(/boolean/);
    expect(() => mergeParameters(plan, { pythonVersion: "2.7" })).toThrow(/allows 3.10, 3.11, 3.12/);
    expect(() => mergeParameters(plan, { nope: 1 })).toThrow(/no parameter 'nope'/);
    const vars = variablesOf(DEF.variables, undefined);
    const m = mergeVariables(vars, { debugLogging: "true", DB_PASSWORD: null });
    expect(m.send).toEqual({ BuildConfiguration: { value: "release" }, debugLogging: { value: "true" } });
    expect(m.changed).toEqual(["debugLogging"]);
    expect(mergeVariables(vars, { DB_PASSWORD: "s3cret" }).send.DB_PASSWORD).toEqual({ value: "s3cret", isSecret: true });
    expect(() => mergeVariables(vars, { locked: "y" })).toThrow(/cannot be set when queuing/);
  });

  it("the remote is read from .git/config, also in a linked worktree (no git process)", () => {
    const { dir } = makeRepo();
    expect(remoteOf(dir)).toMatchObject({ org: "ferron-org", project: "test-project", repo: "test-repo" });
    const wt = join(tmp(), "wt");
    sh(dir, ["worktree", "add", "--detach", wt]);
    expect(remoteOf(join(wt))).toMatchObject({ repo: "test-repo" });
  });
});

describe("aihub pipeline list", () => {
  it("my runs of several repositories in one call per project, today's counts, the running stage", async () => {
    const other = makeRepo().dir;
    sh(other, ["config", "remote.origin.url", "https://dev.azure.com/ferron-org/test-project/_git/repo-b"]);
    const runs = [
      build(2049, { status: "inProgress", result: undefined, finishTime: undefined, queueTime: "2026-11-26T14:16:00Z", startTime: "2026-11-26T14:16:00Z" }),
      build(2046, { result: "failed", queueTime: "2026-11-26T14:02:00Z" }),
      build(77, { definition: { id: 9, name: "orders-nightly" }, repository: { name: "repo-b" }, sourceBranch: "refs/heads/staging", queueTime: "2026-11-26T14:00:00Z" }),
      build(99, { repository: { name: "unrelated" }, queueTime: "2026-11-26T14:10:00Z" }),
      build(2041, { queueTime: "2026-11-25T09:00:00Z" }),
    ];
    const w = world([
      ...baseRoutes(build(2046)),
      { match: /build\/builds\?/, respond: () => ({ body: { value: runs } }) },
      { match: /build\/builds\/2049\/timeline/, respond: () => ({ body: { records: [{ id: "s", type: "Stage", name: "Test", state: "inProgress", order: 2 }] } }) },
    ]);
    const r = await json(["pipeline", "list", "--mine", "--repo-dir", w.dir, "--repo-dir", other], w);
    expect(r.me).toEqual({ id: ME, name: "Test User" });
    expect(r.since).toBe(midnightIso);
    expect(r.runs.map((x: any) => [x.id, x.state, x.repo, x.currentStage])).toEqual([
      [2049, "running", "test-repo", "Test"],
      [2046, "failed", "test-repo", null],
      [77, "succeeded", "repo-b", null],
      [2041, "succeeded", "test-repo", null],
    ]);
    expect(r.runs[0]).toMatchObject({ number: "20261126.2049", pipeline: { id: 7, name: "orders-ci" }, branch: "feature/4711-orderexport", reason: "manual", requestedFor: { name: "Test User", isMe: true }, durationSeconds: 240, repoDir: w.dir });
    expect(r.runs[0].webUrl).toBe("https://dev.azure.com/ferron-org/test-project/_build/results?buildId=2049");
    expect(r.today).toMatchObject({ total: 3, running: 1, failed: 1, succeeded: 1, capped: false });
    const listCalls = w.f.calls.filter((c) => /build\/builds\?/.test(c.url));
    expect(listCalls).toHaveLength(1); // two repositories of one project: one call
    expect(listCalls[0].url).toContain(`requestedFor=${ME}`);
  });

  it("the menu of one branch: the newest 3 of mine, PR runs of that branch included", async () => {
    const runs = [
      build(5, { sourceBranch: "refs/pull/812/merge", reason: "pullRequest", triggerInfo: { "pr.number": "812", "pr.sourceBranch": "refs/heads/feature/4711-orderexport" }, queueTime: "2026-11-26T14:05:00Z" }),
      build(4, { sourceBranch: "refs/heads/main", queueTime: "2026-11-26T14:04:00Z" }),
      build(3, { queueTime: "2026-11-26T14:03:00Z" }),
      build(2, { queueTime: "2026-11-26T14:02:00Z" }),
      build(1, { queueTime: "2026-11-26T14:01:00Z" }),
    ];
    const w = world([...baseRoutes(build(1)), { match: /build\/builds\?/, respond: () => ({ body: { value: runs } }) }]);
    const r = await json(["pipeline", "list", "--mine", "--branch", "feature/4711-orderexport", "--top", "3"], w);
    expect(r.runs.map((x: any) => [x.id, x.reason, x.branch])).toEqual([
      [5, "pullRequest", "feature/4711-orderexport"],
      [3, "manual", "feature/4711-orderexport"],
      [2, "manual", "feature/4711-orderexport"],
    ]);
    expect(r.today.total).toBe(4);
  });

  it("--today and --status filter; a repository that cannot be read is reported, the rest still arrives", async () => {
    const runs = [build(3, { result: "failed", queueTime: "2026-11-26T14:03:00Z" }), build(2, { queueTime: "2026-11-26T14:02:00Z" })];
    const w = world([...baseRoutes(build(1)), { match: /build\/builds\?/, respond: () => ({ body: { value: runs } }) }]);
    const nogit = tmp();
    write(nogit, "x.txt", "x");
    const r = await json(["pipeline", "list", "--mine", "--today", "--status", "failed", "--repo-dir", w.dir, "--repo-dir", nogit], w);
    expect(r.runs.map((x: any) => x.id)).toEqual([3]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].repoDir).toBe(nogit);
    expect(w.f.calls.find((c) => /build\/builds\?/.test(c.url))!.url).toContain("minTime=");
  });

  it("today's counts are flagged incomplete only when even the oldest run read is from today", async () => {
    const many = (day: string) => Array.from({ length: 100 }, (_, i) => build(1000 - i, { queueTime: i < 99 ? "2026-11-26T14:00:00Z" : day }));
    const old = world([...baseRoutes(build(1)), { match: /build\/builds\?/, respond: () => ({ body: { value: many("2026-11-20T10:00:00Z") } }) }]);
    expect((await json(["pipeline", "list", "--mine"], old)).today).toMatchObject({ total: 99, capped: false });
    const busy = world([...baseRoutes(build(1)), { match: /build\/builds\?/, respond: () => ({ body: { value: many("2026-11-26T13:00:00Z") } }) }]);
    expect((await json(["pipeline", "list", "--mine"], busy)).today).toMatchObject({ total: 100, capped: true });
  });

  it("who I am is asked once and kept", async () => {
    const w = world([...baseRoutes(build(1)), { match: /build\/builds\?/, respond: () => ({ body: { value: [] } }) }]);
    await json(["pipeline", "list", "--mine"], w);
    w.lines.length = 0;
    await json(["pipeline", "list", "--mine"], w);
    expect(w.f.calls.filter((c) => /connectionData/.test(c.url))).toHaveLength(1);
  });
});

describe("aihub pipeline show / poll / log", () => {
  it("show: tree, trigger, parameters, variables without secret values, and a plain summary", async () => {
    const b = build(2046, { result: "failed", templateParameters: { runIntegration: "false", pythonVersion: "3.11", environment: "dev" }, parameters: JSON.stringify({ DB_PASSWORD: null }) });
    const w = world(baseRoutes(b));
    const r = await json(["pipeline", "show", "--run", "2046"], w);
    expect(r.run).toMatchObject({
      id: 2046,
      state: "failed",
      manual: true,
      requestedFor: { name: "Test User", isMe: true },
      branch: "feature/4711-orderexport",
      commit: { short: "3f9a2c1", message: "Guard empty customer number" },
      pr: { id: 812, webUrl: "https://dev.azure.com/ferron-org/test-project/_git/test-repo/pullrequest/812" },
      waitSeconds: 3,
      durationSeconds: 401,
      agent: "vm-ubuntu-14",
    });
    expect(r.stages.map((s: any) => s.name)).toEqual(["Build", "Test", "Deploy dev"]);
    expect(r.stages[1].jobs[0].steps[1].webUrl).toBe("https://dev.azure.com/ferron-org/test-project/_build/results?buildId=2046&view=logs&j=jT&t=tT2");
    expect(r.parameters).toEqual([
      { name: "runIntegration", value: "false" },
      { name: "pythonVersion", value: "3.11" },
      { name: "environment", value: "dev" },
    ]);
    expect(r.variables.find((v: any) => v.name === "DB_PASSWORD")).toEqual({ name: "DB_PASSWORD", value: null, isSecret: true });
    expect(JSON.stringify(r)).not.toContain("leak");
    expect(r.summary).toEqual({
      text: "Stage Test stopped at step Run pytest. 2 of 148 tests failed. The first failure is test_empty_customer_number in notebooks/test_orders.py:41.",
      stoppedStage: "Test",
      stoppedStep: "Run pytest",
      stoppedStepId: "tT2",
      failedTests: 2,
      totalTests: 148,
      firstFailure: { test: "test_empty_customer_number", message: "AssertionError: customer_number must not be empty", file: "notebooks/test_orders.py", line: 41 },
    });
  });

  it("a green run with a skipped stage says so", async () => {
    const tl = TL.map((r) => (r.result === "failed" ? { ...r, result: "succeeded" } : r));
    const w = world([{ match: /build\/builds\/2046\/timeline/, respond: () => ({ body: { records: tl } }) }, { match: /test\/runs\?/, respond: () => ({ body: { value: [{ id: 50, totalTests: 3, passedTests: 3 }] } }) }, ...baseRoutes(build(2046))]);
    expect((await json(["pipeline", "show", "--run", "2046"], w)).summary.text).toBe("Succeeded: 2 stages, skipped Deploy dev. All 3 tests passed.");
  });

  it("show without test results: the first error of the failed step's log", async () => {
    const w = world([{ match: /test\/runs\?/, respond: () => ({ body: { value: [] } }) }, ...baseRoutes(build(2046, { result: "failed" }))]);
    const r = await json(["pipeline", "show", "--run", "2046"], w);
    expect(r.summary.text).toBe("Stage Test stopped at step Run pytest. The first error is: AssertionError: customer_number must not be empty");
    expect(r.summary.failedTests).toBeNull();
  });

  it("poll: two calls, the running stage and step", async () => {
    const running = build(2049, { status: "inProgress", result: undefined, finishTime: undefined, startTime: "2026-11-26T14:16:00Z" });
    const w = world([
      { match: /build\/builds\/2049\/timeline/, respond: () => ({ body: { records: [{ id: "s", type: "Stage", name: "Test", state: "inProgress", order: 2 }, { id: "t", parentId: "j", type: "Task", name: "Run pytest", state: "inProgress", order: 2 }] } }) },
      { match: /build\/builds\/2049\?/, respond: () => ({ body: running }) },
    ]);
    const r = await json(["pipeline", "poll", "--run", "2049"], w);
    expect(r).toMatchObject({ id: 2049, state: "running", finished: false, currentStage: "Test", currentStep: "Run pytest", durationSeconds: 240, failedStage: null, tests: null });
    expect(w.f.calls).toHaveLength(2);
  });

  it("poll of a failed run names stage, step and the test count", async () => {
    const w = world(baseRoutes(build(2046, { result: "failed" })));
    const r = await json(["pipeline", "poll", "--run", "2046"], w);
    expect(r).toMatchObject({ finished: true, state: "failed", failedStage: "Test", failedStep: "Run pytest", tests: { failed: 2, total: 148 } });
  });

  it("log: the failed step by default, readable, with the step's place in the tree", async () => {
    const w = world(baseRoutes(build(2046, { result: "failed" })));
    const r = await json(["pipeline", "log", "--run", "2046"], w);
    expect(r.step).toMatchObject({ id: "tT2", name: "Run pytest", stage: "Test", job: "Job pytest", state: "failed", durationSeconds: 171 });
    expect(r.final).toBe(true);
    expect(r.totalLines).toBe(4);
    expect(r.firstError).toMatchObject({ n: 2, file: "notebooks/test_orders.py", line: 41 });
    expect(r.lines[2].links).toEqual([{ file: "notebooks/test_orders.py", line: 41, start: 0, end: 27 }]);
  });

  it("log --step by name, and --from-line reads only the new part", async () => {
    const w = world(baseRoutes(build(2046)));
    const r = await json(["pipeline", "log", "--run", "2046", "--step", "run pytest", "--from-line", "3"], w);
    expect(r.lines[0].n).toBe(3);
    expect(w.f.calls.find((c) => /logs\/9/.test(c.url))!.url).toContain("startLine=3");
    const bad = world(baseRoutes(build(2046)));
    expect(await main(["pipeline", "log", "--run", "2046", "--step", "nope"], bad.ctx, commands)).toBe(1);
    expect(bad.errs.join("\n")).toContain("no step 'nope'");
  });
});

describe("aihub pipeline run-again", () => {
  it("--plan: parameters with types, variables, stages that may be skipped, the newer commit", async () => {
    const b = build(2046, { result: "failed", templateParameters: { runIntegration: "false", pythonVersion: "3.11", environment: "dev" } });
    const w = world(baseRoutes(b));
    const r = await json(["pipeline", "run-again", "--run", "2046", "--plan"], w);
    expect(r.run).toMatchObject({ id: 2046, branch: "feature/4711-orderexport", commit: { short: "3f9a2c1", message: "Guard empty customer number" } });
    expect(r.latestCommit).toMatchObject({ short: "8b1d7e0", message: "Fix amount filter", newerCount: 1 });
    expect(r.parameters.map((p: any) => [p.name, p.type, p.value])).toEqual([
      ["runIntegration", "boolean", "false"],
      ["pythonVersion", "string", "3.11"],
      ["environment", "string", "dev"],
    ]);
    expect(r.stages.map((s: any) => [s.identifier, s.name, s.canSkip])).toEqual([
      ["Build", "Build", false],
      ["Test", "Test", false],
      ["DeployDev", "Deploy dev", true],
    ]);
    expect(r.dependencySource).toBe("yaml");
    expect(w.f.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("queues a new run with the changes, the same commit and a skipped stage; a secret only when filled in", async () => {
    const b = build(2046, { result: "failed", templateParameters: { runIntegration: "false", pythonVersion: "3.11", environment: "dev" } });
    const w = world([...baseRoutes(b), { method: "POST", match: /pipelines\/7\/runs\?/, respond: () => ({ body: { id: 2050, name: "20261126.2050" } }) }]);
    const f = join(tmp(), "changes.json");
    write(join(f, ".."), "changes.json", JSON.stringify({ parameters: { runIntegration: true }, variables: { debugLogging: "true", DB_PASSWORD: null }, skipStages: ["DeployDev"] }));
    const r = await json(["pipeline", "run-again", "--run", "2046", "--changes-file", f], w);
    expect(r).toEqual({
      id: 2050,
      number: "20261126.2050",
      pipeline: "orders-ci",
      branch: "feature/4711-orderexport",
      commit: "3f9a2c1".padEnd(40, "0"),
      skipped: ["DeployDev"],
      changed: { parameters: ["runIntegration"], variables: ["debugLogging"] },
      webUrl: "https://dev.azure.com/ferron-org/test-project/_build/results?buildId=2050",
    });
    const post = w.f.calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({
      resources: { repositories: { self: { refName: "refs/heads/feature/4711-orderexport", version: "3f9a2c1".padEnd(40, "0") } } },
      templateParameters: { runIntegration: "true", pythonVersion: "3.11", environment: "dev" },
      variables: { BuildConfiguration: { value: "release" }, debugLogging: { value: "true" } },
      stagesToSkip: ["DeployDev"],
    });
  });

  it("--commit latest takes the head of the branch; a stage others depend on is refused before anything is queued", async () => {
    const b = build(2046, { result: "failed" });
    const w = world([...baseRoutes(b), { method: "POST", match: /pipelines\/7\/runs\?/, respond: () => ({ body: { id: 2051 } }) }]);
    const r = await json(["pipeline", "run-again", "--run", "2046", "--commit", "latest"], w);
    expect(r.commit).toBe("8b1d7e0".padEnd(40, "0"));
    const w2 = world(baseRoutes(b));
    const f = join(tmp(), "c.json");
    write(join(f, ".."), "c.json", JSON.stringify({ skipStages: ["Test"] }));
    expect(await main(["pipeline", "run-again", "--run", "2046", "--changes-file", f], w2.ctx, commands)).toBe(1);
    expect(w2.errs.join("\n")).toContain("stage Test cannot be skipped: DeployDev depends on it");
    expect(w2.f.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("retry --json carries the web URL", async () => {
    const w = world([
      { match: /build\/builds\/2046\/timeline/, respond: () => ({ body: { records: TL } }) },
      { method: "PATCH", match: /build\/builds\/2046\/stages\/Test/, respond: () => ({ body: {} }) },
    ]);
    const r = await json(["pipeline", "retry", "--run", "2046", "--json"], w);
    expect(r).toEqual({ run: 2046, retried: ["Test"], webUrl: "https://dev.azure.com/ferron-org/test-project/_build/results?buildId=2046" });
  });
});
