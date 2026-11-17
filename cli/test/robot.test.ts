import { describe, expect, it } from "vitest";
import { robotConfig, robotNeeded } from "../src/lib/robot.js";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, sh, write } from "./helpers.js";

const TEAM = `version: 1
repositories:
  - name: test-repo
    defaultTarget: main
robot:
  pipeline: test-project-robot
  integrationBranch: integration
  suites:
    - name: orders
      paths: ["src/flows/orders/**"]
      tests: ["tests/robot/orders/**"]
    - name: customers
      paths: ["src/flows/customers/**"]
`;

function repoWithChanges(files: string[]): string {
  const { dir } = makeRepo();
  write(dir, ".agents/skills/_shared/references/team.yaml", TEAM);
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "team"]);
  sh(dir, ["push", "origin", "main"]);
  sh(dir, ["checkout", "-b", "feature/7-x"]);
  for (const f of files) write(dir, f, "x\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "change"]);
  return dir;
}

describe("robotNeeded", () => {
  const cfg = robotConfig({ robot: { suites: [{ name: "orders", paths: ["src/flows/orders/**"], tests: ["tests/robot/orders/**"] }] } } as any);
  it("needs a suite when a flow file changed, and flags a missing test change", () => {
    expect(robotNeeded(["src/flows/orders/a.py"], cfg)).toEqual([{ suite: "orders", flowFiles: ["src/flows/orders/a.py"], testFiles: [] }]);
    expect(robotNeeded(["src/flows/orders/a.py", "tests/robot/orders/o.robot"], cfg)[0].testFiles).toEqual(["tests/robot/orders/o.robot"]);
  });
  it("needs nothing for unrelated files", () => {
    expect(robotNeeded(["docs/a.md"], cfg)).toEqual([]);
  });
});

describe("aihub robot needed", () => {
  it("lists the suite and warns that no test changed", async () => {
    const dir = repoWithChanges(["src/flows/orders/load.py", "docs/a.md"]);
    const { ctx, lines } = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(["robot", "needed"], ctx)).toBe(0);
    expect(lines[0]).toBe(
      [
        "robot: needed for feature/7-x: 1 suite",
        "- orders: 1 flow file; no Robot test changed: a new or changed flow needs a new or adjusted test",
        "run: aihub robot run --suite orders",
      ].join("\n"),
    );
  });

  it("says not needed for a change outside the flows", async () => {
    const dir = repoWithChanges(["docs/a.md"]);
    const { ctx, lines } = ctxFor(dir, fakeFetch([]).fn);
    await main(["robot", "needed"], ctx);
    expect(lines[0]).toContain("not needed");
  });
});

const BASE = "/ferron-org/test-project/_apis";
function adoRoutes(builds: any[]) {
  let polls = 0;
  return fakeFetch([
    { match: new RegExp(BASE + "/build/definitions\\?"), respond: () => ({ body: { value: [{ id: 77, name: "test-project-robot" }] } }) },
    { method: "POST", match: new RegExp(BASE + "/build/builds\\?"), respond: () => ({ body: { id: 501, status: "notStarted" } }) },
    { match: new RegExp(BASE + "/build/builds/501\\?"), respond: () => ({ body: builds[Math.min(polls++, builds.length - 1)] }) },
    { match: new RegExp(BASE + "/test/runs\\?"), respond: () => ({ body: { value: [{ name: "Robot orders", totalTests: 12, passedTests: 11 }] } }) },
    {
      match: new RegExp(BASE + "/build/builds/501/timeline\\?"),
      respond: () => ({
        body: { records: [{ name: "Run Robot", type: "Task", result: "failed", issues: [{ type: "error", message: "orders.Create order FAILED" }] }, { name: "Job", type: "Job", result: "failed" }] },
      }),
    },
  ]);
}

describe("aihub robot run", () => {
  it("queues the team pipeline on the integration branch with parameters, follows it and summarizes", async () => {
    const dir = repoWithChanges(["src/flows/orders/load.py"]);
    const { fn, calls } = adoRoutes([{ id: 501, status: "inProgress" }, { id: 501, status: "completed", result: "failed", buildNumber: "20260101.1" }]);
    const { ctx, lines, errs } = ctxFor(dir, fn);
    ctx.env = { AIHUB_ADO_PAT: "synthetic-pat", AIHUB_POLL_MS: "0" };
    expect(await main(["robot", "run", "--suite", "orders", "--include", "smoke"], ctx)).toBe(1);
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ definition: { id: 77 }, sourceBranch: "refs/heads/integration", templateParameters: { suite: "orders", include: "smoke" } });
    expect(lines[0]).toBe("queued test-project-robot build 501 on integration (suite orders) (include smoke)");
    expect(lines[1]).toContain("build 20260101.1: failed");
    expect(lines[1]).toContain("tests Robot orders: 11/12 passed, 1 failed");
    expect(lines[1]).toContain("failed: Run Robot: orders.Create order FAILED");
    expect(lines[1]).not.toContain("failed: Job");
    expect(errs[0]).toContain("ended as failed");
  });

  it("exits 0 on a succeeded build and --pipeline overrides the team pipeline", async () => {
    const dir = repoWithChanges(["x.txt"]);
    const { fn } = adoRoutes([{ id: 501, status: "completed", result: "succeeded", buildNumber: "1" }]);
    const { ctx, lines } = ctxFor(dir, fn);
    ctx.env = { AIHUB_ADO_PAT: "synthetic-pat", AIHUB_POLL_MS: "0" };
    expect(await main(["robot", "run", "--pipeline", "test-project-robot"], ctx)).toBe(0);
    expect(lines[1]).toContain("build 1: succeeded");
  });

  it("rejects an unknown suite and a missing pipeline name", async () => {
    const dir = repoWithChanges(["x.txt"]);
    const { fn } = adoRoutes([]);
    const a = ctxFor(dir, fn);
    expect(await main(["robot", "run", "--suite", "nope"], a.ctx)).toBe(1);
    expect(a.errs[0]).toContain("unknown suite 'nope'");
    const b = ctxFor(dir, fakeFetch([{ match: /build\/definitions/, respond: () => ({ body: { value: [] } }) }]).fn);
    expect(await main(["robot", "run"], b.ctx)).toBe(1);
    expect(b.errs[0]).toContain("not found in Azure DevOps");
  });
});
