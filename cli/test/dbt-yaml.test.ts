import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/commands/dbt.js";
import { fakeDbt, makeProject } from "./dbt-helpers.js";

const show = (row: object) => JSON.stringify({ info: { name: "ShowNode" }, data: { preview: JSON.stringify([row]) } });

describe("aihub dbt yaml", () => {
  it("check lists missing entries, deprecated tests: and the unit-test coverage", async () => {
    const dir = makeProject({ "models/marts/schema.yml": "version: 2\nmodels:\n  - name: mart_orders\n    columns:\n      - name: order_id\n        tests: [unique]\nexposures:\n  - name: revenue_dashboard\n    type: dashboard\n" });
    const { ctx, lines } = fakeDbt(dir);
    await run(["yaml", "check"], ctx);
    const t = lines.join("\n");
    expect(t).toContain("model mart_customer_revenue has no YAML entry");
    expect(t).toContain("uses tests: (deprecated since dbt 1.8)");
    expect(t).toContain("0 of 4 model(s) have a unit test");
    await expect(run(["yaml", "check", "--strict"], ctx)).rejects.toThrow("warning(s)");
  });

  it("scaffold prints an entry from dbt show columns and --write adds it without touching the rest", async () => {
    const dir = makeProject();
    const { ctx, lines, calls } = fakeDbt(dir, (a) => (a[0] === "show" ? { stdout: show({ customer_id: 1, revenue: 2.5 }) } : {}));
    await run(["yaml", "scaffold", "mart_customer_revenue"], ctx);
    expect(lines.join("\n")).toContain("name: customer_id");
    expect(calls.some((c) => c.args.includes("--target-path"))).toBe(true);
    const file = join(dir, "models/marts/schema.yml");
    await run(["yaml", "scaffold", "mart_customer_revenue", "--write"], ctx);
    const after = readFileSync(file, "utf8");
    expect(after).toContain("- name: mart_orders");
    expect(after).toContain("- name: mart_customer_revenue");
    expect(after).toContain("- unique");
    expect(after).toContain("exposures:");
  });

  it("refuses a model that already has an entry; the unit-test skeleton uses types, never real values", async () => {
    const dir = makeProject();
    const { ctx, lines } = fakeDbt(dir, (a) => (a[0] === "show" ? { stdout: show({ order_id: 4242, status: "secret-real-value" }) } : {}));
    await expect(run(["yaml", "scaffold", "mart_orders"], ctx)).rejects.toThrow("already has an entry");
    await run(["yaml", "scaffold", "mart_customer_revenue", "--unit-test"], ctx);
    const t = lines.join("\n");
    expect(t).toContain("input: ref('stg_customers')");
    expect(t).toContain("input: ref('stg_orders')");
    expect(t).not.toContain("secret-real-value");
    expect(t).not.toContain("4242");
  });
});
