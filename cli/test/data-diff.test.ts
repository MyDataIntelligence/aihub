import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { computeDataDiff, dataChecksOf, fabricRunner, queryFor, renderMarkdown, renderText, verdictOf, type DataChecks, type DataRunner } from "../src/lib/dataDiff.js";
import { prDataDiff } from "../src/lib/dataDiff.js";
import { ctxFor, fakeFetch, makeRepo, write, type Route } from "./helpers.js";

const CHECKS: DataChecks = {
  item: "lh_orders",
  tables: [{ name: "gold.orders", count: true, nulls: ["customer_id"], sums: ["amount"], distinct: ["customer_id"] }],
};

/** A fake warehouse: the numbers per workspace for the one built-in query. */
function runner(data: Record<string, Record<string, number | null>>, how = "the SQL endpoint"): DataRunner & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (ws: string, _item: string, sql: string) => {
    calls.push(`${ws}: ${sql}`);
    const d = data[ws];
    if (!d) throw new Error(`no data in ${ws}`);
    return { columns: Object.keys(d), rows: [Object.values(d)], how };
  }) as DataRunner & { calls: string[] };
  fn.calls = calls;
  return Object.assign(fn, { calls });
}

describe("queryFor", () => {
  it("builds one read-only SELECT with count, nulls, sums and distinct", () => {
    const q = queryFor(CHECKS.tables[0]);
    expect(q.sql).toBe(
      "SELECT COUNT_BIG(*) AS [count], SUM(CASE WHEN [customer_id] IS NULL THEN 1 ELSE 0 END) AS [nulls_customer_id], SUM(CAST([amount] AS FLOAT)) AS [sum_amount], COUNT(DISTINCT [customer_id]) AS [distinct_customer_id] FROM [gold].[orders]",
    );
    expect(q.metrics).toEqual(["count", "nulls_customer_id", "sum_amount", "distinct_customer_id"]);
  });

  it("refuses anything that is not a plain identifier (no injection) and a table without checks", () => {
    expect(() => queryFor({ name: "gold.orders; drop table x" })).toThrow(/not a plain identifier/);
    expect(() => queryFor({ name: "a.b.c" })).toThrow(/schema\.table/);
    expect(() => queryFor({ name: "t", nulls: ["x) --"] })).toThrow(/not a plain identifier/);
    expect(() => queryFor({ name: "t", count: false })).toThrow(/has no check/);
  });

  it("a custom SELECT goes through the read-only guard", () => {
    expect(queryFor({ name: "t", sql: "SELECT COUNT(*) AS rows_open FROM gold.orders WHERE status = 'open'" }).sql).toContain("rows_open");
    expect(() => queryFor({ name: "t", sql: "DELETE FROM gold.orders" })).toThrow(/read-only/);
  });
});

describe("computeDataDiff", () => {
  const base = { count: 1200, nulls_customer_id: 0, sum_amount: 50000.5, distinct_customer_id: 300 };

  it("deltas, percentages and a one-line verdict", async () => {
    const run = runner({ DEV: base, "DEV-anna": { count: 1250, nulls_customer_id: 3, sum_amount: 50000.5, distinct_customer_id: 300 } });
    const d = await computeDataDiff(run, CHECKS, "DEV", "DEV-anna");
    const m = (name: string) => d.metrics.find((x) => x.metric === name)!;
    expect(m("count")).toMatchObject({ before: 1200, after: 1250, delta: 50, pct: 4.2, changed: true });
    expect(m("nulls_customer_id")).toMatchObject({ before: 0, after: 3, delta: 3, changed: true });
    expect(m("nulls_customer_id").pct).toBeUndefined(); // from 0 there is no percentage
    expect(m("sum_amount")).toMatchObject({ delta: 0, changed: false });
    expect(d.verdict).toBe("2 of 4 metrics changed: gold.orders count +50, gold.orders nulls_customer_id +3");
    expect(run.calls).toHaveLength(2);
    expect(run.calls[0].startsWith("DEV: SELECT COUNT_BIG(*)")).toBe(true);
  });

  it("no change says so; NULL aggregates and strings compare as values", async () => {
    const same = await computeDataDiff(runner({ DEV: base, F: base }), CHECKS, "DEV", "F");
    expect(same.verdict).toBe("no metric changed (4 measured)");
    const custom: DataChecks = { item: "i", tables: [{ name: "t", sql: "SELECT MAX(d) AS last_load, SUM(x) AS total FROM t" }] };
    const run = (async (ws: string) => ({ columns: ["last_load", "total"], rows: [ws === "DEV" ? ["2026-11-01", null] : ["2026-11-02", 5]], how: "the SQL endpoint" })) as DataRunner;
    const d = await computeDataDiff(run, custom, "DEV", "F");
    expect(d.metrics.find((x) => x.metric === "last_load")).toMatchObject({ before: "2026-11-01", after: "2026-11-02", changed: true });
    expect(d.metrics.find((x) => x.metric === "total")).toMatchObject({ before: null, after: 5, changed: true });
  });

  it("a table that fails is reported, the others are still measured", async () => {
    const two: DataChecks = { item: "i", tables: [{ name: "gold.orders", count: true }, { name: "gold.missing", count: true }] };
    const run = (async (ws: string, _i: string, sql: string) => {
      if (sql.includes("[missing]")) throw new Error("Invalid object name 'gold.missing'.\nmore");
      return { columns: ["count"], rows: [[ws === "DEV" ? 10 : 12]], how: "Livy (Spark SQL; the SQL endpoint failed)" };
    }) as DataRunner;
    const d = await computeDataDiff(run, two, "DEV", "F");
    expect(d.metrics.map((x) => [x.table, x.metric, x.error ? "error" : x.delta])).toEqual([["gold.orders", "count", 2], ["gold.missing", "-", "error"]]);
    expect(d.verdict).toBe("1 of 1 metrics changed: gold.orders count +2; 1 table(s) failed: gold.missing");
    expect(d.how).toContain("Livy");
    expect(verdictOf([{ table: "t", metric: "-", changed: false, error: "x" }])).toBe("no data could be measured (1 table(s) failed)");
  });

  it("text and markdown (English and Dutch)", async () => {
    const d = await computeDataDiff(runner({ DEV: base, F: { ...base, count: 1250 } }), CHECKS, "DEV", "F");
    const t = renderText(d);
    expect(t).toContain("Data before/after: baseline DEV, feature F, lh_orders (read-only, via the SQL endpoint)");
    expect(t).toMatch(/gold\.orders\s+count\s+1200\s+1250\s+\+50 \(\+4\.2%\)/);
    expect(t).toContain("Verdict: 1 of 4 metrics changed");
    const en = renderMarkdown(d, "en");
    expect(en).toContain("| Table | Metric | Before | After | Delta |");
    expect(en).toContain("| gold.orders | count | 1200 | 1250 | +50 (+4.2%) |");
    expect(en).toContain("**Verdict:**");
    const nl = renderMarkdown(d, "nl");
    expect(nl).toContain("| Tabel | Meting | Vóór | Na | Delta |");
    expect(nl).toContain("**Oordeel:**");
    expect(nl).toContain("Gemeten (alleen lezen) in DEV (vóór) en F (na)");
  });
});

describe("dataChecksOf", () => {
  it("absent without tables; the item is required", () => {
    expect(dataChecksOf({})).toBeUndefined();
    expect(() => dataChecksOf({ dataChecks: { tables: [{ name: "t", count: true }] } } as never)).toThrow(/dataChecks\.item/);
  });
});

describe("fabricRunner: SQL endpoint first, Livy as the fallback", () => {
  const ctx = ctxFor(makeRepo().dir, fakeFetch([]).fn).ctx;
  it("uses fabric sql when it works", async () => {
    const seen: string[][] = [];
    const run = fabricRunner(ctx, async (argv, c) => (seen.push(argv), c.out(JSON.stringify({ result: { columns: ["count"], rows: [[5]] } }))));
    const r = await run("DEV", "lh", "SELECT 1 AS [count]");
    expect(r).toEqual({ columns: ["count"], rows: [[5]], how: "the SQL endpoint" });
    expect(seen).toEqual([["sql", "--workspace", "DEV", "--item", "lh", "--query", "SELECT 1 AS [count]", "--json"]]);
  });

  it("falls back to Livy (Spark SQL in the Lakehouse) and says so", async () => {
    const seen: string[][] = [];
    const run = fabricRunner(ctx, async (argv, c) => {
      seen.push(argv);
      if (argv[0] === "sql") throw new Error("SQL endpoint not provisioned");
      c.out(JSON.stringify({ result: { status: "ok", columns: [{ name: "count", type: "long" }], rows: [[7]] } }));
    });
    const r = await run("DEV", "lh", "SELECT 7 AS [count]");
    expect(r).toEqual({ columns: ["count"], rows: [[7]], how: "Livy (Spark SQL; the SQL endpoint failed)" });
    expect(seen.map((a) => a.slice(0, 2).join(" "))).toEqual(["sql --workspace", "livy run"]);
    expect(seen[1]).toContain("--lakehouse");
  });

  it("both failing reports the SQL endpoint error", async () => {
    const run = fabricRunner(ctx, async (argv) => {
      throw new Error(argv[0] === "sql" ? "sql down" : "livy down");
    });
    await expect(run("DEV", "lh", "SELECT 1")).rejects.toThrow("sql down");
  });
});

describe("aihub pr data-diff", () => {
  const TEAM = [
    "language: en",
    "repositories:",
    "  - name: test-repo",
    "    defaultTarget: main",
    "fabric:",
    "  workspaces:",
    "    - name: DEV-shared",
    "      environment: dev",
    "      branches: [main]",
    "    - name: DEV-anna",
    "      environment: feature",
    "      branches: [\"feature/*\"]",
    "dataChecks:",
    "  item: lh_orders",
    "  tables:",
    "    - name: gold.orders",
    "      count: true",
    "",
  ].join("\n");
  const PR = "/ferron-org/test-project/_apis/git/repositories/test-repo/pullrequests/7";
  const pr = { pullRequestId: 7, title: "7 x", status: "active", sourceRefName: "refs/heads/feature/7-x", targetRefName: "refs/heads/main", description: "## Summary\n\nWhy.\n\n## Data before/after\n\n-\n" };

  function world(team = TEAM) {
    const { dir } = makeRepo();
    write(dir, ".agents/skills/_shared/references/team.yaml", team);
    const patches: any[] = [];
    const routes: Route[] = [
      { method: "PATCH", match: new RegExp(PR + "\\?"), respond: (c) => (patches.push(c.body), { body: pr }) },
      { match: new RegExp(PR + "\\?"), respond: () => ({ body: pr }) },
    ];
    const { ctx, lines, errs } = ctxFor(dir, fakeFetch(routes).fn);
    return { ctx, lines, errs, patches };
  }
  const data = runner({ "DEV-shared": { count: 10 }, "DEV-anna": { count: 13 } });

  it("baseline = the workspace of the target branch, feature = the workspace of the source branch; --write replaces the section", async () => {
    const w = world();
    const out = await prDataDiff(w.ctx, { pr: "7", write: true }, data);
    expect(out).toContain("baseline DEV-shared, feature DEV-anna");
    expect(out).toContain("written to the 'Data before/after' section of PR !7");
    const d = w.patches[0].description as string;
    expect(d).toContain("## Data before/after\n\n| Table | Metric | Before | After | Delta |");
    expect(d).toContain("| gold.orders | count | 10 | 13 | +3 (+30%) |");
    expect(d).toContain("## Summary\n\nWhy.");
    expect(d.match(/## Data before\/after/g)).toHaveLength(1);
  });

  it("without --write nothing is changed; --json carries the diff", async () => {
    const w = world();
    const out = JSON.parse(await prDataDiff(w.ctx, { pr: "7", json: true }, data));
    expect(w.patches).toEqual([]);
    expect(out).toMatchObject({ pr: 7, written: false, baseline: "DEV-shared", feature: "DEV-anna", item: "lh_orders" });
    expect(out.metrics[0]).toMatchObject({ table: "gold.orders", metric: "count", before: 10, after: 13, delta: 3 });
  });

  it("the Dutch section heading; an acc/prd workspace is refused before anything runs", async () => {
    const w = world(TEAM.replace("language: en", "language: nl"));
    expect(await prDataDiff(w.ctx, { pr: "7", write: true }, data)).toContain("'Data vóór/na'");
    const acc = world();
    await expect(prDataDiff(acc.ctx, { pr: "7", baseline: "ACC-shared" }, data)).rejects.toThrow(/ACC/);
    await expect(prDataDiff(acc.ctx, { pr: "7", feature: "PRD-x" }, data)).rejects.toThrow(/PRD/);
  });

  it("clear errors: no dataChecks, same workspace, no workspace for the branch", async () => {
    await expect(prDataDiff(world("language: en\n").ctx, { pr: "7" }, data)).rejects.toThrow(/no dataChecks in team\.yaml/);
    await expect(prDataDiff(world().ctx, { pr: "7", feature: "DEV-shared" }, data)).rejects.toThrow(/same workspace/);
    const noWs = world(TEAM.replace(/fabric:[\s\S]*dataChecks:/, "dataChecks:"));
    await expect(prDataDiff(noWs.ctx, { pr: "7" }, data)).rejects.toThrow(/no baseline workspace/);
  });

  it("the command: usage and a missing dataChecks give one line", async () => {
    const w = world("language: en\n");
    expect(await main(["pr", "data-diff", "--pr", "7"], w.ctx)).toBe(1);
    expect(w.errs.join("\n")).toContain("no dataChecks");
  });
});
