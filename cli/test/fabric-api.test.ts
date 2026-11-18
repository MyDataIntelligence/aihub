import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { didYouMean, inferEnv } from "../src/lib/fabric.js";
import { extractStack, filterLines, parseSince, readDefinitionDir, writeDefinitionParts } from "../src/lib/fabric-ops.js";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, sh, tmp, write, type Route } from "./helpers.js";

const WS = "11111111-1111-1111-1111-111111111111";
const OTHER = "99999999-9999-9999-9999-999999999999";
const TEAM = `version: 1
repositories:
  - name: test-repo
    defaultTarget: main
fabric:
  workspaces:
    - { name: DEV-test-project, id: ${WS}, environment: dev }
    - { name: ACC-test-project, id: 33333333-3333-3333-3333-333333333333, environment: acc }
`;
const NOW = Date.parse("2026-03-01T12:00:00Z");
const ENV = { AIHUB_FABRIC_TOKEN: "fabric-token", AIHUB_ONELAKE_TOKEN: "onelake-token", AIHUB_POWERBI_TOKEN: "pbi-token", AIHUB_POLL_MS: "0" };

function repo(): string {
  const { dir } = makeRepo();
  write(dir, ".agents/skills/_shared/references/team.yaml", TEAM);
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "team"]);
  return dir;
}

function go(routes: Route[], args: string[], dir = repo()) {
  const f = fakeFetch(routes);
  const { ctx, lines, errs } = ctxFor(dir, f.fn);
  ctx.env = { ...ENV };
  ctx.now = () => NOW;
  return main(["fabric", ...args], ctx).then((code) => {
    if (!lines.length && errs.length && process.env.DBG) console.log("ERR", args.join(" "), errs);
    return { code, lines, errs, calls: f.calls, out: lines.join("\n") };
  });
}

const get = (re: RegExp, body: unknown, extra: Partial<ReturnType<Route["respond"]>> = {}): Route => ({ match: re, respond: () => ({ body, ...extra }) });
const post = (re: RegExp, body: unknown = {}, extra: Partial<ReturnType<Route["respond"]>> = {}): Route => ({ method: "POST", match: re, respond: () => ({ body, ...extra }) });

const ITEMS = [
  { id: "nb-1", displayName: "nb_load", type: "Notebook" },
  { id: "pl-1", displayName: "pl_main", type: "DataPipeline" },
  { id: "lh-1", displayName: "lh_test", type: "Lakehouse" },
  { id: "sm-1", displayName: "sm_sales", type: "SemanticModel" },
  { id: "sj-1", displayName: "sjd_clean", type: "SparkJobDefinition" },
  { id: "env-1", displayName: "env_main", type: "Environment" },
];
const itemsRoute = get(new RegExp(`/workspaces/${WS}/items$`), { value: ITEMS });

describe("helpers", () => {
  it("infers acc/prd from a name but leaves DEV-test-project alone", () => {
    expect(inferEnv("DEV-test-project")).toBe("dev");
    expect(inferEnv("ACC-orders")).toBe("acc");
    expect(inferEnv("orders_prd")).toBe("prd");
    expect(inferEnv("Production main")).toBe("prd");
    expect(inferEnv("accounting-dev")).toBe("dev");
  });
  it("suggests close names", () => {
    expect(didYouMean("DEV-test", ["DEV-test-project", "PRD-x", "other"])).toEqual(["DEV-test-project"]);
    expect(didYouMean("zzz", ["a", "b"])).toEqual([]);
  });
  it("parses --since", () => {
    expect(parseSince("24h", NOW).toISOString()).toBe("2026-02-28T12:00:00.000Z");
    expect(parseSince("7d", NOW).toISOString()).toBe("2026-02-22T12:00:00.000Z");
    expect(parseSince("2026-01-01T00:00:00Z", NOW).toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(() => parseSince("soon", NOW)).toThrow(/--since/);
  });
  it("finds a stack, searches and tails", () => {
    expect(extractStack(["ok", "Traceback (most recent call last):", "  File x", "ValueError: boom"])).toHaveLength(3);
    expect(filterLines(["a", "B", "b2", "c"], { search: "b", tail: 1 })).toEqual(["b2"]);
  });
  it("round-trips a definition dir and refuses path traversal", () => {
    const src = tmp();
    mkdirSync(join(src, "sub"), { recursive: true });
    writeFileSync(join(src, "a.py"), "print(1)\n");
    writeFileSync(join(src, "sub", ".platform"), '{"x":1}');
    const parts = readDefinitionDir(src);
    expect(parts.map((p) => p.path)).toEqual(["a.py", "sub/.platform"]);
    const out = tmp();
    writeDefinitionParts(parts, out);
    expect(readFileSync(join(out, "a.py"), "utf8")).toBe("print(1)\n");
    expect(() => writeDefinitionParts([{ path: "../evil.txt", payload: "eA==" }], out)).toThrow(/outside/);
    expect(() => readDefinitionDir(join(src, "nope"))).toThrow(/not a folder/);
  });
});

describe("read commands", () => {
  it("lists workspaces over two pages and filters", async () => {
    let n = 0;
    const r: Route = {
      match: /\/v1\/workspaces(\?continuationToken=t2)?$/,
      respond: (c) => {
        n++;
        return c.url.includes("t2") ? { body: { value: [{ id: "w2", displayName: "PRD-shop", type: "Workspace" }] } } : { body: { value: [{ id: WS, displayName: "DEV-test-project", type: "Workspace" }], continuationToken: "t2" } };
      },
    };
    const a = await go([r], ["workspaces"]);
    expect(n).toBe(2);
    expect(a.out).toContain("DEV-test-project | Workspace | dev");
    expect(a.out).toContain("PRD-shop");
    const b = await go([r], ["workspaces", "--filter", "shop"]);
    expect(b.out).not.toContain("DEV-test-project");
    const c = await go([r], ["workspaces", "--json"]);
    expect(JSON.parse(c.out).result).toHaveLength(2);
    expect(JSON.parse(c.out).identity.kind).toBe("token");
  });

  it("retries a 429 using Retry-After", async () => {
    let n = 0;
    const r: Route = {
      match: /\/v1\/workspaces$/,
      respond: () => (n++ < 2 ? { status: 429, headers: { "retry-after": "3" }, body: { message: "slow down" } } : { body: { value: [{ id: WS, displayName: "DEV-test-project" }] } }),
    };
    const a = await go([r], ["workspaces"]);
    expect(a.code).toBe(0);
    expect(a.calls).toHaveLength(3);
    n = -100;
    const b = await go([{ match: /\/v1\/workspaces$/, respond: () => ({ status: 429, body: {} }) }], ["workspaces"]);
    expect(b.code).toBe(1);
    expect(b.errs[0]).toContain("429");
  });

  it("lists items by type and shows one with did-you-mean", async () => {
    const a = await go([get(new RegExp(`/workspaces/${WS}/items\\?type=Notebook$`), { value: [ITEMS[0]] })], ["items", "--workspace", "DEV-test-project", "--type", "notebook"]);
    expect(a.out).toContain("Notebook | nb_load | nb-1");
    expect(a.out).not.toContain("lh_test");
    const b = await go([itemsRoute], ["item", "show", "--workspace", "DEV-test-project", "--item", "nb_loa"]);
    expect(b.code).toBe(1);
    expect(b.errs[0]).toContain("did you mean: nb_load");
    const c = await go([itemsRoute, get(new RegExp(`/items/nb-1$`), { id: "nb-1", displayName: "nb_load", type: "Notebook", description: "d" })], ["item", "show", "--workspace", "DEV-test-project", "--item", "nb_load"]);
    expect(c.out).toContain("description: d");
  });

  it("works on a workspace that team.yaml does not list, by name and by id", async () => {
    const ws = get(/\/v1\/workspaces$/, { value: [{ id: OTHER, displayName: "Sandbox-anna" }] });
    const items = get(new RegExp(`/workspaces/${OTHER}/items$`), { value: ITEMS });
    const a = await go([ws, items], ["items", "--workspace", "sandbox-anna"]);
    expect(a.out).toContain("sandbox-anna (dev, not listed in team.yaml)");
    const b = await go([items], ["items", "--workspace", OTHER]);
    expect(b.code).toBe(0);
  });

  it("job history: newest first, --top", async () => {
    const jobs = get(new RegExp(`/items/nb-1/jobs/instances$`), {
      value: [
        { id: "j1", status: "Completed", startTimeUtc: "2026-03-01T08:00:00Z", endTimeUtc: "2026-03-01T08:01:05Z", invokeType: "Manual" },
        { id: "j2", status: "Failed", startTimeUtc: "2026-03-01T09:00:00Z", endTimeUtc: "2026-03-01T09:00:10Z", failureReason: { message: "Cell 2 failed" } },
      ],
    });
    const a = await go([itemsRoute, jobs], ["jobs", "--workspace", "DEV-test-project", "--item", "nb_load", "--top", "1"]);
    expect(a.out).toContain("1 of 2 job(s)");
    expect(a.out).toContain("j2");
    expect(a.out).not.toContain("| j1 |");
    expect(a.out).toContain("Cell 2 failed");
  });

  it("lakehouse tables (tables API), falling back to OneLake when it answers 400", async () => {
    const a = await go([itemsRoute, get(new RegExp(`/lakehouses/lh-1/tables$`), { data: [{ name: "orders", type: "Managed", format: "delta", location: "abfss://x" }] })], ["lakehouse", "tables", "--workspace", "DEV-test-project", "--lakehouse", "lh_test"]);
    expect(a.out).toContain("orders | Managed | delta");
    const dfs: Route = { match: /onelake\.dfs\.fabric\.microsoft\.com/, respond: () => ({ body: { paths: [{ name: "lh-1/Tables/dbo", isDirectory: "true" }] } }) };
    const b = await go([itemsRoute, { match: /\/tables$/, respond: () => ({ status: 400, body: { message: "schemas enabled" } }) }, dfs], ["lakehouse", "tables", "--workspace", "DEV-test-project", "--lakehouse", "lh_test"]);
    expect(b.out).toContain("source: OneLake DFS");
    expect(b.out).toContain("Tables/dbo/");
    expect(b.calls.at(-1)!.headers.Authorization).toBe("Bearer onelake-token");
  });

  it("lakehouse files follows the OneLake continuation header", async () => {
    let n = 0;
    const dfs: Route = {
      match: /onelake\.dfs\.fabric\.microsoft\.com/,
      respond: (c) => {
        n++;
        return c.url.includes("continuation=c1") ? { body: { paths: [{ name: "lh-1/Files/landing/b.csv", contentLength: "20" }] } } : { body: { paths: [{ name: "lh-1/Files/landing/a.csv", contentLength: "10" }] }, headers: { "x-ms-continuation": "c1" } };
      },
    };
    const a = await go([itemsRoute, dfs], ["lakehouse", "files", "--workspace", "DEV-test-project", "--lakehouse", "lh_test", "--path", "landing"]);
    expect(n).toBe(2);
    expect(a.out).toContain("Files/landing/a.csv | file | 10");
    expect(a.out).toContain("Files/landing/b.csv");
    expect(a.calls.find((c) => c.url.includes("onelake"))!.url).toContain("directory=lh-1%2FFiles%2Flanding");
  });
});

describe("definitions (long-running operations)", () => {
  const defParts = [
    { path: "notebook-content.py", payload: Buffer.from("# cell\nprint(1)\n").toString("base64"), payloadType: "InlineBase64" },
    { path: ".platform", payload: Buffer.from('{"metadata":{"type":"Notebook"}}').toString("base64"), payloadType: "InlineBase64" },
  ];
  function lro() {
    let polls = 0;
    return [
      itemsRoute,
      post(/\/items\/nb-1\/getDefinition$/, {}, { status: 202, headers: { location: "https://api.fabric.microsoft.com/v1/operations/op1", "x-ms-operation-id": "op1", "retry-after": "1" } }),
      { match: /\/operations\/op1$/, respond: () => ({ body: { status: polls++ < 1 ? "Running" : "Succeeded" }, headers: { "retry-after": "1" } }) } as Route,
      get(/\/operations\/op1\/result$/, { definition: { parts: defParts } }),
    ];
  }

  it("polls the operation, decodes the parts to files and re-encodes them for create", async () => {
    const out = join(tmp(), "nb");
    const a = await go(lro(), ["item", "definition", "--workspace", "DEV-test-project", "--item", "nb_load", "--out", out]);
    expect(a.code).toBe(0);
    expect(a.out).toContain("wrote 2 file(s)");
    expect(a.calls.filter((c) => c.url.endsWith("/operations/op1"))).toHaveLength(2);
    expect(readFileSync(join(out, "notebook-content.py"), "utf8")).toBe("# cell\nprint(1)\n");
    const b = await go([get(new RegExp(`/workspaces/${WS}/items$`), { value: [] }), post(new RegExp(`/workspaces/${WS}/items$`), { id: "new-1" }, { status: 201 })], ["item", "create", "--workspace", "DEV-test-project", "--type", "notebook", "--name", "nb_copy", "--definition-dir", out, "--description", "copy"]);
    expect(b.out).toContain("created Notebook nb_copy (id new-1)");
    const sent = b.calls.find((c) => c.method === "POST")!.body;
    expect(sent.displayName).toBe("nb_copy");
    expect(sent.type).toBe("Notebook");
    expect(sent.definition.parts.map((p: any) => [p.path, p.payload])).toEqual(defParts.map((p) => [p.path, p.payload]).sort((x, y) => (x[0] < y[0] ? -1 : 1)));
  });

  it("lists parts without --out and says when an item has no definition", async () => {
    const a = await go(lro(), ["item", "definition", "--workspace", "DEV-test-project", "--item", "nb_load"]);
    expect(a.out).toContain("2 definition part(s)");
    const b = await go([itemsRoute, post(/getDefinition$/, { definition: { parts: [] } })], ["item", "definition", "--workspace", "DEV-test-project", "--item", "nb_load"]);
    expect(b.errs[0]).toContain("no definition");
  });

  it("reports a failed operation", async () => {
    const a = await go(
      [itemsRoute, post(/getDefinition$/, {}, { status: 202, headers: { "x-ms-operation-id": "opX" } }), get(/operations\/opX$/, { status: "Failed", error: { errorCode: "BadDef", message: "nope" } })],
      ["item", "definition", "--workspace", "DEV-test-project", "--item", "nb_load"],
    );
    expect(a.code).toBe(1);
    expect(a.errs[0]).toContain("operation opX failed: BadDef nope");
  });
});

describe("write commands", () => {
  it("create: dry-run changes nothing, a duplicate is refused, ACC is refused before any call", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "a.py"), "x");
    const a = await go([itemsRoute], ["item", "create", "--workspace", "DEV-test-project", "--type", "Notebook", "--name", "nb_new", "--definition-dir", dir, "--dry-run"]);
    expect(a.out).toContain("dry-run: nothing was changed");
    expect(a.out).toContain("create Notebook 'nb_new'");
    expect(a.calls.every((c) => c.method === "GET")).toBe(true);
    const b = await go([itemsRoute], ["item", "create", "--workspace", "DEV-test-project", "--type", "Notebook", "--name", "nb_load"]);
    expect(b.errs[0]).toContain("already exists");
    const c = await go([itemsRoute], ["item", "create", "--workspace", "ACC-test-project", "--type", "Notebook", "--name", "x"]);
    expect(c.errs[0]).toContain("is ACC");
    expect(c.calls).toHaveLength(0);
    const d = await go([itemsRoute], ["item", "create", "--workspace", "Shop-ACC", "--type", "Notebook", "--name", "x"]);
    expect(d.errs[0]).toContain("is ACC");
    expect(d.calls).toHaveLength(0);
  });

  it("a workspace opened by id is classified by its name before writing", async () => {
    const r = get(new RegExp(`/workspaces/${OTHER}$`), { id: OTHER, displayName: "PRD-shop" });
    const a = await go([r], ["item", "delete", "--workspace", OTHER, "--item", "x", "--yes"]);
    expect(a.errs[0]).toContain("is PRD");
    expect(a.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("unlisted dev workspaces are writable", async () => {
    const ws = get(/\/v1\/workspaces$/, { value: [{ id: OTHER, displayName: "Sandbox-anna" }] });
    const items = get(new RegExp(`/workspaces/${OTHER}/items$`), { value: [] });
    const a = await go([ws, items, post(new RegExp(`/workspaces/${OTHER}/items$`), { id: "n1" }, { status: 201 })], ["item", "create", "--workspace", "Sandbox-anna", "--type", "Lakehouse", "--name", "lh_new"]);
    expect(a.out).toContain("created Lakehouse lh_new (id n1)");
  });

  it("update sends updateMetadata only when .platform is part of the definition", async () => {
    const withPlat = tmp();
    writeFileSync(join(withPlat, ".platform"), "{}");
    writeFileSync(join(withPlat, "a.py"), "x");
    const a = await go([itemsRoute, post(/updateDefinition\?updateMetadata=true$/)], ["item", "update", "--workspace", "DEV-test-project", "--item", "nb_load", "--definition-dir", withPlat]);
    expect(a.out).toContain("updated Notebook nb_load");
    const bare = tmp();
    writeFileSync(join(bare, "a.py"), "x");
    const b = await go([itemsRoute, post(/updateDefinition$/)], ["item", "update", "--workspace", "DEV-test-project", "--item", "nb_load", "--definition-dir", bare]);
    expect(b.code).toBe(0);
    const c = await go([itemsRoute], ["item", "update", "--workspace", "DEV-test-project", "--item", "nb_load", "--definition-dir", bare, "--dry-run"]);
    expect(c.out).toContain("left as it is");
  });

  it("rename, and delete needs --yes", async () => {
    const a = await go([itemsRoute, { method: "PATCH", match: /\/items\/nb-1$/, respond: () => ({ body: {} }) }], ["item", "rename", "--workspace", "DEV-test-project", "--item", "nb_load", "--name", "nb_loaded"]);
    expect(a.calls.at(-1)!.body).toEqual({ displayName: "nb_loaded" });
    const b = await go([itemsRoute], ["item", "delete", "--workspace", "DEV-test-project", "--item", "nb_load"]);
    expect(b.errs[0]).toContain("add --yes");
    expect(b.calls.some((c) => c.method === "DELETE")).toBe(false);
    const c = await go([itemsRoute, { method: "DELETE", match: /\/items\/nb-1$/, respond: () => ({ body: {} }) }], ["item", "delete", "--workspace", "DEV-test-project", "--item", "nb_load", "--yes"]);
    expect(c.out).toContain("deleted Notebook nb_load");
  });

  it("job cancel and run --cancel; run --dry-run starts nothing", async () => {
    const cancel = post(/\/items\/nb-1\/jobs\/instances\/j9\/cancel$/, {}, { status: 202 });
    const a = await go([itemsRoute, cancel], ["job", "cancel", "--workspace", "DEV-test-project", "--item", "nb_load", "--job", "j9"]);
    expect(a.out).toContain("cancel requested for job j9");
    const b = await go([itemsRoute, cancel], ["run", "--workspace", "DEV-test-project", "--item", "nb_load", "--cancel", "j9"]);
    expect(b.out).toContain("cancel requested");
    const c = await go([itemsRoute, cancel], ["run", "--workspace", "ACC-test-project", "--item", "nb_load", "--cancel", "j9"]);
    expect(c.errs[0]).toContain("is ACC");
    const d = await go([itemsRoute], ["run", "--workspace", "DEV-test-project", "--item", "nb_load", "--dry-run"]);
    expect(d.out).toContain("start Notebook nb_load");
    expect(d.calls.some((x) => x.method === "POST")).toBe(false);
  });

  it("lakehouse load and table maintenance, dry-run and real", async () => {
    const a = await go([itemsRoute], ["lakehouse", "load", "--workspace", "DEV-test-project", "--lakehouse", "lh_test", "--table", "orders", "--path", "landing/o.csv", "--dry-run"]);
    expect(a.out).toContain("Files/landing/o.csv into table 'orders'");
    const b = await go([itemsRoute, post(/lakehouses\/lh-1\/tables\/orders\/load$/)], ["lakehouse", "load", "--workspace", "DEV-test-project", "--lakehouse", "lh_test", "--table", "orders", "--path", "landing/o.csv", "--append"]);
    expect(b.calls.at(-1)!.body.mode).toBe("Append");
    const c = await go([itemsRoute, post(/jobs\/instances\?jobType=TableMaintenance$/, {}, { status: 202, headers: { location: "https://x/v1/workspaces/w/items/lh-1/jobs/instances/m1" } })], ["lakehouse", "maintenance", "--workspace", "DEV-test-project", "--lakehouse", "lh_test", "--table", "orders"]);
    expect(c.out).toContain("job m1");
    expect(c.calls.at(-1)!.body.executionData.tableName).toBe("orders");
  });

  it("environment publish (long-running) and libraries", async () => {
    const a = await go([itemsRoute, post(/environments\/env-1\/staging\/publish$/, {}, { status: 202, headers: { "x-ms-operation-id": "p1" } }), get(/operations\/p1$/, { status: "Succeeded" }), { match: /operations\/p1\/result$/, respond: () => ({ status: 404, body: {} }) }], ["environment", "publish", "--workspace", "DEV-test-project", "--item", "env_main"]);
    expect(a.out).toContain("published Environment env_main");
    const b = await go([itemsRoute, get(/environments\/env-1\/libraries$/, { customLibraries: { pythonLibraries: ["x.whl"] } })], ["environment", "libraries", "--workspace", "DEV-test-project", "--item", "env_main"]);
    expect(b.out).toContain("pythonLibraries: x.whl");
  });
});

describe("workspace, capacity, schedules, shortcuts, connections", () => {
  it("workspace show/roles/create/assign-capacity", async () => {
    const a = await go([get(new RegExp(`/workspaces/${WS}$`), { id: WS, displayName: "DEV-test-project", capacityId: "cap1" })], ["workspace", "show", "--workspace", "DEV-test-project"]);
    expect(a.out).toContain("capacityId: cap1");
    const b = await go([get(new RegExp(`/workspaces/${WS}/roleAssignments$`), { value: [{ id: "r1", role: "Admin", principal: { displayName: "Anna", type: "User" } }] })], ["workspace", "roles", "--workspace", "DEV-test-project"]);
    expect(b.out).toContain("Admin | Anna | User");
    const c = await go([], ["workspace", "create", "--name", "DEV-sandbox", "--dry-run"]);
    expect(c.out).toContain("create workspace 'DEV-sandbox'");
    const d = await go([], ["workspace", "create", "--name", "PRD-shop"]);
    expect(d.errs[0]).toContain("is PRD");
    const e = await go([get(/\/capacities$/, { value: [{ id: "cap1", displayName: "F2-dev" }] }), post(new RegExp(`/workspaces/${WS}/assignToCapacity$`))], ["workspace", "assign-capacity", "--workspace", "DEV-test-project", "--capacity", "F2-dev"]);
    expect(e.calls.at(-1)!.body).toEqual({ capacityId: "cap1" });
  });

  it("capacities, connections and gateways", async () => {
    const a = await go([get(/\/capacities$/, { value: [{ id: "cap1", displayName: "F2-dev", sku: "F2", region: "West Europe", state: "Active" }] })], ["capacities"]);
    expect(a.out).toContain("cap1 | F2-dev | F2");
    const b = await go([get(/\/connections$/, { value: [{ id: "c1", displayName: "sql-test", connectivityType: "ShareableCloud" }] })], ["connections"]);
    expect(b.out).toContain("sql-test");
    const c = await go([get(/\/gateways$/, { value: [] })], ["gateways"]);
    expect(c.out).toContain("no gateways");
  });

  it("schedules and shortcuts", async () => {
    const a = await go([itemsRoute, get(/items\/pl-1\/jobs\/Pipeline\/schedules$/, { value: [{ id: "s1", enabled: true, configuration: { type: "Daily", times: ["06:00"] } }] })], ["schedules", "--workspace", "DEV-test-project", "--item", "pl_main"]);
    expect(a.out).toContain("s1 | enabled | Daily | 06:00");
    const b = await go([itemsRoute, get(/items\/lh-1\/shortcuts$/, { value: [{ name: "ext", path: "Tables", target: { type: "AdlsGen2" } }] })], ["shortcuts", "--workspace", "DEV-test-project", "--lakehouse", "lh_test"]);
    expect(b.out).toContain("Tables | ext | AdlsGen2");
  });
});

describe("git integration", () => {
  const status = { workspaceHead: "aaaaaaaa11", remoteCommitHash: "bbbbbbbb22", changes: [{ itemMetadata: { displayName: "nb_load", itemType: "Notebook" }, remoteChange: "Modified", workspaceChange: "Added", conflictType: "None" }] };
  const st = get(new RegExp(`/workspaces/${WS}/git/status$`), status);

  it("status, update (dry-run and real), commit, and the no-op cases", async () => {
    const a = await go([st], ["git", "status", "--workspace", "DEV-test-project"]);
    expect(a.out).toContain("Notebook | nb_load | Added | Modified");
    const b = await go([st], ["git", "update", "--workspace", "DEV-test-project", "--dry-run"]);
    expect(b.out).toContain("aaaaaaaa -> bbbbbbbb");
    const c = await go([st, post(/git\/updateFromGit$/)], ["git", "update", "--workspace", "DEV-test-project"]);
    expect(c.calls.at(-1)!.body.remoteCommitHash).toBe("bbbbbbbb22");
    expect(c.calls.at(-1)!.body.conflictResolution.conflictResolutionPolicy).toBe("PreferRemote");
    const same = get(new RegExp(`/git/status$`), { workspaceHead: "x", remoteCommitHash: "x", changes: [] });
    expect((await go([same], ["git", "update", "--workspace", "DEV-test-project"])).out).toContain("already up to date");
    const msg = join(tmp(), "m.txt");
    writeFileSync(msg, "feat: orders\n\nbody\n");
    const d = await go([st, post(/git\/commitToGit$/)], ["git", "commit", "--workspace", "DEV-test-project", "--message-file", msg]);
    expect(d.calls.at(-1)!.body).toEqual({ mode: "All", workspaceHead: "aaaaaaaa11", comment: "feat: orders\n\nbody" });
    expect((await go([same], ["git", "commit", "--workspace", "DEV-test-project", "--message-file", msg])).out).toContain("nothing to commit");
    const e = await go([st], ["git", "update", "--workspace", "ACC-test-project"]);
    expect(e.errs[0]).toContain("is ACC");
    expect(e.calls).toHaveLength(0);
  });
});

describe("deployment pipelines", () => {
  const pipes = get(/\/deploymentPipelines$/, { value: [{ id: "dp1", displayName: "dp-test" }] });
  const stages = get(/\/deploymentPipelines\/dp1\/stages$/, {
    value: [
      { id: "s0", order: 0, displayName: "Development", workspaceName: "DEV-test-project" },
      { id: "s1", order: 1, displayName: "Staging", workspaceName: "STG-test-project" },
      { id: "s2", order: 2, displayName: "Live", workspaceName: "Shop-live" },
    ],
  });
  it("lists, shows stages with their env, deploys to a non-production stage, refuses the last", async () => {
    expect((await go([pipes], ["deployment", "list"])).out).toContain("dp1 | dp-test");
    const a = await go([pipes, stages], ["deployment", "stages", "--pipeline", "dp-test"]);
    expect(a.out).toContain("2 | Live | Shop-live | prd");
    const b = await go([pipes, stages, post(/dp1\/deploy$/)], ["deployment", "deploy", "--pipeline", "dp-test", "--from-stage", "Development", "--to-stage", "Staging", "--note", "n"]);
    expect(b.calls.at(-1)!.body).toEqual({ sourceStageId: "s0", targetStageId: "s1", note: "n" });
    const c = await go([pipes, stages, post(/dp1\/deploy$/)], ["deployment", "deploy", "--pipeline", "dp-test", "--from-stage", "1", "--to-stage", "2"]);
    expect(c.errs[0]).toContain("is PRD");
    expect(c.calls.some((x) => x.method === "POST")).toBe(false);
    const d = await go([pipes, stages, post(/dp1\/deploy$/)], ["deployment", "deploy", "--pipeline", "dp-test", "--from-stage", "1", "--to-stage", "2", "--allow-env", "prd"]);
    expect(d.code).toBe(0);
    const e = await go([pipes, stages], ["deployment", "deploy", "--pipeline", "dp-test", "--from-stage", "0", "--to-stage", "9"]);
    expect(e.errs[0]).toContain("stages: 0=Development");
  });
});

describe("logs", () => {
  const nbJobs = get(/items\/nb-1\/jobs\/instances$/, {
    value: [
      { id: "jf", status: "Failed", startTimeUtc: "2026-03-01T09:00:00Z", endTimeUtc: "2026-03-01T09:00:30Z", invokeType: "Scheduled", failureReason: { errorCode: "SparkError", message: "Cell 3 failed\nValueError: bad row" } },
      { id: "jo", status: "Completed", startTimeUtc: "2026-03-01T08:00:00Z", endTimeUtc: "2026-03-01T08:02:00Z" },
      { id: "jold", status: "Failed", startTimeUtc: "2026-02-10T08:00:00Z", failureReason: { message: "ancient" } },
    ],
  });
  const plJobs = get(/items\/pl-1\/jobs\/instances$/, { value: [{ id: "pj", status: "Completed", startTimeUtc: "2026-03-01T07:00:00Z", endTimeUtc: "2026-03-01T07:10:00Z" }] });
  const sjJobs = get(/items\/sj-1\/jobs\/instances$/, { value: [] });
  const lhNo = { match: /items\/lh-1\/jobs\/instances$/, respond: () => ({ status: 400, body: { message: "not supported" } }) } as Route;
  const pbi = get(/api\.powerbi\.com\/v1\.0\/myorg\/groups\/.*\/datasets\/sm-1\/refreshes/, {
    value: [{ requestId: "r1", refreshType: "Scheduled", status: "Failed", startTime: "2026-03-01T06:00:00Z", endTime: "2026-03-01T06:03:00Z", serviceExceptionJson: JSON.stringify({ errorCode: "ModelRefresh_ShortMessage_ProcessingError", errorDescription: "Column 'x' cannot be found" }) }],
  });
  const base = [itemsRoute, nbJobs, plJobs, sjJobs, lhNo, pbi];

  it("workspace table: all failed runs of the last 24h across items, with a dig-deeper command", async () => {
    const a = await go(base, ["logs", "--workspace", "DEV-test-project", "--since", "24h", "--status", "failed"]);
    expect(a.code).toBe(0);
    expect(a.out).toContain("2 run(s) since 24h in DEV-test-project (dev): 2 Failed");
    expect(a.out).toContain("nb_load | Notebook | Failed | 30s | jf | Cell 3 failed");
    expect(a.out).toContain("sm_sales | SemanticModel | Failed | 3m0s | r1 | Column 'x' cannot be found");
    expect(a.out).not.toContain("ancient");
    expect(a.out).toContain("Power BI refresh history");
    expect(a.out).toContain("1 without job history (lh_test: HTTP 400)");
    expect(a.out).toContain("aihub fabric logs --workspace DEV-test-project --item nb_load --job jf");
    expect(a.calls.find((c) => c.url.includes("powerbi"))!.headers.Authorization).toBe("Bearer pbi-token");
  });

  it("all statuses, --search, --top and --json", async () => {
    const all = await go(base, ["logs", "--workspace", "DEV-test-project"]);
    expect(all.out).toContain("4 run(s)");
    expect(all.out).toContain("2 Completed");
    const s = await go(base, ["logs", "--workspace", "DEV-test-project", "--search", "valueerror"]);
    expect(s.out).toContain("1 run(s)");
    const t = await go(base, ["logs", "--workspace", "DEV-test-project", "--top", "1"]);
    expect(t.out).toContain("1 run(s)");
    const j = await go(base, ["logs", "--workspace", "DEV-test-project", "--status", "failed", "--json"]);
    expect(JSON.parse(j.out).result.rows).toHaveLength(2);
    const old = await go(base, ["logs", "--workspace", "DEV-test-project", "--since", "30d", "--status", "failed"]);
    expect(old.out).toContain("ancient");
  });

  it("a notebook job: scheduler failure, Spark session, driver stderr with the stack excerpt", async () => {
    const stderr = "INFO start\nTraceback (most recent call last):\n  File \"x.py\", line 3\nValueError: bad row\nINFO end";
    const routes = [
      itemsRoute,
      get(/items\/nb-1\/jobs\/instances\/jf$/, { id: "jf", status: "Failed", jobType: "RunNotebook", invokeType: "Scheduled", startTimeUtc: "2026-03-01T09:00:00Z", endTimeUtc: "2026-03-01T09:00:30Z", failureReason: { errorCode: "SparkError", message: "Cell 3 failed" } }),
      get(/notebooks\/nb-1\/livySessions$/, { value: [{ livyId: "L1", jobInstanceId: "jf", sparkApplicationId: "app_1", state: "dead" }, { livyId: "L2", jobInstanceId: "other" }] }),
      { match: /livySessions\/L1\/applications\/app_1\/logs\?type=driver&fileName=stderr$/, respond: () => ({ text: stderr }) } as Route,
      { match: /fileName=stdout$/, respond: () => ({ text: "hello\nworld" }) } as Route,
    ];
    const a = await go(routes, ["logs", "--workspace", "DEV-test-project", "--item", "nb_load", "--job", "jf"]);
    expect(a.out).toContain("failure: SparkError: Cell 3 failed");
    expect(a.out).toContain("session L1: dead, application app_1");
    expect(a.out).not.toContain("L2");
    expect(a.out).toContain("[source: Spark monitoring driver log]");
    expect(a.out).toContain("error excerpt:");
    expect(a.out).toContain("ValueError: bad row");
    const s = await go(routes, ["logs", "--workspace", "DEV-test-project", "--item", "nb_load", "--job", "jf", "--search", "valueerror"]);
    expect(s.out).toContain("ValueError: bad row");
    expect(s.out).not.toContain("hello");
    const t = await go(routes, ["logs", "--workspace", "DEV-test-project", "--item", "nb_load", "--job", "jf", "--tail", "1"]);
    expect(t.out).toContain("world");
    expect(t.out).not.toContain("INFO start");
  });

  it("falls back and says so when the Spark endpoints are not available", async () => {
    const routes = [
      itemsRoute,
      get(/items\/nb-1\/jobs\/instances\/jf$/, { id: "jf", status: "Failed", failureReason: { errorCode: "E", message: "boom" } }),
      { match: /livySessions$/, respond: () => ({ status: 404, body: {} }) } as Route,
    ];
    const a = await go(routes, ["logs", "--workspace", "DEV-test-project", "--item", "nb_load", "--job", "jf"]);
    expect(a.code).toBe(0);
    expect(a.out).toContain("failure: E: boom");
    expect(a.out).toContain("(not available)");
    expect(a.out).toContain("answered HTTP 404");
  });

  it("a pipeline job: activity runs with each activity's error, failed first", async () => {
    const routes = [
      itemsRoute,
      get(/items\/pl-1\/jobs\/instances\/pj$/, { id: "pj", status: "Failed", startTimeUtc: "2026-03-01T07:00:00Z", endTimeUtc: "2026-03-01T07:10:00Z", failureReason: { errorCode: "ActivityFailed", message: "Copy failed" } }),
      post(/datapipelines\/pipelineruns\/pj\/queryactivityruns$/, [
        { activityName: "Lookup", activityType: "Lookup", status: "Succeeded", durationInMs: 4000 },
        { activityName: "CopyOrders", activityType: "Copy", status: "Failed", durationInMs: 9000, error: { errorCode: "2200", message: "Source table missing" }, output: { rowsRead: 0 } },
      ]),
    ];
    const a = await go(routes, ["logs", "--workspace", "DEV-test-project", "--item", "pl_main", "--job", "pj"]);
    expect(a.out).toContain("[source: pipeline queryActivityRuns]");
    const lines = a.out.split("\n");
    expect(lines.findIndex((l) => l.includes("CopyOrders"))).toBeLessThan(lines.findIndex((l) => l.includes("Lookup (")));
    expect(a.out).toContain("error 2200: Source table missing");
    expect(a.out).toContain('output: {"rowsRead":0}');
    expect(a.calls.at(-1)!.body.orderBy).toBeDefined();
  });

  it("a semantic model: refresh history; a spark job definition: its Livy sessions; warehouse/eventstream say why there is none", async () => {
    const a = await go([itemsRoute, pbi], ["logs", "--workspace", "DEV-test-project", "--item", "sm_sales", "--job", "r1"]);
    expect(a.out).toContain("refresh history of SemanticModel sm_sales");
    expect(a.out).toContain("ModelRefresh_ShortMessage_ProcessingError: Column 'x' cannot be found");
    const b = await go(
      [
        itemsRoute,
        get(/items\/sj-1\/jobs\/instances\/sj9$/, { id: "sj9", status: "Failed" }),
        get(/sparkJobDefinitions\/sj-1\/livySessions$/, { value: [{ livyId: "S1", jobInstanceId: "sj9", sparkApplicationId: "app_9" }] }),
        { match: /sparkJobDefinitions\/sj-1\/livySessions\/S1\/applications\/app_9\/logs/, respond: () => ({ text: "driver line" }) } as Route,
      ],
      ["logs", "--workspace", "DEV-test-project", "--item", "sjd_clean", "--job", "sj9"],
    );
    expect(b.out).toContain("driver line");
    const c = await go([get(new RegExp(`/workspaces/${WS}/items$`), { value: [{ id: "wh-1", displayName: "wh_test", type: "Warehouse" }] }), get(/items\/wh-1\/jobs\/instances\/x$/, { id: "x", status: "Completed" })], ["logs", "--workspace", "DEV-test-project", "--item", "wh_test", "--job", "x"]);
    expect(c.out).toContain("no job or run-history REST API");
  });

  it("rejects a malformed --since and an unknown item", async () => {
    expect((await go(base, ["logs", "--workspace", "DEV-test-project", "--since", "soon"])).errs[0]).toContain("--since");
    expect((await go(base, ["logs", "--workspace", "DEV-test-project", "--item", "nope"])).errs[0]).toContain("not found");
  });
});

describe("plan --check-workspace", () => {
  it("says which changed items exist in the workspace and gives the exact command", async () => {
    const { dir } = makeRepo();
    write(dir, ".agents/skills/_shared/references/team.yaml", TEAM.replace("environment: dev }", 'environment: dev, branches: ["feature/*"] }'));
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "team"]);
    sh(dir, ["push", "origin", "main"]);
    sh(dir, ["checkout", "-b", "feature/1-x"]);
    write(dir, "fabric/nb_load.Notebook/notebook-content.py", "x");
    write(dir, "fabric/nb_new.Notebook/notebook-content.py", "x");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "c"]);
    const a = await go([itemsRoute], ["plan", "--check-workspace"], dir);
    expect(a.out).toContain("in workspace: yes; update first: aihub fabric item update --workspace DEV-test-project --item nb_load --type Notebook --definition-dir fabric/nb_load.Notebook");
    expect(a.out).toContain("in workspace: no; create first: aihub fabric item create --workspace DEV-test-project --type Notebook --name nb_new --definition-dir fabric/nb_new.Notebook");
  });
});

describe("usage", () => {
  it("explains unknown commands", async () => {
    const a = await go([], ["nonsense"]);
    expect(a.errs[0]).toContain("usage: aihub fabric");
    expect(existsSync(".")).toBe(true);
  });
});

describe("lakehouse named like its SQL endpoint, and load paths (found by the live Fabric check)", () => {
  const twin = get(new RegExp(`/workspaces/${WS}/items$`), { value: [...ITEMS, { id: "sql-1", displayName: "lh_test", type: "SQLEndpoint" }] });
  it("--lakehouse means the Lakehouse, not the same-named SQL endpoint (onelake commands)", async () => {
    const dfs: Route = { match: /onelake\.dfs\.fabric\.microsoft\.com/, respond: () => ({ body: { paths: [] } }) };
    const r = await go([twin, dfs], ["onelake", "list", "--workspace", "DEV-test-project", "--lakehouse", "lh_test", "--path", "Files/landing"]);
    expect(r.errs).toEqual([]);
    expect(r.calls.find((c) => c.url.includes("onelake"))!.url).toContain("lh-1");
  });
  it("lakehouse load accepts a path with or without the Files/ prefix", async () => {
    const a = await go([twin], ["lakehouse", "load", "--workspace", "DEV-test-project", "--lakehouse", "lh_test", "--table", "orders", "--path", "Files/landing/o.csv", "--dry-run"]);
    expect(a.out).toContain("load Files/landing/o.csv into table 'orders'");
    expect(a.out).not.toContain("Files/Files");
    const b = await go([twin], ["lakehouse", "load", "--workspace", "DEV-test-project", "--lakehouse", "lh_test", "--table", "orders", "--path", "landing/o.csv", "--dry-run"]);
    expect(b.out).toContain("load Files/landing/o.csv into table 'orders'");
  });
});

describe("zoneless UTC job times and the cause of a failure chain (found by the live Fabric check)", () => {
  it("parseUtc reads a Fabric job timestamp without zone as UTC, whatever the local time zone is", async () => {
    const { parseUtc } = await import("../src/lib/fabric-ops.js");
    expect(parseUtc("2026-11-18T18:20:06.7111314")).toBe(Date.parse("2026-11-18T18:20:06.711Z"));
    expect(parseUtc("2026-11-18T18:20:06Z")).toBe(Date.parse("2026-11-18T18:20:06Z"));
    expect(parseUtc("Wed, 18 Nov 2026 18:13:59 GMT")).toBe(Date.parse("2026-11-18T18:13:59Z"));
    expect(parseUtc(undefined)).toBeNaN();
  });
  it("logs --since keeps a run whose startTimeUtc has no zone suffix", async () => {
    const jobs = get(/items\/nb-1\/jobs\/instances$/, { value: [{ id: "jz", status: "Failed", startTimeUtc: "2026-03-01T11:30:00.1234567", endTimeUtc: "2026-03-01T11:30:01.5", failureReason: { message: "boom" } }] });
    const none = { match: /jobs\/instances$/, respond: () => ({ body: { value: [] } }) } as Route;
    const r = await go([itemsRoute, jobs, none], ["logs", "--workspace", "DEV-test-project", "--since", "1h", "--status", "failed"]);
    expect(r.out).toContain("1 run(s) since 1h");
    expect(r.out).toContain("jz");
  });
  it("causeOfChain classifies the capacity error although the deepest link is 'no Spark session found'", async () => {
    const { causeOfChain } = await import("../src/lib/fabric-diag.js");
    const chain = [
      { error: "Exception: Failed to create Livy session. Error: [TooManyRequestsForCapacity] HTTP Response code 430: This Spark job can't be run" },
      { error: "no Spark session found for this run" },
    ];
    expect(causeOfChain(chain).kind).toBe("capacity");
    expect(causeOfChain([{ error: "no Spark session found for this run" }]).kind).toBe("unknown");
    expect(causeOfChain([{ error: "cell 2: x -> Table or view not found" }, { error: "no Spark session found" }]).kind).toBe("missing-table-or-path");
  });
});

describe("workspace delete (the live Fabric check needed it)", () => {
  const ws = get(new RegExp(`/workspaces/${WS}$`), { id: WS, displayName: "DEV-test-project" });
  const del: Route = { method: "DELETE", match: new RegExp(`/workspaces/${WS}$`), respond: () => ({ status: 200, body: {} }) };
  it("needs --yes, shows the plan with --dry-run, and deletes the whole workspace", async () => {
    const d = await go([], ["workspace", "delete", "--workspace", "DEV-test-project", "--dry-run"]);
    expect(d.out).toContain("with all its items");
    expect(d.calls.some((c) => c.method === "DELETE")).toBe(false);
    const n = await go([], ["workspace", "delete", "--workspace", "DEV-test-project"]);
    expect(n.errs[0]).toContain("add --yes");
    expect(n.calls.some((c) => c.method === "DELETE")).toBe(false);
    const y = await go([ws, del], ["workspace", "delete", "--workspace", "DEV-test-project", "--yes"]);
    expect(y.errs).toEqual([]);
    expect(y.calls.some((c) => c.method === "DELETE")).toBe(true);
    expect(y.out).toContain("deleted workspace");
  });
  it("refuses ACC and PRD before any call", async () => {
    const a = await go([], ["workspace", "delete", "--workspace", "ACC-test-project", "--yes"]);
    expect(a.errs[0]).toContain("is ACC");
    expect(a.calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});
