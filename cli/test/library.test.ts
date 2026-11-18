import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, type Route } from "./helpers.js";

const NL = String.fromCharCode(10);
const group = (id: number, name: string, variables: object, extra: object = {}) => ({ id, name, type: "Vsts", variables, ...extra });

function routes(groups: any[], extra: Route[] = []): Route[] {
  return [
    {
      match: /_apis\/distributedtask\/variablegroups\?/,
      respond: (c) => {
        const q = new URL(c.url).searchParams.get("groupName");
        return { body: { value: q ? groups.filter((g) => g.name.toLowerCase() === q.toLowerCase()) : groups } };
      },
    },
    ...groups.map((g): Route => ({ match: new RegExp(`_apis/distributedtask/variablegroups/${g.id}\\?`), respond: () => ({ body: g }) })),
    { match: /_apis\/projects\/test-project\?/, respond: () => ({ body: { id: "proj-guid", name: "test-project" } }) },
    ...extra,
  ];
}

describe("aihub library", () => {
  it("shows a group without ever printing a secret value", async () => {
    const { dir } = makeRepo();
    const g = group(3, "vg-dev", { URL: { value: "https://x" }, TOKEN: { value: null, isSecret: true } });
    const { ctx, lines } = ctxFor(dir, fakeFetch(routes([g])).fn);
    expect(await main(["library", "show", "--group", "vg-dev"], ctx)).toBe(0);
    const out = lines.join(NL);
    expect(out).toContain("URL = https://x");
    expect(out).toContain("TOKEN = *** (secret)");
    lines.length = 0;
    expect(await main(["library", "show", "--group", "3", "--json"], ctx)).toBe(0);
    expect(JSON.parse(lines.join(NL)).variables.TOKEN).toEqual({ value: "***", secret: true });
  });

  it("lists with a filter and shows Key Vault groups as keyvault secrets only", async () => {
    const { dir } = makeRepo();
    const kv = group(4, "kv-dev", { dbpass: { enabled: true, isSecret: true } }, { type: "AzureKeyVault", providerData: { vault: "kv1", serviceEndpointId: "ep" } });
    const { ctx, lines } = ctxFor(dir, fakeFetch(routes([group(3, "vg-dev", {}), kv])).fn);
    expect(await main(["library", "list", "--filter", "kv"], ctx)).toBe(0);
    expect(lines.join(NL)).toMatch(/4\s+kv-dev\s+AzureKeyVault\s+1/);
    expect(lines.join(NL)).not.toContain("vg-dev");
    lines.length = 0;
    await main(["library", "show", "--group", "kv-dev"], ctx);
    expect(lines.join(NL)).toContain("dbpass = keyvault secret");
    expect(lines.join(NL)).toContain("Key Vault kv1");
  });

  it("sets a plain variable, and a secret only through stdin; the secret is never echoed", async () => {
    const { dir } = makeRepo();
    const put: any[] = [];
    const g = group(3, "vg-dev", { URL: { value: "a" }, TOKEN: { value: null, isSecret: true } });
    const r = routes([g], [{ method: "PUT", match: /variablegroups\/3\?/, respond: (c) => (put.push(c.body), { body: c.body }) }]);
    const a = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["library", "set", "--group", "vg-dev", "--name", "URL", "--value", "b"], a.ctx)).toBe(0);
    expect(put[0].variables.URL).toEqual({ value: "b", isSecret: false });
    expect(put[0].variables.TOKEN).toMatchObject({ isSecret: true, value: null });
    const b = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["library", "set", "--group", "vg-dev", "--name", "NEW", "--secret", "--value", "oops"], b.ctx)).toBe(1);
    expect(b.errs.join(NL)).toContain("--value-stdin");
    const c = ctxFor(dir, fakeFetch(r).fn);
    c.ctx.stdin = () => "s3cret-value";
    expect(await main(["library", "set", "--group", "vg-dev", "--name", "NEW", "--secret", "--value-stdin"], c.ctx)).toBe(0);
    expect(put[1].variables.NEW).toEqual({ value: "s3cret-value", isSecret: true });
    expect(c.lines.join(NL)).not.toContain("s3cret-value");
    expect(c.lines.join(NL)).toContain("*** (secret, 12 chars)");
  });

  it("dry-run changes nothing and a secret stays out of the plan", async () => {
    const { dir } = makeRepo();
    let puts = 0;
    const g = group(3, "vg-dev", {});
    const r = routes([g], [{ method: "PUT", match: /variablegroups\/3\?/, respond: () => (puts++, { body: {} }) }]);
    const { ctx, lines } = ctxFor(dir, fakeFetch(r).fn);
    ctx.stdin = () => "topsecret";
    expect(await main(["library", "set", "--group", "vg-dev", "--name", "S", "--secret", "--value-stdin", "--dry-run"], ctx)).toBe(0);
    expect(puts).toBe(0);
    expect(lines.join(NL)).toContain("would PUT");
    expect(lines.join(NL)).not.toContain("topsecret");
  });

  it("refuses to change an ACC or PRD group unless --allow-env names it", async () => {
    const { dir } = makeRepo();
    let puts = 0;
    const prd = group(8, "vg-prd", { URL: { value: "a" } });
    const r = routes([prd], [{ method: "PUT", match: /variablegroups\/8\?/, respond: () => (puts++, { body: {} }) }]);
    const a = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["library", "set", "--group", "vg-prd", "--name", "URL", "--value", "x"], a.ctx)).toBe(1);
    expect(a.errs.join(NL)).toContain("is PRD");
    expect(puts).toBe(0);
    expect(await main(["library", "show", "--group", "vg-prd"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0); // reads always work
    const b = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["library", "set", "--group", "vg-prd", "--name", "URL", "--value", "x", "--allow-env", "prd"], b.ctx)).toBe(0);
    expect(puts).toBe(1);
  });

  it("creates a plain group and a Key Vault group from a service connection name", async () => {
    const { dir } = makeRepo();
    const posted: any[] = [];
    const r = routes([], [
      { method: "POST", match: /variablegroups\?/, respond: (c) => (posted.push(c.body), { body: { ...c.body, id: 11 } }) },
      { match: /serviceendpoint\/endpoints\?/, respond: () => ({ body: { value: [{ id: "ep-guid", name: "kv-conn" }] } }) },
    ]);
    const base = ctxFor(dir, fakeFetch(r).fn);
    const file = `${dir}/vars.json`;
    (await import("node:fs")).writeFileSync(file, JSON.stringify({ A: "1", B: "2" }));
    expect(await main(["library", "create", "--group", "vg-new", "--vars-file", file, "--description", "d"], base.ctx)).toBe(0);
    expect(posted[0]).toMatchObject({ name: "vg-new", type: "Vsts", variables: { A: { value: "1" }, B: { value: "2" } }, variableGroupProjectReferences: [{ projectReference: { id: "proj-guid" } }] });
    const kv = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["library", "create", "--group", "kv-new", "--keyvault", "kv-conn/vault1", "--secrets", "a,b"], kv.ctx)).toBe(0);
    expect(posted[1]).toMatchObject({ type: "AzureKeyVault", providerData: { serviceEndpointId: "ep-guid", vault: "vault1" }, variables: { a: { isSecret: true }, b: { isSecret: true } } });
  });

  it("deletes only with --yes, compares two groups and lists usage", async () => {
    const { dir } = makeRepo();
    let del = 0;
    const a = group(1, "vg-dev", { URL: { value: "a" }, ONLYA: { value: "x" }, S: { isSecret: true } });
    const b = group(2, "vg-test", { URL: { value: "b" }, S: { isSecret: true } });
    const r = routes([a, b], [
      { method: "DELETE", match: /variablegroups\/1\?/, respond: () => (del++, { body: {} }) },
      { match: /_apis\/build\/definitions\?/, respond: () => ({ body: { value: [{ id: 5, name: "ci", variableGroups: [{ id: 1 }] }, { id: 6, name: "other", variableGroups: [] }] } }) },
    ]);
    const x = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["library", "delete", "--group", "vg-dev"], x.ctx)).toBe(1);
    expect(del).toBe(0);
    expect(await main(["library", "delete", "--group", "vg-dev", "--yes"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(del).toBe(1);
    const d = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["library", "diff", "--group", "vg-dev", "--with", "vg-test"], d.ctx)).toBe(0);
    const out = d.lines.join(NL);
    expect(out).toMatch(/URL\s+a\s+b/);
    expect(out).toMatch(/ONLYA\s+x\s+\(missing\)/);
    expect(out).not.toMatch(/\bS\s/); // secrets are compared by name only
    const u = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["library", "usage", "--group", "vg-dev"], u.ctx)).toBe(0);
    expect(u.lines.join(NL)).toContain("5 ci (definition)");
  });
});
