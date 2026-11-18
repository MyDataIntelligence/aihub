import { describe, expect, it } from "vitest";
import { run, setupProblems, verbArgs } from "../src/commands/dbt.js";
import { parseVersion, selectorArgs } from "../src/lib/dbt-run.js";
import { fakeDbt, makeProject, manifestJson, put, runResults } from "./dbt-helpers.js";

const FAIL = {
  status: "fail",
  unique_id: "test.shop.not_null_stg_orders_order_id.2",
  message: "Got 1 result, configured to fail if != 0",
  failures: 1,
  compiled_code: "\n\nselect order_id\nfrom \"shop\".\"main\".\"stg_orders\"\nwhere order_id is null\n\n",
};
const PASS = { status: "pass", unique_id: "test.shop.unique_stg_orders_order_id.1", message: null };

describe("aihub dbt: arguments", () => {
  it("splits selectors, passes state and defer, refuses a flag-looking selector", () => {
    expect(selectorArgs("a+ +b", "select")).toEqual(["a+", "+b"]);
    expect(() => selectorArgs("--vars x", "select")).toThrow("must not look like a flag");
    const args = verbArgs("build", { select: "stg_orders+ mart_orders", state: "prod-state", defer: true, "full-refresh": true, threads: "3" } as any);
    expect(args).toEqual(["build", "--select", "stg_orders+", "mart_orders", "--state", "prod-state", "--defer", "--full-refresh", "--threads", "3"]);
    expect(verbArgs("freshness", {} as any)).toEqual(["source", "freshness"]);
    expect(verbArgs("docs", {} as any)).toEqual(["docs", "generate"]);
    expect(verbArgs("run-operation", { args: "{x: 1}" } as any, "my_macro")).toEqual(["run-operation", "my_macro", "--args", "{x: 1}"]);
    expect(() => verbArgs("build", { inline: "select 1" } as any)).toThrow("--inline works with show and compile only");
  });

  it("parses dbt --version with CRLF and a plugin list", () => {
    const v = parseVersion("Core:\r\n  - installed: 1.12.7\r\n  - latest:    1.12.7 - Up to date!\r\n\r\nPlugins:\r\n  - duckdb: 1.11.1 - Up to date!\r\n  - fabric: 1.9.0\r\n");
    expect(v.core).toBe("1.12.7");
    expect(v.plugins).toEqual({ duckdb: "1.11.1", fabric: "1.9.0" });
  });
});

describe("aihub dbt: running", () => {
  it("runs dbt with the project folder, summarises run_results and exits non-zero on failures", async () => {
    const dir = makeProject();
    const { ctx, lines, calls } = fakeDbt(dir, () => {
      put(dir, "target/run_results.json", runResults([PASS, FAIL]));
      return { status: 1, stdout: "Done. PASS=1 ERROR=1" };
    });
    await expect(run(["build", "--select", "stg_orders+"], ctx)).rejects.toThrow("dbt build failed (exit 1)");
    expect(calls[0].args.slice(0, 3)).toEqual(["build", "--select", "stg_orders+"]);
    expect(calls[0].args).toContain("--project-dir");
    expect(calls[0].args).toContain("--profiles-dir");
    const text = lines.join("\n");
    expect(text).toContain("dbt build failed (exit 1): 1 pass, 1 fail");
    expect(text).toContain("fail test not_null_stg_orders_order_id");
    expect(text).toContain("aihub dbt failures");
  });

  it("--dry-run shows the command and does not run dbt", async () => {
    const dir = makeProject();
    const { ctx, lines, calls } = fakeDbt(dir);
    await run(["test", "--select", "mart_orders", "--dry-run"], ctx);
    expect(calls).toHaveLength(0);
    expect(lines.join("\n")).toContain("dbt test --select mart_orders");
  });

  it("keeps writes on a Fabric adapter behind the workspace guard, but allows reads", async () => {
    const dir = makeProject({ "profiles.yml": "shop:\n  target: dev\n  outputs:\n    dev:\n      type: fabric\n      server: x.datawarehouse.fabric.microsoft.com\n      database: wh\n      authentication: CLI\n" });
    const { ctx, calls } = fakeDbt(dir);
    await expect(run(["build"], ctx)).rejects.toThrow("aihub fabric dbt run --workspace");
    await expect(run(["run-operation", "grant"], ctx)).rejects.toThrow("aihub fabric dbt run");
    expect(calls).toHaveLength(0);
    await run(["compile", "--select", "mart_orders"], ctx);
    expect(calls[0].args[0]).toBe("compile");
  });

  it("points at the capacity when Fabric answers 430", async () => {
    const dir = makeProject();
    const { ctx, lines } = fakeDbt(dir, () => ({ status: 1, stdout: "TooManyRequestsForCapacity: HTTP 430" }));
    await expect(run(["test"], ctx)).rejects.toThrow();
    expect(lines.join("\n")).toContain("aihub fabric spark stop");
  });
});

describe("aihub dbt failures", () => {
  it("shows message, compiled SQL and the first failing rows, and keeps run_results intact", async () => {
    const dir = makeProject();
    put(dir, "target/run_results.json", runResults([PASS, FAIL]));
    const { ctx, lines, calls } = fakeDbt(dir, (args) => {
      if (args[0] !== "show") return {};
      return { stdout: `noise\n${JSON.stringify({ info: { name: "ShowNode" }, data: { preview: JSON.stringify([{ order_id: null }]) } })}\n` };
    });
    await run(["failures", "--rows", "3"], ctx);
    const text = lines.join("\n");
    expect(text).toContain("FAIL test not_null_stg_orders_order_id on stg_orders (models/staging/schema.yml) - 1 failing row(s)");
    expect(text).toContain('where order_id is null');
    expect(text).toContain('{"order_id":null}');
    const show = calls[0].args;
    expect(show.slice(0, 3)).toEqual(["show", "--select", "not_null_stg_orders_order_id"]);
    expect(show).toContain("--limit");
    expect(show[show.indexOf("--limit") + 1]).toBe("3");
    expect(show[show.indexOf("--target-path") + 1]).toBe("target/aihub-show");
  });

  it("--no-sample never calls dbt; --json is one object; no run_results explains what to do", async () => {
    const dir = makeProject();
    const a = fakeDbt(dir);
    await expect(run(["failures"], a.ctx)).rejects.toThrow("run `aihub dbt build");
    put(dir, "target/run_results.json", runResults([FAIL]));
    await run(["failures", "--no-sample", "--json"], a.ctx);
    expect(a.calls).toHaveLength(0);
    const j = JSON.parse(a.lines.join(""));
    expect(j.failures[0]).toMatchObject({ name: "not_null_stg_orders_order_id", kind: "test", failingRows: 1, on: "stg_orders" });
    expect(j.counts).toEqual({ fail: 1 });
  });

  it("redacts a secret inside a failing row", async () => {
    const dir = makeProject();
    put(dir, "target/run_results.json", runResults([FAIL]));
    const { ctx, lines } = fakeDbt(dir, () => ({ stdout: JSON.stringify({ info: { name: "ShowNode" }, data: { preview: JSON.stringify([{ note: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop" }]) } }) }));
    await run(["failures"], ctx);
    expect(lines.join("\n")).not.toContain("eyJhbGciOiJIUzI1NiJ9.eyJzdWIi");
  });
});

describe("aihub dbt lineage and detect", () => {
  it("lists upstream, downstream with exposures, and the tests on a model", async () => {
    const dir = makeProject();
    const { ctx, lines } = fakeDbt(dir);
    await run(["lineage", "stg_orders"], ctx);
    const text = lines.join("\n");
    expect(text).toContain("source:raw.raw_orders [source]");
    expect(text).toContain("mart_customer_revenue [model, table]");
    expect(text).toContain("revenue_dashboard [exposure, dashboard]");
    expect(text).toContain("tests on it: 2");
    lines.length = 0;
    await run(["lineage", "mart_customer_revenue", "--up", "--depth", "1", "--json"], ctx);
    const j = JSON.parse(lines.join(""));
    expect(j.upstream).toEqual(expect.arrayContaining(["stg_customers [model, view]", "stg_orders [model, view]"]));
    expect(j.downstream).toEqual([]);
  });

  it("parses the project again when the manifest is older than a file", async () => {
    const dir = makeProject({}, { manifest: false });
    const { ctx, calls } = fakeDbt(dir, (args) => {
      if (args[0] === "parse") put(dir, "target/manifest.json", JSON.stringify(manifestJson()));
    });
    await run(["lineage", "mart_orders"], ctx);
    expect(calls.map((c) => c.args[0])).toContain("parse");
  });

  it("detect prints versions, target, manifest and last run without a secret", async () => {
    const dir = makeProject();
    put(dir, "target/run_results.json", runResults([PASS, FAIL]));
    const { ctx, lines } = fakeDbt(dir, (args) => (args[0] === "--version" ? { stdout: "Core:\r\n  - installed: 1.12.7\r\n\r\nPlugins:\r\n  - duckdb: 1.11.1\r\n" } : {}));
    await run(["detect"], ctx);
    const text = lines.join("\n");
    expect(text).toContain("dbt project shop");
    expect(text).toContain("core 1.12.7, duckdb 1.11.1");
    expect(text).toContain("dev: duckdb (default)");
    expect(text).toContain("3 test(s), 2 source(s), 1 exposure(s)");
    expect(text).toContain("last run: dbt build, 1 pass, 1 fail");
  });
});

describe("aihub dbt check", () => {
  it("finds a literal secret without printing it, a missing spark_config.name and many threads", () => {
    const dir = makeProject({
      "profiles.yml": "shop:\n  target: lh\n  outputs:\n    lh:\n      type: fabricspark\n      method: livy\n      threads: 4\n      client_secret: hunter2-very-secret\n      token: \"{{ env_var('TOKEN') }}\"\n      authentication: CLI\n",
    });
    const problems = setupProblems({ projectDir: dir, profile: "shop", profilesFile: `${dir}/profiles.yml`, plugins: { fabricspark: "1.9" }, dbtFound: true, gitignore: "target/\n" });
    const text = JSON.stringify(problems);
    expect(text).not.toContain("hunter2");
    expect(problems.find((p) => p.what === "a literal secret in profiles.yml")?.where).toBe("shop/lh.client_secret");
    expect(problems.some((p) => p.what.includes("spark_config.name"))).toBe(true);
    expect(problems.some((p) => p.what.startsWith("threads 4"))).toBe(true);
    expect(problems.some((p) => p.where === "shop/lh.token")).toBe(false);
    expect(problems.some((p) => p.where === ".gitignore" && p.what.startsWith("dbt_packages"))).toBe(true);
  });

  it("reports a missing adapter and a profile that is not in profiles.yml", () => {
    const dir = makeProject();
    const p = setupProblems({ projectDir: dir, profile: "other", profilesFile: `${dir}/profiles.yml`, plugins: {}, dbtFound: true, gitignore: "target/\nlogs/\ndbt_packages/\n" });
    expect(p.map((x) => x.what)).toEqual(expect.arrayContaining(["no profile 'other' (dbt_project.yml names it)"]));
    const q = setupProblems({ projectDir: dir, profile: "shop", profilesFile: `${dir}/profiles.yml`, plugins: {}, dbtFound: true, gitignore: "target/\nlogs/\ndbt_packages/\n" });
    expect(q.find((x) => x.level === "warn")?.what).toContain("'duckdb' is not installed");
  });
});
