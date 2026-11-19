import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { daxGuard, graphqlGuard, kqlGuard } from "../src/commands/fabric-api.js";
import { FABRIC_ROWS } from "../src/lib/fabric-table.js";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, sh, tmp, write, type Route } from "./helpers.js";

const WS = "11111111-1111-1111-1111-111111111111";
const TEAM = `version: 1
repositories:
  - name: test-repo
    defaultTarget: main
fabric:
  workspaces:
    - { name: DEV-test-project, id: ${WS}, environment: dev }
    - { name: ACC-test-project, id: 33333333-3333-3333-3333-333333333333, environment: acc }
`;
const ENV = { AIHUB_FABRIC_TOKEN: "ft", AIHUB_ONELAKE_TOKEN: "ot", AIHUB_POWERBI_TOKEN: "pt", AIHUB_KUSTO_TOKEN: "kt", AIHUB_POLL_MS: "0" };

function go(routes: Route[], args: string[]) {
  const { dir } = makeRepo();
  write(dir, ".agents/skills/_shared/references/team.yaml", TEAM);
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "team"]);
  const f = fakeFetch(routes);
  const { ctx, lines, errs } = ctxFor(dir, f.fn);
  ctx.env = { ...ctx.env, ...ENV };
  return main(["fabric", ...args], ctx).then((code) => ({ code, out: lines.join("\n"), errs, calls: f.calls }));
}
const get = (re: RegExp, body: unknown, extra: Record<string, unknown> = {}): Route => ({ match: re, respond: () => ({ body, ...extra }) as any });
const send = (method: string, re: RegExp, body: unknown = {}, extra: Record<string, unknown> = {}): Route => ({ method, match: re, respond: () => ({ body, ...extra }) as any });
const items = get(new RegExp(`/workspaces/${WS}/items$`), { value: [{ id: "lh-1", displayName: "lh_test", type: "Lakehouse" }, { id: "sm-1", displayName: "sm_sales", type: "SemanticModel" }, { id: "kq-1", displayName: "kql_db", type: "KQLDatabase" }, { id: "gq-1", displayName: "gql_api", type: "GraphQLApi" }] });

describe("table", () => {
  it("has unique tools, no leading slash, and the legacy write rows", () => {
    const names = FABRIC_ROWS.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    expect(FABRIC_ROWS.every((r) => !r.url.startsWith("/"))).toBe(true);
    expect(FABRIC_ROWS.filter((r) => r.write).length).toBeGreaterThan(30);
    for (const n of ["list_capacities", "get_shortcut", "create_shortcut", "set_data_access_roles", "refresh_semantic_model", "cancel_job", "commit_to_git", "list_data_shares", "apply_tags"]) expect(names).toContain(n);
  });
  it("lists and finds tools with did-you-mean", async () => {
    const a = await go([], ["api", "list", "--filter", "shortcut"]);
    expect(a.out).toContain("create_shortcut | POST | yes | workspaces/{ws}/items/{item}/shortcuts");
    const b = await go([], ["api", "get_shortcutt"]);
    expect(b.errs[0]).toContain("did you mean: get_shortcut");
  });
});

describe("fabric api", () => {
  it("runs a paged read with its own list key", async () => {
    let n = 0;
    const r: Route = { match: /\/admin\/domains(\?continuationToken=c2)?$/, respond: (c) => (n++, c.url.includes("c2") ? { body: { domains: [{ id: "d2" }] } } : { body: { domains: [{ id: "d1" }], continuationToken: "c2" } }) };
    const a = await go([r], ["api", "fabric_list_domains"]);
    expect(n).toBe(2);
    expect(a.out).toContain("2 domains");
  });

  it("fills {ws}, {item} and --arg placeholders (path keeps its slashes) and query parameters", async () => {
    const a = await go([items, get(/items\/lh-1\/shortcuts\/Files\/landing\/ext%20link$/, { name: "ext link" })], ["api", "get_shortcut", "--workspace", "DEV-test-project", "--item", "lh_test", "--arg", "path=Files/landing", "--arg", "shortcutName=ext link"]);
    expect(a.code).toBe(0);
    expect(a.out).toContain("ext link");
    const b = await go([get(new RegExp(`/workspaces/${WS}/items\\?type=Notebook&recursive=true$`), { value: [] })], ["api", "list_items", "--workspace", "DEV-test-project", "--arg", "type=Notebook", "--arg", "recursive=true"]);
    expect(b.code).toBe(0);
    const c = await go([], ["api", "get_gateway"]);
    expect(c.errs[0]).toContain("--arg gatewayId=");
  });

  it("writes: dry-run shows method, url and body; --arg and --body-file build the body", async () => {
    const a = await go([], ["api", "assign_capacity", "--workspace", "DEV-test-project", "--arg", "capacityId=cap-1", "--dry-run"]);
    expect(a.out).toContain("POST workspaces/" + WS + "/assignToCapacity");
    expect(a.out).toContain('body: {"capacityId":"cap-1"}');
    const b = await go([send("POST", /assignToCapacity$/)], ["api", "assign_capacity", "--workspace", "DEV-test-project", "--arg", "capacityId=cap-1"]);
    expect(b.calls.at(-1)!.body).toEqual({ capacityId: "cap-1" });
    const f = join(tmp(), "b.json");
    writeFileSync(f, '{"principal":{"id":"u1","type":"User"},"role":"Contributor"}');
    const c = await go([send("POST", /roleAssignments$/)], ["api", "add_workspace_role_assignment", "--workspace", "DEV-test-project", "--body-file", f]);
    expect(c.calls.at(-1)!.body.role).toBe("Contributor");
    const d = await go([items], ["api", "create_shortcut", "--workspace", "DEV-test-project", "--item", "lh_test"]);
    expect(d.errs[0]).toContain("--body-file");
  });

  it("refuses ACC before any call, and a delete needs --yes", async () => {
    const a = await go([items], ["api", "assign_capacity", "--workspace", "ACC-test-project", "--arg", "capacityId=c"]);
    expect(a.errs[0]).toContain("is ACC");
    expect(a.calls).toHaveLength(0);
    const b = await go([items], ["api", "delete_folder", "--workspace", "DEV-test-project", "--arg", "folderId=f1"]);
    expect(b.errs[0]).toContain("--yes");
    expect(b.calls.some((c) => c.method === "DELETE")).toBe(false);
    const c = await go([send("DELETE", /folders\/f1$/)], ["api", "delete_folder", "--workspace", "DEV-test-project", "--arg", "folderId=f1", "--yes"]);
    expect(c.calls.at(-1)!.method).toBe("DELETE");
    const d = await go([], ["api", "create_workspace", "--arg", "displayName=Shop-PRD", "--dry-run"]);
    expect(d.errs[0]).toContain("is PRD");
  });

  it("the Power BI rows use the Power BI token", async () => {
    const bodyFile = join(tmp(), "r.json");
    writeFileSync(bodyFile, "{\"type\":\"Full\"}");
    const a = await go([items, send("POST", /api\.powerbi\.com\/v1\.0\/myorg\/groups\/.*\/datasets\/sm-1\/refreshes$/, {}, { status: 200 })], ["api", "refresh_semantic_model", "--workspace", "DEV-test-project", "--item", "sm_sales", "--body-file", bodyFile]);
    expect(a.calls.at(-1)!.headers.Authorization).toBe("Bearer pt");
  });
});

describe("onelake", () => {
  const dfs = (method: string, extra?: RegExp): Route => ({ method, match: new RegExp(`onelake\\.dfs\\.fabric\\.microsoft\\.com/${WS}/lh-1/Files/landing/a\\.csv${extra?.source ?? ""}`), respond: () => ({ body: {}, text: "id,name\n1,x\n" }) });
  const base = ["--workspace", "DEV-test-project", "--lakehouse", "lh_test"];

  it("read, write (create, append, flush), mkdir, move and delete, with the storage token", async () => {
    const r = await go([items, dfs("GET")], ["onelake", "read", ...base, "--path", "landing/a.csv"]);
    expect(r.out).toContain("1,x");
    expect(r.calls.at(-1)!.headers.Authorization).toBe("Bearer ot");
    const w = await go([items, dfs("PUT"), dfs("PATCH")], ["onelake", "write", ...base, "--path", "Files/landing/a.csv", "--text", "id\n1\n"]);
    const dfsCalls = w.calls.filter((c) => c.url.includes("onelake"));
    expect(dfsCalls.map((c) => c.method + " " + (c.url.split("?")[1] ?? ""))).toEqual(["PUT resource=file", "PATCH action=append&position=0", "PATCH action=flush&position=5"]);
    const wd = await go([items], ["onelake", "write", ...base, "--path", "landing/a.csv", "--text", "x", "--dry-run"]);
    expect(wd.out).toContain("write 1 bytes");
    expect(wd.calls.every((c) => !c.url.includes("onelake"))).toBe(true);
    const mk = await go([items, { method: "PUT", match: /onelake.*\?resource=directory$/, respond: () => ({ body: {} }) }], ["onelake", "mkdir", ...base, "--path", "landing/new"]);
    expect(mk.out).toContain("created folder");
    const mv = await go([items, { method: "PUT", match: /onelake/, respond: () => ({ body: {} }) }], ["onelake", "move", ...base, "--path", "landing/a.csv", "--to", "archive/a.csv"]);
    expect(mv.calls.at(-1)!.headers["x-ms-rename-source"]).toBe(`/${WS}/lh-1/Files/landing/a.csv`);
    const nd = await go([items], ["onelake", "delete", ...base, "--path", "landing/a.csv"]);
    expect(nd.errs[0]).toContain("--yes");
    const del = await go([items, { method: "DELETE", match: /onelake.*recursive=true$/, respond: () => ({ body: {} }) }], ["onelake", "delete", ...base, "--path", "landing/a.csv", "--yes"]);
    expect(del.out).toContain("deleted");
    const bad = await go([items], ["onelake", "read", ...base, "--path", "../x"]);
    expect(bad.errs[0]).toContain("inside the item");
    const acc = await go([], ["onelake", "write", "--workspace", "ACC-test-project", "--lakehouse", "lh", "--path", "a", "--text", "x"]);
    expect(acc.errs[0]).toContain("is ACC");
    expect(acc.calls).toHaveLength(0);
  });
});

describe("dax, kql, graphql", () => {
  it("guards: only read-only queries", () => {
    expect(() => daxGuard("EVALUATE ROW(\"a\", 1)")).not.toThrow();
    expect(() => daxGuard("-- c\nDEFINE MEASURE t[m]=1 EVALUATE t")).not.toThrow();
    expect(() => daxGuard("DROP x")).toThrow(/EVALUATE/);
    expect(() => kqlGuard("T | take 1")).not.toThrow();
    expect(() => kqlGuard("T | take 1\n.drop table T")).toThrow(/control commands/);
    expect(() => graphqlGuard("query { a }")).not.toThrow();
    expect(() => graphqlGuard("# mutation\nquery { a(x: \"mutation\") }")).not.toThrow();
    expect(() => graphqlGuard("mutation { del }")).toThrow(/read-only/);
  });

  it("DAX through the Power BI executeQueries API, capped by --top", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ "[n]": i }));
    const a = await go([items, send("POST", /datasets\/sm-1\/executeQueries$/, { results: [{ tables: [{ rows }] }] })], ["dax", "--workspace", "DEV-test-project", "--item", "sm_sales", "--query", "EVALUATE t", "--top", "2"]);
    expect(a.out).toContain("DAX ran: 5 row(s) (first 2)");
    expect(a.calls.at(-1)!.headers.Authorization).toBe("Bearer pt");
    expect(a.calls.at(-1)!.body.queries[0].query).toBe("EVALUATE t");
    const bad = await go([items], ["dax", "--workspace", "DEV-test-project", "--item", "sm_sales", "--query", "DROP"]);
    expect(bad.errs[0]).toContain("EVALUATE");
    expect(bad.calls).toHaveLength(0);
  });

  it("KQL against the database's own query service, read-only, and refuses a foreign host", async () => {
    const db = get(/kqlDatabases\/kq-1$/, { properties: { queryServiceUri: "https://x.z1.kusto.fabric.microsoft.com", databaseName: "db1" } });
    const a = await go([items, db, send("POST", /kusto\.fabric\.microsoft\.com\/v1\/rest\/query$/, { Tables: [{ Columns: [{ ColumnName: "n" }], Rows: [[1], [2]] }] })], ["kql", "--workspace", "DEV-test-project", "--item", "kql_db", "--query", "T | take 2"]);
    expect(a.out).toContain("KQL ran: 2 row(s)");
    const sent = a.calls.at(-1)!;
    expect(sent.body).toMatchObject({ db: "db1", csl: "T | take 2", properties: { Options: { request_readonly: true } } });
    expect(sent.headers.Authorization).toBe("Bearer kt");
    const evil = await go([items, get(/kqlDatabases\/kq-1$/, { properties: { queryServiceUri: "https://evil.example.com" } })], ["kql", "--workspace", "DEV-test-project", "--item", "kql_db", "--query", "T"]);
    expect(evil.errs[0]).toContain("not a *.kusto.fabric.microsoft.com host");
    expect(evil.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("KQL finds the database when an Eventhouse carries the same name (Fabric creates both)", async () => {
    const both = get(new RegExp(`/workspaces/${WS}/items$`), { value: [{ id: "eh-1", displayName: "eh_x", type: "Eventhouse" }, { id: "kq-1", displayName: "eh_x", type: "KQLDatabase" }] });
    const db = get(/kqlDatabases\/kq-1$/, { properties: { queryServiceUri: "https://x.z1.kusto.fabric.microsoft.com", databaseName: "eh_x" } });
    const a = await go([both, db, send("POST", /kusto\.fabric\.microsoft\.com\/v1\/rest\/query$/, { Tables: [{ Columns: [{ ColumnName: "n" }], Rows: [[1]] }] })], ["kql", "--workspace", "DEV-test-project", "--item", "eh_x", "--query", "T | take 1"]);
    expect(a.errs).toHaveLength(0);
    expect(a.out).toContain("KQL ran: 1 row(s)");
  });

  it("GraphQL queries, errors and refused mutations", async () => {
    const ok = await go([items, send("POST", /graphqlapis\/gq-1\/graphql$/, { data: { orders: [{ id: 1 }] } })], ["graphql", "--workspace", "DEV-test-project", "--item", "gql_api", "--query", "{ orders { id } }"]);
    expect(ok.out).toContain("GraphQL ran");
    const err = await go([items, send("POST", /graphql$/, { errors: [{ message: "bad field" }] })], ["graphql", "--workspace", "DEV-test-project", "--item", "gql_api", "--query", "{ x }"]);
    expect(err.out).toContain("GraphQL failed: bad field");
    const mut = await go([items], ["graphql", "--workspace", "DEV-test-project", "--item", "gql_api", "--query", "mutation { x }"]);
    expect(mut.errs[0]).toContain("read-only");
  });
});
