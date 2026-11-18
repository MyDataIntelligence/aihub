import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Ctx } from "../src/lib/context.js";
import type { Spawned } from "../src/lib/dbt-run.js";
import { ctxFor, fakeFetch, tmp, write } from "./helpers.js";

/** A synthetic dbt project (`shop`): source raw.raw_orders -> stg_orders -> mart_orders, mart_customer_revenue -> exposure. */
export const PROJECT_FILES: Record<string, string> = {
  "dbt_project.yml": "name: shop\nprofile: shop\nmodel-paths: [models]\nseed-paths: [seeds]\nmacro-paths: [macros]\n",
  "profiles.yml": "shop:\n  target: dev\n  outputs:\n    dev:\n      type: duckdb\n      path: shop.duckdb\n      threads: 2\n",
  ".gitignore": "target/\nlogs/\ndbt_packages/\n",
  "models/staging/stg_orders.sql": "select id as order_id, customer_id, amount, status from {{ source('raw', 'raw_orders') }}\n",
  "models/staging/stg_customers.sql": "select id as customer_id, name from {{ source('raw', 'raw_customers') }}\n",
  "models/marts/mart_orders.sql": "select order_id, amount from {{ ref('stg_orders') }}\n",
  "models/marts/mart_customer_revenue.sql": "select c.customer_id, {{ cents(sum(o.amount)) }} as revenue from {{ ref('stg_customers') }} c left join {{ ref('stg_orders') }} o using (customer_id) group by 1\n",
  "macros/cents.sql": "{% macro cents(x) %}({{ x }} * 100){% endmacro %}\n",
  "models/staging/schema.yml": "version: 2\nmodels:\n  - name: stg_orders\n    description: Orders.\n    columns:\n      - name: order_id\n        data_tests: [unique, not_null]\n  - name: stg_customers\n    description: Customers.\n",
  "models/marts/schema.yml": "version: 2\nmodels:\n  - name: mart_orders\n    description: Orders mart.\n    columns:\n      - name: order_id\n        data_tests: [unique]\nexposures:\n  - name: revenue_dashboard\n    type: dashboard\n    maturity: high\n    depends_on: [ref('mart_customer_revenue')]\n    owner: {name: Data Team}\n    meta: {fabric_item: Revenue report}\n",
  "models/sources.yml": "version: 2\nsources:\n  - name: raw\n    tables:\n      - name: raw_orders\n      - name: raw_customers\n",
};

const M = (id: string, file: string, extra: Record<string, unknown> = {}) => ({ unique_id: id, name: id.split(".")[2], resource_type: id.split(".")[0], package_name: "shop", original_file_path: file, config: { materialized: "table" }, relation_name: `"shop"."main"."${id.split(".")[2]}"`, ...extra });

/** The manifest dbt would write for PROJECT_FILES (only the fields the CLI reads). */
export function manifestJson(): any {
  const nodes: any = {
    "model.shop.stg_orders": M("model.shop.stg_orders", "models/staging/stg_orders.sql", { config: { materialized: "view" }, patch_path: "shop://models/staging/schema.yml", columns: { order_id: {} }, description: "Orders.", depends_on: { nodes: ["source.shop.raw.raw_orders"], macros: [] } }),
    "model.shop.stg_customers": M("model.shop.stg_customers", "models/staging/stg_customers.sql", { config: { materialized: "view" }, patch_path: "shop://models/staging/schema.yml", description: "Customers.", depends_on: { nodes: ["source.shop.raw.raw_customers"], macros: [] } }),
    "model.shop.mart_orders": M("model.shop.mart_orders", "models/marts/mart_orders.sql", { patch_path: "shop://models/marts/schema.yml", columns: { order_id: {} }, description: "Orders mart.", depends_on: { nodes: ["model.shop.stg_orders"], macros: [] } }),
    "model.shop.mart_customer_revenue": M("model.shop.mart_customer_revenue", "models/marts/mart_customer_revenue.sql", { depends_on: { nodes: ["model.shop.stg_customers", "model.shop.stg_orders"], macros: ["macro.shop.cents"] } }),
    "test.shop.unique_stg_orders_order_id.1": M("test.shop.unique_stg_orders_order_id.1", "models/staging/schema.yml", { attached_node: "model.shop.stg_orders", test_metadata: { name: "unique" }, depends_on: { nodes: ["model.shop.stg_orders"], macros: [] } }),
    "test.shop.not_null_stg_orders_order_id.2": M("test.shop.not_null_stg_orders_order_id.2", "models/staging/schema.yml", { attached_node: "model.shop.stg_orders", test_metadata: { name: "not_null" }, depends_on: { nodes: ["model.shop.stg_orders"], macros: [] } }),
    "test.shop.unique_mart_orders_order_id.3": M("test.shop.unique_mart_orders_order_id.3", "models/marts/schema.yml", { attached_node: "model.shop.mart_orders", test_metadata: { name: "unique" }, depends_on: { nodes: ["model.shop.mart_orders"], macros: [] } }),
  };
  const parent: Record<string, string[]> = {};
  for (const [id, n] of Object.entries<any>(nodes)) parent[id] = n.depends_on?.nodes ?? [];
  const sources: any = {
    "source.shop.raw.raw_orders": { unique_id: "source.shop.raw.raw_orders", name: "raw_orders", source_name: "raw", resource_type: "source", package_name: "shop", original_file_path: "models/sources.yml", relation_name: '"shop"."main"."raw_orders"' },
    "source.shop.raw.raw_customers": { unique_id: "source.shop.raw.raw_customers", name: "raw_customers", source_name: "raw", resource_type: "source", package_name: "shop", original_file_path: "models/sources.yml", relation_name: '"shop"."main"."raw_customers"' },
  };
  const exposures: any = {
    "exposure.shop.revenue_dashboard": { unique_id: "exposure.shop.revenue_dashboard", name: "revenue_dashboard", resource_type: "exposure", package_name: "shop", original_file_path: "models/marts/schema.yml", type: "dashboard", maturity: "high", owner: { name: "Data Team" }, meta: { fabric_item: "Revenue report" }, depends_on: { nodes: ["model.shop.mart_customer_revenue"] } },
  };
  parent["exposure.shop.revenue_dashboard"] = ["model.shop.mart_customer_revenue"];
  parent["source.shop.raw.raw_orders"] = [];
  parent["source.shop.raw.raw_customers"] = [];
  const child: Record<string, string[]> = {};
  for (const id of Object.keys(parent)) child[id] ??= [];
  for (const [id, ps] of Object.entries(parent)) for (const p of ps) (child[p] ??= []).push(id);
  const macros: any = {
    "macro.shop.cents": { unique_id: "macro.shop.cents", name: "cents", resource_type: "macro", package_name: "shop", original_file_path: "macros/cents.sql", depends_on: { macros: [] } },
  };
  return { metadata: { dbt_version: "1.12.7" }, nodes, sources, exposures, macros, unit_tests: {}, parent_map: parent, child_map: child };
}

/** Lay the project out in a fresh folder, with a manifest newer than every file. */
export function makeProject(extra: Record<string, string> = {}, o: { manifest?: boolean } = {}): string {
  const dir = tmp("aihub-dbt-");
  for (const [f, c] of Object.entries({ ...PROJECT_FILES, ...extra })) write(dir, f, c);
  if (o.manifest !== false) put(dir, "target/manifest.json", JSON.stringify(manifestJson()));
  return dir;
}

export function put(dir: string, rel: string, text: string): void {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

export interface Call {
  cmd: string;
  args: string[];
}

/** A dbt that records its calls, answers `answer(args)` and may write files (run_results.json) like the real one. */
export function fakeDbt(dir: string, answer: (args: string[], calls: Call[]) => Partial<Spawned> | void = () => ({})) {
  const calls: Call[] = [];
  const { ctx, lines, errs } = ctxFor(dir, fakeFetch([]).fn);
  ctx.spawn = (cmd, args) => {
    calls.push({ cmd, args });
    const r = answer(args, calls) ?? {};
    return { status: 0, stdout: "", stderr: "", ...r };
  };
  return { ctx: ctx as Ctx, lines, errs, calls };
}

export function runResults(results: any[], which = "build"): string {
  return JSON.stringify({ metadata: { generated_at: "2026-11-18T10:00:00Z" }, args: { which }, results });
}
