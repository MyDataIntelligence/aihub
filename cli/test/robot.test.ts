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
    expect(await main(["robot", "run", "--no-merge", "--suite", "orders", "--include", "smoke"], ctx)).toBe(1);
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
    expect(await main(["robot", "run", "--no-merge", "--pipeline", "test-project-robot"], ctx)).toBe(0);
    expect(lines[1]).toContain("build 1: succeeded");
  });

  it("rejects an unknown suite and a missing pipeline name", async () => {
    const dir = repoWithChanges(["x.txt"]);
    const { fn } = adoRoutes([]);
    const a = ctxFor(dir, fn);
    expect(await main(["robot", "run", "--suite", "nope"], a.ctx)).toBe(1);
    expect(a.errs[0]).toContain("unknown suite 'nope'");
    const b = ctxFor(dir, fakeFetch([{ match: /build\/definitions/, respond: () => ({ body: { value: [] } }) }]).fn);
    expect(await main(["robot", "run", "--no-merge"], b.ctx)).toBe(1);
    expect(b.errs[0]).toContain("not found in Azure DevOps");
  });
});

// ---- integration merge -------------------------------------------------------

function mergeRepo(team: string) {
  const { dir, bare } = makeRepo();
  sh(dir, ["config", "user.name", "Test"]);
  sh(dir, ["config", "user.email", "test@example.com"]);
  write(dir, ".agents/skills/_shared/references/team.yaml", team);
  write(dir, "flow.txt", "base\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "team"]);
  sh(dir, ["push", "origin", "main"]);
  for (const b of ["integration", "staging"]) sh(dir, ["push", "origin", `main:refs/heads/${b}`]);
  sh(dir, ["checkout", "-b", "feature/7-x"]);
  return { dir, bare };
}

function onBranch(dir: string, branch: string, file: string, content: string, msg: string) {
  const cur = sh(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  sh(dir, ["checkout", branch]);
  write(dir, file, content);
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", msg]);
  sh(dir, ["push", "origin", branch]);
  sh(dir, ["checkout", cur]);
}

const subjects = (bare: string, ref: string) => sh(bare, ["log", ref, "--no-merges", "--format=%s"]).split("\n");
const run = (dir: string) => {
  const { fn, calls } = adoRoutes([{ id: 501, status: "completed", result: "succeeded", buildNumber: "1" }]);
  const r = ctxFor(dir, fn);
  r.ctx.env = { AIHUB_ADO_PAT: "synthetic-pat", AIHUB_POLL_MS: "0" };
  return { ...r, calls };
};

describe("aihub robot run merges the feature branch first", () => {
  it("merges into the integration branch in a temp worktree, pushes, lists the commits, then queues", async () => {
    const { dir, bare } = mergeRepo(TEAM);
    write(dir, "src/flows/orders/load.py", "x\n");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "add orders load"]);
    const { ctx, lines, calls, errs } = run(dir);
    expect(await main(["robot", "run", "--suite", "orders"], ctx)).toBe(0);
    expect(errs).toEqual([]);
    const all = lines.join("\n").split("\n");
    expect(all[0]).toBe("merged feature/7-x into integration and pushed it; 1 commit went in:");
    expect(all[1]).toMatch(/^ {2}[0-9a-f]+ add orders load$/);
    expect(all[2]).toContain("queued test-project-robot build 501 on integration");
    expect(subjects(bare, "integration")).toContain("add orders load");
    expect(sh(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/7-x");
    expect(sh(dir, ["worktree", "list"]).split("\n")).toHaveLength(1);
    expect(sh(dir, ["status", "--porcelain"])).toBe("");
    expect(calls.some((c) => c.method === "POST")).toBe(true);
  });

  it("says so and pushes nothing when the integration branch already has the feature", async () => {
    const { dir } = mergeRepo(TEAM);
    const { ctx, lines } = run(dir);
    expect(await main(["robot", "run"], ctx)).toBe(0);
    expect(lines[0]).toBe("integration already contains feature/7-x: nothing to merge");
  });

  it("stops on a conflict: reports the files, pushes nothing, queues nothing", async () => {
    const { dir, bare } = mergeRepo(TEAM);
    onBranch(dir, "integration", "flow.txt", "from integration\n", "integration change");
    write(dir, "flow.txt", "from feature\n");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "feature change"]);
    const before = sh(bare, ["rev-parse", "integration"]);
    const { ctx, errs, calls } = run(dir);
    expect(await main(["robot", "run"], ctx)).toBe(1);
    expect(errs[0]).toContain("merge conflict merging feature/7-x into integration in: flow.txt");
    expect(errs[0]).toContain("nothing was pushed");
    expect(sh(bare, ["rev-parse", "integration"])).toBe(before);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(sh(dir, ["worktree", "list"]).split("\n")).toHaveLength(1);
  });

  it("merges a required branch that is behind (staging) before the feature", async () => {
    const { dir, bare } = mergeRepo(TEAM.replace("  integrationBranch: integration", "  integrationBranch: integration\n  integrationRequires: [staging]").replace("robot:\n  pipeline", "robot:\n  pipeline"));
    onBranch(dir, "staging", "staged.txt", "s\n", "staging change");
    write(dir, "feat.txt", "f\n");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "feature change"]);
    const { ctx, lines } = run(dir);
    expect(await main(["robot", "run"], ctx)).toBe(0);
    expect(lines[0]).toContain("merged staging, feature/7-x into integration");
    expect(lines[0]).toContain("2 commits");
    expect(subjects(bare, "integration")).toEqual(expect.arrayContaining(["staging change", "feature change"]));
  });

  it("uses the per-repository integration branch", async () => {
    const team = TEAM.replace("  integrationBranch: integration\n", "  integrationBranches:\n    - { repository: other-repo, branch: nope }\n    - { repository: test-repo, branch: integration, requires: [staging] }\n");
    const { dir, bare } = mergeRepo(team);
    onBranch(dir, "staging", "staged.txt", "s\n", "staging change");
    const { ctx, lines } = run(dir);
    expect(await main(["robot", "run"], ctx)).toBe(0);
    expect(lines[0]).toContain("merged staging into integration");
    expect(subjects(bare, "integration")).toContain("staging change");
  });

  it("--no-merge skips the merge", async () => {
    const { dir, bare } = mergeRepo(TEAM);
    write(dir, "feat.txt", "f\n");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "feature change"]);
    const { ctx, lines } = run(dir);
    expect(await main(["robot", "run", "--no-merge"], ctx)).toBe(0);
    expect(lines[0]).toContain("queued");
    expect(subjects(bare, "integration")).not.toContain("feature change");
  });
});

describe("robot targets", () => {
  const TARGETS = TEAM.replace(
    "  integrationBranch: integration\n",
    [
      "  defaultTarget: feature",
      "  targets:",
      "    feature: { branch: integration, mergeMyBranchFirst: true, mustAlreadyContain: [staging] }",
      "    staging: { branch: staging, mergeMyBranchFirst: false }",
      "",
    ].join("\n"),
  );

  it("lists the targets with their meaning and the default", async () => {
    const { dir } = mergeRepo(TARGETS);
    const { ctx, lines } = run(dir);
    expect(await main(["robot", "targets"], ctx)).toBe(0);
    expect(lines[0]).toBe(
      [
        "robot targets:",
        "- feature -> integration (merges the feature branch first; must already contain staging) [default]",
        "- staging -> staging (runs the branch as is)",
        "use: aihub robot run --on <name|branch>",
      ].join("\n"),
    );
  });

  it("the default target merges first; --on staging runs staging as is without touching any branch", async () => {
    const { dir, bare } = mergeRepo(TARGETS);
    write(dir, "feat.txt", "f\n");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "feature change"]);
    const stagingBefore = sh(bare, ["rev-parse", "staging"]);
    const a = run(dir);
    expect(await main(["robot", "run", "--on", "staging"], a.ctx)).toBe(0);
    expect(a.lines[0]).toContain("queued test-project-robot build 501 on staging");
    expect(sh(bare, ["rev-parse", "staging"])).toBe(stagingBefore);
    expect(subjects(bare, "integration")).not.toContain("feature change");
    expect(JSON.stringify(a.calls.find((c) => c.method === "POST")!.body)).toContain("refs/heads/staging");

    const b = run(dir);
    expect(await main(["robot", "run"], b.ctx)).toBe(0);
    expect(b.lines.join("\n")).toContain("merged feature/7-x into integration");
    expect(subjects(bare, "integration")).toContain("feature change");
  });

  it("--on <target name> uses that target; an unknown name is taken as a plain branch", async () => {
    const { dir, bare } = mergeRepo(TARGETS);
    write(dir, "feat.txt", "f\n");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "feature change"]);
    const a = run(dir);
    expect(await main(["robot", "run", "--on", "feature"], a.ctx)).toBe(0);
    expect(subjects(bare, "integration")).toContain("feature change");
    const b = run(dir);
    expect(await main(["robot", "run", "--on", "release/1.0"], b.ctx)).toBe(0);
    expect(b.lines[0]).toContain("on release/1.0");
  });
});
