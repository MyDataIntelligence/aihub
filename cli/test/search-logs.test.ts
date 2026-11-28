import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { browseOf } from "../src/lib/browse/core.js";
import { matchLines, runOrder, stepLogs, withoutStamp, writeCachedLog } from "../src/lib/logSearch.js";
import { parseKinds, searchAll } from "../src/lib/searchAll.js";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, tmp, type Route } from "./helpers.js";

const NOW = Date.parse("2026-11-28T10:00:00Z");

const rec = (id: string, type: string, name: string, parentId: string | null, extra: object = {}) => ({ id, type, name, parentId, ...extra });
const TIMELINE = [
  rec("s1", "Stage", "Test", null, { identifier: "Test" }),
  rec("j1", "Job", "pytest", "s1", { log: { id: 1 } }),
  rec("t1", "Task", "Checkout", "j1", { log: { id: 2 }, order: 1, result: "succeeded" }),
  rec("t2", "Task", "Run pytest", "j1", { log: { id: 3 }, order: 2, result: "failed" }),
];
const LOG_OK = "2026-11-27T10:00:00.0000000Z Syncing repository\n2026-11-27T10:00:01.0000000Z done";
const LOG_RED = "2026-11-27T10:00:02.1234567Z collected 3 items\n2026-11-27T10:00:03.1234567Z ##[error]KeyError: 'klantnummer' in orders\n2026-11-27T10:00:04.1234567Z FAILED tests/test_orders.py";

function setup() {
  const downloads: string[] = [];
  const routes: Route[] = [
    { match: /\/_apis\/connectionData/, respond: () => ({ body: { authenticatedUser: { id: "me" } } }) },
    { match: /^https:\/\/dev\.azure\.com\/ferron-test\/_apis\/projects\?/, respond: () => ({ body: { value: [{ id: "p1", name: "test-project" }] } }) },
    { match: /^https:\/\/dev\.azure\.com\/ferron-test\/_apis\/git\/repositories\?/, respond: () => ({ body: { value: [] } }) },
    {
      match: /test-project\/_apis\/build\/builds\?/,
      respond: (c) => {
        const failedOnly = new URL(c.url).searchParams.get("resultFilter");
        const all = [
          { id: 10, buildNumber: "20261127.1", result: "succeeded", finishTime: "2026-11-27T12:00:00Z", definition: { id: 5, name: "orders-ci" }, sourceBranch: "refs/heads/main" },
          { id: 9, buildNumber: "20261126.1", result: "failed", finishTime: "2026-11-26T12:00:00Z", definition: { id: 5, name: "orders-ci" }, sourceBranch: "refs/heads/feature/x" },
        ];
        return { body: { value: failedOnly ? all.filter((b) => b.result === "failed") : all } };
      },
    },
    { match: /\/build\/builds\/\d+\/timeline/, respond: () => ({ body: { records: TIMELINE } }) },
    {
      match: /\/build\/builds\/(\d+)\/logs\/(\d+)/,
      respond: (c) => {
        downloads.push(c.url);
        const [, run, log] = /builds\/(\d+)\/logs\/(\d+)/.exec(c.url)!;
        return { text: run === "9" && log === "3" ? LOG_RED : LOG_OK };
      },
    },
  ];
  const f = fakeFetch(routes);
  const { ctx, lines, errs } = ctxFor(tmp(), f.fn);
  ctx.env.AIHUB_ADO_ORG = "ferron-test";
  ctx.env.AIHUB_COMMON_ROOTS = "none";
  ctx.now = () => NOW;
  return { ctx, lines, errs, downloads, b: () => browseOf(ctx, {}) };
}

describe("log search: pieces", () => {
  it("drops the time stamp and marks every occurrence, any case", () => {
    expect(withoutStamp("2026-11-27T10:00:03.1234567Z ##[error]x")).toBe("##[error]x");
    expect(matchLines(LOG_RED, "KLANTNUMMER")).toEqual([{ line: 2, text: "##[error]KeyError: 'klantnummer' in orders", ranges: [[20, 31]] }]);
  });
  it("cuts a long line around the match and keeps the ranges right", () => {
    const [m] = matchLines(`${"x".repeat(500)} needle ${"y".repeat(500)}`, "needle");
    expect(m.text.startsWith("…")).toBe(true);
    expect(m.text.slice(m.ranges[0][0], m.ranges[0][1])).toBe("needle");
  });
  it("failed and partially succeeded runs first, then the newest", () => {
    const runs = [
      { id: 1, result: "succeeded", finishTime: "2026-11-27T00:00:00Z" },
      { id: 2, result: "failed", finishTime: "2026-11-20T00:00:00Z" },
      { id: 3, result: "partiallySucceeded", finishTime: "2026-11-25T00:00:00Z" },
    ];
    expect([...runs].sort(runOrder).map((r) => r.id)).toEqual([3, 2, 1]);
  });
  it("step logs only (not the job's), failed step first, with stage and job", () => {
    expect(stepLogs(TIMELINE as never).map((x) => [x.rec.name, x.stage, x.job])).toEqual([
      ["Run pytest", "Test", "pytest"],
      ["Checkout", "Test", "pytest"],
    ]);
  });
  it("the disk cache stays under its limit: the log used longest ago goes first", () => {
    const { ctx } = ctxFor(tmp(), fakeFetch([]).fn);
    const dir = join(ctx.env.AIHUB_CONFIG_HOME!, "cache", "logs");
    mkdirSync(dir, { recursive: true });
    const old = join(dir, "old.txt.gz");
    writeFileSync(old, Buffer.alloc(800));
    utimesSync(old, new Date(2020, 0, 1), new Date(2020, 0, 1));
    writeCachedLog(ctx.env, join(dir, "new.txt.gz"), "z".repeat(5000), 600);
    expect(existsSync(old)).toBe(false);
    expect(readdirSync(dir)).toEqual(["new.txt.gz"]);
  });
});

describe("log search: aihub search all --kinds logs", () => {
  it("is never part of the default kinds", () => {
    expect(parseKinds(undefined)).not.toContain("logs");
    expect(parseKinds("logs")).toEqual(["logs"]);
  });

  it("finds the error in the failed run, with pipeline, run, step and line; the second search reads the disk cache", async () => {
    const s = setup();
    const r1 = await searchAll(s.b(), { text: "klantnummer", kinds: ["logs"], top: 5 });
    const p1 = r1.kinds[0];
    expect(p1.status).toBe("ok");
    expect(p1.results).toHaveLength(1);
    expect(p1.results[0]).toMatchObject({ kind: "logs", title: "##[error]KeyError: 'klantnummer' in orders", run: 9, stepId: "t2", pipelineId: 5, line: 2, project: "test-project", branch: "feature/x", state: "failed" });
    expect(p1.results[0].detail).toBe("orders-ci · run 20261126.1 · Test / pytest / Run pytest · 2026-11-26 · failed");
    expect(p1.note).toMatch(/^searched 4 logs of 2 of 2 runs in the last 30 days, failed first$/);
    expect(p1.older).toBe(90);
    const first = s.downloads.length;
    expect(first).toBe(4);
    const r2 = await searchAll(s.b(), { text: "klantnummer", kinds: ["logs"], top: 5 });
    expect(s.downloads.length).toBe(first);
    expect(r2.kinds[0].note).toMatch(/4 from the cache/);
  });

  it("--failed only searches failed runs; --since and --max-logs bound the work", async () => {
    const s = setup();
    expect(await main(["search", "all", "orders", "--kinds", "logs", "--failed", "--since", "7d", "--max-logs", "1", "--json"], s.ctx)).toBe(0);
    const p = JSON.parse(s.lines.join("\n")).kinds[0];
    expect(p.note).toBe("searched 1 log of 1 of 1 run in the last 7 days (failed only)");
    expect(p.results.map((h: { run: number; line: number }) => [h.run, h.line])).toEqual([[9, 2], [9, 3]]);
    expect(s.downloads).toHaveLength(1);
  });

  it("asks for 3 characters", async () => {
    const s = setup();
    const r = await searchAll(s.b(), { text: "ab", kinds: ["logs"] });
    expect(r.kinds[0]).toMatchObject({ status: "failed", error: { kind: "badInput" } });
  });
});
