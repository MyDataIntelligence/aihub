import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, type Route } from "./helpers.js";

const NL = String.fromCharCode(10);
const build = (id: number, extra: object = {}) => ({ id, buildNumber: `2026.${id}`, status: "completed", result: "failed", sourceBranch: "refs/heads/feat/x", sourceVersion: `${id}`.repeat(40).slice(0, 40), queueTime: "2026-11-18T10:00:00Z", startTime: "2026-11-18T10:00:10Z", finishTime: "2026-11-18T10:05:10Z", definition: { id: 5, name: "ci" }, ...extra });

const rec = (id: string, parentId: string | null, type: string, name: string, result: string, start: string, finish: string, extra: object = {}) => ({ id, parentId, type, name, state: "completed", result, startTime: `2026-11-18T10:${start}Z`, finishTime: `2026-11-18T10:${finish}Z`, order: Number(id.replace(/\D/g, "")) || 1, ...extra });

describe("aihub pipeline timeline", () => {
  it("shows stages and jobs with duration, the failing task with its error, and retries", async () => {
    const { dir } = makeRepo();
    const records = [
      rec("s1", null, "Stage", "Build", "succeeded", "00:10", "02:10"),
      rec("j1", "s1", "Job", "compile", "succeeded", "00:10", "02:00"),
      rec("t1", "j1", "Task", "Checkout", "succeeded", "00:10", "00:20"),
      rec("s2", null, "Stage", "Test", "failed", "02:10", "05:10", { attempt: 2, previousAttempts: [{ attempt: 1 }] }),
      rec("j2", "s2", "Job", "pytest", "failed", "02:10", "05:00"),
      rec("t2", "j2", "Task", "Run pytest", "failed", "02:20", "04:50", { issues: [{ type: "error", message: "Bash exited with code 1" }, { type: "warning", message: "deprecated" }] }),
    ];
    const r: Route[] = [
      { match: /_apis\/build\/builds\/21\/timeline\?/, respond: () => ({ body: { records } }) },
      { match: /_apis\/build\/builds\/21\?/, respond: () => ({ body: build(21) }) },
    ];
    const { ctx, lines } = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["pipeline", "timeline", "--run", "21"], ctx)).toBe(0);
    const out = lines.join(NL);
    expect(out).toContain("run 21 ci 2026.21: failed 5m00s on feat/x");
    expect(out).toContain("stage Build succeeded 2m00s");
    expect(out).toContain("  job compile succeeded 1m50s");
    expect(out).toContain("stage Test failed 3m00s (attempt 2, 1 earlier)");
    expect(out).toContain("    task Run pytest failed 2m30s");
    expect(out).toContain("error: Bash exited with code 1");
    expect(out).not.toContain("Checkout");
    expect(out).not.toContain("deprecated");
  });
});

describe("aihub pipeline tests, coverage, vars, compare", () => {
  it("lists failed tests with message and stack head, and marks an intermittent one against earlier runs", async () => {
    const { dir } = makeRepo();
    const r: Route[] = [
      { match: /_apis\/build\/builds\/21\?/, respond: () => ({ body: build(21) }) },
      { match: /_apis\/build\/builds\?/, respond: () => ({ body: { value: [build(21), build(20, { result: "succeeded" }), build(19)] } }) },
      { match: /_apis\/test\/runs\?buildUri=vstfs%3A%2F%2F%2FBuild%2FBuild%2F21/, respond: () => ({ body: { value: [{ id: 100, name: "pytest", totalTests: 40, passedTests: 38 }] } }) },
      { match: /_apis\/test\/runs\?buildUri=vstfs%3A%2F%2F%2FBuild%2FBuild%2F20/, respond: () => ({ body: { value: [{ id: 90, name: "pytest" }] } }) },
      { match: /_apis\/test\/runs\?buildUri=vstfs%3A%2F%2F%2FBuild%2FBuild%2F19/, respond: () => ({ body: { value: [{ id: 80, name: "pytest" }] } }) },
      { match: /_apis\/test\/runs\/100\/results\?/, respond: () => ({ body: { value: [{ id: 1, automatedTestName: "tests.test_a::test_totals", errorMessage: "assert 3 == 4", stackTrace: "line1\nline2\nline3\nline4" }, { id: 2, automatedTestName: "tests.test_b::test_new", errorMessage: "boom" }] } }) },
      { match: /_apis\/test\/runs\/90\/results\?/, respond: () => ({ body: { value: [] } }) },
      { match: /_apis\/test\/runs\/80\/results\?/, respond: () => ({ body: { value: [{ id: 9, automatedTestName: "tests.test_a::test_totals" }] } }) },
    ];
    const { ctx, lines } = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["pipeline", "tests", "--run", "21", "--history", "2"], ctx)).toBe(0);
    const out = lines.join(NL);
    expect(out).toContain("run 21: 1 test run(s), 40 test(s), 38 passed, 2 failed");
    expect(out).toContain("FAILED tests.test_a::test_totals  [intermittent: failed in 1 of 2 previous runs]");
    expect(out).toContain("assert 3 == 4");
    expect(out).toContain("at line1 | line2 | line3");
    expect(out).not.toContain("line4");
    expect(out).toContain("FAILED tests.test_b::test_new  [new]");
  });

  it("shows coverage, resolved variables with secrets hidden, and compares two runs", async () => {
    const { dir } = makeRepo();
    const r: Route[] = [
      { match: /_apis\/test\/codecoverage\?/, respond: () => ({ body: { coverageData: [{ coverageStats: [{ label: "Lines", covered: 90, total: 120 }, { label: "Branches", covered: 5, total: 10 }] }] } }) },
      { match: /_apis\/build\/definitions\/5\?/, respond: () => ({ body: { variables: { A: { value: "1" }, TOKEN: { isSecret: true } }, variableGroups: [{ id: 3, name: "vg-dev" }] } }) },
      { match: /_apis\/build\/builds\/21\/timeline\?/, respond: () => ({ body: { records: [rec("s1", null, "Stage", "Test", "failed", "00:00", "05:00")] } }) },
      { match: /_apis\/build\/builds\/20\/timeline\?/, respond: () => ({ body: { records: [rec("s1", null, "Stage", "Test", "succeeded", "00:00", "03:00")] } }) },
      { match: /_apis\/build\/builds\/21\?/, respond: () => ({ body: build(21, { parameters: JSON.stringify({ env: "dev", apiKey: "SECRETVALUE" }), reason: "manual", requestedFor: { displayName: "Ann" } }) }) },
      { match: /_apis\/build\/builds\/20\?/, respond: () => ({ body: build(20, { result: "succeeded", parameters: JSON.stringify({ env: "test", apiKey: "SECRETVALUE" }) }) }) },
      { match: /repositories\/test-repo\/commits\?/, respond: () => ({ body: { value: [{ commitId: "abcdef1234", comment: "Fix totals" }] } }) },
    ];
    const cv = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["pipeline", "coverage", "--run", "21"], cv.ctx)).toBe(0);
    expect(cv.lines.join(NL)).toMatch(/Lines\s+90\s+120\s+75/);
    const va = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["pipeline", "vars", "--run", "21"], va.ctx)).toBe(0);
    const v = va.lines.join(NL);
    expect(v).toContain("TOKEN = *** (secret)");
    expect(v).toContain("A = 1");
    expect(v).toContain("queue-time env = dev");
    expect(v).toContain("queue-time apiKey = ***");
    expect(v).not.toContain("SECRETVALUE");
    expect(v).toContain("variable groups: vg-dev");
    const cp = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["pipeline", "compare", "--run", "20", "--with", "21"], cp.ctx)).toBe(0);
    const c = cp.lines.join(NL);
    expect(c).toContain("abcdef12 Fix totals");
    expect(c).toContain("env: test -> dev");
    expect(c).toMatch(/Test\s+succeeded 3m00s\s+failed 5m00s\s+\+120s/);
  });
});

describe("aihub pipeline triggers, schedules, expand, authorize", () => {
  const yaml = ["trigger:", "  branches:", "    include: [main, release/*]", "pr:", "  - main", "schedules:", "- cron: '0 3 * * *'", "  branches:", "    include: [main]", "  always: true", "resources:", "  repositories:", "  - repository: tpl", "parameters:", "- name: env", "  default: dev", "steps:", "- script: echo"].join(NL);
  const def = { id: 5, name: "ci", process: { type: 2, yamlFilename: "ci/ci.yml" }, repository: { id: "repo-guid", type: "TfsGit", defaultBranch: "refs/heads/main" }, triggers: [] };

  it("shows triggers, schedules, resources and parameters from the YAML, and lists scheduled pipelines", async () => {
    const { dir } = makeRepo();
    const r: Route[] = [
      { match: /_apis\/build\/definitions\/5\?/, respond: () => ({ body: def }) },
      { match: /_apis\/build\/definitions\?/, respond: () => ({ body: { value: [def] } }) },
      { match: /repositories\/repo-guid\/items\?/, respond: () => ({ text: yaml }) },
    ];
    const t = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["pipeline", "trigger", "show", "--pipeline", "ci"], t.ctx)).toBe(0);
    const o = t.lines.join(NL);
    expect(o).toContain('"include":["main","release/*"]');
    expect(o).toContain('pr trigger: {"branches":{"include":["main"]}}');
    expect(o).toContain("0 3 * * * on main (always)");
    expect(o).toContain("repos tpl");
    expect(o).toContain("parameters: env = \"dev\"");
    const s = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["pipeline", "schedule", "list"], s.ctx)).toBe(0);
    expect(s.lines.join(NL)).toMatch(/5\s+ci\s+yaml\s+0 3 \* \* \* on main \(always\)/);
  });

  it("validates a local file against the pipeline that runs it, expands it, and checks required templates from team.yaml", async () => {
    const { dir } = makeRepo();
    mkdirSync(join(dir, "ci"), { recursive: true });
    writeFileSync(join(dir, "ci/ci.yml"), "steps:\n- script: echo\n");
    mkdirSync(join(dir, ".agents/skills/_shared/references"), { recursive: true });
    writeFileSync(join(dir, ".agents/skills/_shared/references/team.yaml"), ["pipelines:", "  - repository: test-repo", "    name: ci", "    requiredTemplates: [templates/test.yml]"].join(NL));
    const bodies: any[] = [];
    const r: Route[] = [
      { match: /_apis\/git\/repositories\/test-repo\?/, respond: () => ({ body: { id: "repo-guid", name: "test-repo" } }) },
      { match: /_apis\/build\/definitions\?/, respond: () => ({ body: { value: [{ id: 9, name: "other", process: { yamlFilename: "x.yml" } }, def] } }) },
      { match: /_apis\/build\/definitions\/5\?/, respond: () => ({ body: def }) },
      { method: "POST", match: /_apis\/pipelines\/5\/runs\?/, respond: (c) => (bodies.push(c.body), { body: { finalYaml: "steps:\n- script: echo" } }) },
    ];
    const a = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["pipeline", "validate", "--file", join(dir, "ci/ci.yml")], a.ctx)).toBe(0);
    expect(bodies[0].yamlOverride).toContain("script: echo");
    expect(a.lines.join(NL)).toContain("missing templates/test.yml");
    const e = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["pipeline", "expand", "--file", join(dir, "ci/ci.yml")], e.ctx)).toBe(0);
    expect(e.lines.join(NL)).toContain("steps:" + NL + "- script: echo");
  });

  it("authorizes a pipeline for a dev environment and refuses a PRD one", async () => {
    const { dir } = makeRepo();
    const patched: any[] = [];
    const r: Route[] = [
      { match: /_apis\/build\/definitions\?/, respond: () => ({ body: { value: [def] } }) },
      { match: /pipelines\/environments\?/, respond: () => ({ body: { value: [{ id: 3, name: "dev" }] } }) },
      { method: "PATCH", match: /pipelinePermissions\/environment\/3\?/, respond: (c) => (patched.push(c.body), { body: {} }) },
    ];
    expect(await main(["pipeline", "authorize", "--pipeline", "ci", "--resource", "environment:dev"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(patched[0]).toEqual({ pipelines: [{ id: 5, authorized: true }] });
    const g = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["pipeline", "authorize", "--pipeline", "ci", "--resource", "environment:prd"], g.ctx)).toBe(1);
    expect(g.errs.join(NL)).toContain("is PRD");
  });
});
