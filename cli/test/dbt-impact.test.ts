import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/commands/dbt.js";
import { filesImpact, renderImpactMarkdown } from "../src/lib/dbt-impact.js";
import { parseManifest } from "../src/lib/dbt-manifest.js";
import { testChanged } from "../src/lib/testChanged.js";
import { fakeDbt, manifestJson, PROJECT_FILES, put } from "./dbt-helpers.js";
import { makeRepo, sh, write } from "./helpers.js";

const m = () => parseManifest(manifestJson(), "shop");
const base = { project: "shop", baseRef: "main", base: "abc1234", removed: [] as string[], yml: () => ({}) };

describe("filesImpact", () => {
  it("a changed model reaches downstream models, tests and the exposure with its Fabric item", () => {
    const i = filesImpact({ ...base, m: m(), changed: ["models/staging/stg_orders.sql"] });
    expect(i.changed.map((c) => c.name)).toEqual(["stg_orders"]);
    expect(i.downstream.map((d) => d.name).sort()).toEqual(["mart_customer_revenue", "mart_orders"]);
    expect(i.tests.count).toBe(3);
    expect(i.exposures[0]).toMatchObject({ name: "revenue_dashboard", via: "mart_customer_revenue", fabric: ["Revenue report"] });
    expect(i.fabricItems).toEqual(["Revenue report"]);
    expect(i.selector).toEqual(["stg_orders+"]);
  });

  it("a macro change reaches the models that call it; a source change reaches its readers", () => {
    expect(filesImpact({ ...base, m: m(), changed: ["macros/cents.sql"] }).changed.map((c) => c.name)).toEqual(["mart_customer_revenue"]);
    const before = PROJECT_FILES["models/sources.yml"];
    const after = before.replace("name: raw_orders", "name: raw_orders\n        identifier: orders_v2");
    const s = filesImpact({ ...base, m: m(), changed: ["models/sources.yml"], yml: () => ({ before, after }) });
    expect(s.changed.map((c) => c.name)).toEqual(["source:raw.raw_orders"]);
    expect(s.selector).toEqual(["source:raw.raw_orders+"]);
    expect(s.downstream.map((d) => d.name)).toContain("stg_orders");
  });

  it("a yml-only change selects the model without its downstream; only the changed entry counts", () => {
    const before = PROJECT_FILES["models/staging/schema.yml"];
    const after = before.replace("Customers.", "Customers, cleaned.");
    const i = filesImpact({ ...base, m: m(), changed: ["models/staging/schema.yml"], yml: () => ({ before, after }) });
    expect(i.changed).toMatchObject([{ name: "stg_customers", change: "docs" }]);
    expect(i.downstream).toEqual([]);
    expect(i.selector).toEqual(["stg_customers"]);
  });

  it("dbt_project.yml is project-wide: no selector, a note", () => {
    const i = filesImpact({ ...base, m: m(), changed: ["dbt_project.yml"] });
    expect(i.projectWide).toEqual(["dbt_project.yml"]);
    expect(i.notes[0]).toContain("whole project");
  });

  it("renders the PR section as a table in English and Dutch", () => {
    const i = filesImpact({ ...base, m: m(), changed: ["models/staging/stg_orders.sql"] });
    expect(renderImpactMarkdown(i)).toContain("| stg_orders | model | logic or data |");
    expect(renderImpactMarkdown(i, true)).toContain("| stg_orders | model | logica of data |");
  });
});

describe("aihub dbt impact and test changed in a repository", () => {
  function repoWithProject() {
    const { dir } = makeRepo();
    for (const [f, c] of Object.entries(PROJECT_FILES)) write(dir, `dbt/${f}`, c);
    write(dir, ".gitignore", "target/\n");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "dbt project"]);
    sh(dir, ["push", "origin", "main"]);
    sh(dir, ["checkout", "-b", "feature/x"]);
    write(dir, "dbt/models/staging/stg_orders.sql", "select 1 as order_id, 1 as customer_id, 1 as amount, 'paid' as status\n");
    put(dir, "dbt/target/manifest.json", JSON.stringify(manifestJson()));
    return dir;
  }

  it("maps the branch diff to nodes, with --json", async () => {
    const dir = repoWithProject();
    const { ctx, lines } = fakeDbt(dir);
    await run(["impact", "--base", "main", "--json", "--project", join(dir, "dbt")], ctx);
    const j = JSON.parse(lines.join(""));
    expect(j.changed.map((c: any) => c.name)).toEqual(["stg_orders"]);
    expect(j.changedFiles).toEqual(["models/staging/stg_orders.sql"]);
  });

  it("test changed gives the dbt command; tests.dbt overrides it; Fabric projects are not run", () => {
    const dir = repoWithProject();
    const { ctx } = fakeDbt(dir);
    const plan = JSON.parse(testChanged(ctx, { base: "main", json: true }));
    expect(plan.dbt[0]).toMatchObject({ project: "dbt", route: "other", selector: ["stg_orders+"], command: "aihub dbt build --select stg_orders+ --project dbt" });
    write(dir, ".agents/skills/_shared/references/team.yaml", "tests:\n  dbt:\n    mode: test\n    state: prod-state\n");
    const p2 = JSON.parse(testChanged(ctx, { base: "main", json: true }));
    expect(p2.dbt[0].command).toBe("aihub dbt test --select state:modified+ --state prod-state --defer --project dbt");
    write(dir, ".agents/skills/_shared/references/team.yaml", "tests: {}\n");
    write(dir, "dbt/profiles.yml", "shop:\n  target: dev\n  outputs:\n    dev:\n      type: fabric\n      database: wh\n      authentication: CLI\n");
    const ran: string[] = [];
    const text = testChanged(ctx, { base: "main", run: true }, (c) => (ran.push(c), 0));
    expect(ran).toEqual([]);
    expect(text).toContain("aihub fabric dbt run --workspace <workspace>");
  });
});
