import { describe, expect, it } from "vitest";
import { commands, main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, type Route } from "./helpers.js";

const build = (id: number, status: string, result?: string, extra: object = {}) => ({
  id,
  buildNumber: `20260101.${id}`,
  status,
  result,
  sourceBranch: "refs/pull/5/merge",
  reason: "pullRequest",
  queueTime: "2026-01-01T10:00:00Z",
  definition: { id: 3, name: "test-project-ci" },
  ...extra,
});

const TIMELINE = {
  records: [
    { id: "s1", type: "Stage", name: "Test", order: 1 },
    { id: "j1", parentId: "s1", type: "Job", name: "Unit", order: 1 },
    { id: "t1", parentId: "j1", type: "Task", name: "Checkout", result: "succeeded", order: 1, log: { id: 1 } },
    { id: "t2", parentId: "j1", type: "Task", name: "Run tests", result: "failed", order: 2, log: { id: 2 } },
  ],
};
const LOG2 = "2026-01-01T10:01:00.0000000Z starting\n2026-01-01T10:01:02.0000000Z FAILED test_export\n2026-01-01T10:01:03.0000000Z ##[error]Bash exited with code 1\n";

const B = "/ferron-org/test-project/_apis/";
const routes = (seq: object[][]): { routes: Route[]; polls: () => number } => {
  let n = 0;
  return {
    polls: () => n,
    routes: [
      { match: /pullrequests\/5\?/, respond: () => ({ body: { pullRequestId: 5, status: "active", sourceRefName: "refs/heads/feature/5-x", targetRefName: "refs/heads/main" } }) },
      { match: /build\/builds\?.*branchName=refs%2Fpull%2F5%2Fmerge/, respond: () => ({ body: { value: seq[Math.min(n++, seq.length - 1)] } }) },
      { match: /build\/builds\/12\/timeline/, respond: () => ({ body: TIMELINE }) },
      { match: /build\/builds\/12\/logs\/2/, respond: () => ({ text: LOG2 }) },
      { match: /build\/builds\/12\/logs\/1/, respond: () => ({ text: "checkout ok\n" }) },
      { match: /build\/builds\/12\?/, respond: () => ({ body: build(12, "completed", "failed") }) },
      { match: /build\/definitions\?/, respond: () => ({ body: { value: [{ id: 3, name: "test-project-ci" }] } }) },
    ],
  };
};

function ctxWith(r: Route[]) {
  const { dir } = makeRepo();
  const f = fakeFetch(r);
  const c = ctxFor(dir, f.fn);
  let t = 0;
  c.ctx.now = () => (t += 1000);
  c.ctx.sleep = async () => {};
  return { ...c, f, dir };
}

describe("pipeline follow/status", () => {
  it("prints status changes until done and then the failing step with a log excerpt", async () => {
    const r = routes([[build(12, "notStarted")], [build(12, "inProgress")], [build(12, "completed", "failed")]]);
    const { ctx, lines, errs } = ctxWith(r.routes);
    const code = await main(["pipeline", "follow", "--pr", "5"], ctx, commands);
    const out = lines.join("\n");
    expect(code).toBe(1);
    expect(out).toMatch(/test-project-ci #20260101\.12 \(run 12\): notStarted/);
    expect(out).toMatch(/: inProgress/);
    expect(out).toMatch(/: failed/);
    expect(out).toContain("failed: Test / Run tests");
    expect(out).toContain(">> FAILED test_export");
    expect(out).toContain(">> ##[error]Bash exited with code 1");
    expect(out).not.toContain("2026-01-01T10:01");
    expect(errs.join("\n")).toContain("1 of 1 pipeline run(s) did not succeed");
  });

  it("green run ends with code 0; timeout is reported", async () => {
    const ok = ctxWith(routes([[build(13, "completed", "succeeded")]]).routes);
    expect(await main(["pipeline", "follow", "--pr", "5"], ok.ctx, commands)).toBe(0);
    expect(ok.lines.join("\n")).toContain("all 1 pipeline run(s) finished green");
    const slow = ctxWith(routes([[build(14, "inProgress")]]).routes);
    expect(await main(["pipeline", "follow", "--pr", "5", "--timeout", "5s"], slow.ctx, commands)).toBe(1);
    expect(slow.errs.join("\n")).toContain("timeout after 5s");
  });

  it("status is a one-shot snapshot with the failed step", async () => {
    const { ctx, lines } = ctxWith(routes([[build(12, "completed", "failed")]]).routes);
    expect(await main(["pipeline", "status", "--pr", "5"], ctx, commands)).toBe(0);
    expect(lines.join("\n")).toMatch(/PR !5\n {2}test-project-ci #20260101\.12 \(run 12\): failed\n {4}failed: Test \/ Run tests/);
  });
});

describe("pipeline runs/logs/run", () => {
  it("lists runs", async () => {
    const { ctx, lines } = ctxWith(routes([[build(12, "completed", "failed"), build(11, "completed", "succeeded")]]).routes);
    expect(await main(["pipeline", "runs", "--pr", "5", "--top", "5"], ctx, commands)).toBe(0);
    expect(lines.join("\n")).toMatch(/12 +failed +pull\/5\/merge +2026-01-01 10:00 +pullRequest +test-project-ci/);
    expect(lines.join("\n")).toMatch(/11 +succeeded/);
  });

  it("logs: failing steps first with highlighted errors; search and step filters", async () => {
    const { ctx, lines } = ctxWith(routes([[]]).routes);
    expect(await main(["pipeline", "logs", "--run", "12", "--tail", "2"], ctx, commands)).toBe(0);
    let out = lines.join("\n");
    expect(out).toContain("== Run tests [failed] last 2 lines");
    expect(out).toContain(">> ##[error]Bash exited with code 1");
    expect(out).not.toContain("Checkout");
    lines.length = 0;
    await main(["pipeline", "logs", "--run", "12", "--search", "test_export"], ctx, commands);
    out = lines.join("\n");
    expect(out).toContain("== Run tests [failed] 1 match(es)");
    expect(out).toMatch(/ 2: FAILED test_export/);
    lines.length = 0;
    await main(["pipeline", "logs", "--run", "12", "--step", "checkout"], ctx, commands);
    expect(lines.join("\n")).toContain("checkout ok");
  });

  it("queues a run with parameters from a file", async () => {
    const r = routes([[]]);
    r.routes.push({ method: "POST", match: /build\/builds\?/, respond: () => ({ body: { id: 99 } }) });
    const { ctx, lines, f, dir } = ctxWith(r.routes);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${dir}/p.yaml`, "env: test\nretries: 2\n");
    expect(await main(["pipeline", "run", "--name", "test-project-ci", "--branch", "feature/5-x", "--params-file", `${dir}/p.yaml`], ctx, commands)).toBe(0);
    expect(lines[0]).toBe("queued test-project-ci on feature/5-x: run 99");
    const post = f.calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ definition: { id: 3 }, sourceBranch: "refs/heads/feature/5-x", templateParameters: { env: "test", retries: "2" } });
  });
});

void B;
