import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FabricIdentity, loadSpFile, readKeyVaultSecret, saveSpFile, scopeFor, certAssertion } from "../src/lib/fabric-auth.js";
import { redact } from "../src/lib/fabric-redact.js";
import { inferEnv } from "../src/lib/fabric.js";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, sh, tmp, write, type Route } from "./helpers.js";

const SECRET = "s3cr3t-value-XYZ";
const WS = "11111111-1111-1111-1111-111111111111";

function deps(extra: Record<string, string> = {}, over: Partial<Parameters<typeof mk>[0]> = {}) {
  return mk({ env: { AIHUB_HOME: tmp(), ...extra }, ...over });
}
function mk(o: { env: NodeJS.ProcessEnv; fetch?: typeof fetch; exec?: any; now?: () => number }) {
  return { env: o.env, fetch: o.fetch ?? (fakeFetch([]).fn as typeof fetch), exec: o.exec, now: o.now };
}
const sp = (name = "sp1", secretRef = "store:sp1") => ({ tenant: "tenant-1", clientId: `client-${name}`, secretRef });
const tokenRoute = (calls: string[], exp = 3600): Route => ({
  method: "POST",
  match: /login\.microsoftonline\.com\/tenant-1\/oauth2\/v2\.0\/token$/,
  respond: (c) => {
    calls.push(String(c.body));
    return { body: { access_token: `tok-${calls.length}`, expires_in: exp } };
  },
});

describe("identity precedence", () => {
  const withFile = (extra: Record<string, string>, flag?: string, def?: string, hint?: string) => {
    const d = deps(extra);
    saveSpFile(d, { default: def, principals: { flag: sp("flag"), envsp: sp("envsp"), team: sp("team"), usr: sp("usr") } });
    const id = new FabricIdentity(d, flag);
    id.hint(hint);
    return id.resolve();
  };
  it("--sp beats AIHUB_FABRIC_SP beats AZURE_CLIENT_* beats team.yaml beats the user default beats the token env beats az", () => {
    const all = { AIHUB_FABRIC_SP: "envsp", AZURE_CLIENT_ID: "c", AZURE_TENANT_ID: "t", AZURE_CLIENT_SECRET: "x", AIHUB_FABRIC_TOKEN: "tok" };
    expect(withFile(all, "flag", "usr", "team")).toMatchObject({ name: "flag", source: "--sp" });
    expect(withFile(all, undefined, "usr", "team")).toMatchObject({ name: "envsp", source: "AIHUB_FABRIC_SP" });
    const { AIHUB_FABRIC_SP: _a, ...noNamed } = all;
    expect(withFile(noNamed, undefined, "usr", "team")).toMatchObject({ name: "env", clientId: "c", tenant: "t" });
    const { AZURE_CLIENT_ID: _b, ...noEnvSp } = noNamed;
    expect(withFile(noEnvSp, undefined, "usr", "team")).toMatchObject({ name: "team", source: "team.yaml fabric.servicePrincipal" });
    expect(withFile(noEnvSp, undefined, "usr")).toMatchObject({ name: "usr" });
    expect(withFile({ AIHUB_FABRIC_TOKEN: "tok" })).toMatchObject({ kind: "token" });
    expect(withFile({})).toMatchObject({ kind: "user" });
  });
  it("names an unregistered service principal clearly", () => {
    const d = deps();
    saveSpFile(d, { principals: { known: sp("known") } });
    expect(() => new FabricIdentity(d, "nope").resolve()).toThrow(/'nope' is not registered.*registered: known/);
  });
});

describe("client credentials", () => {
  it("asks for the scope of each resource", async () => {
    const bodies: string[] = [];
    const d = deps({}, { fetch: fakeFetch([tokenRoute(bodies)]).fn as typeof fetch, exec: () => SECRET });
    saveSpFile(d, { principals: { sp1: sp() } });
    const id = new FabricIdentity(d, "sp1");
    for (const a of ["fabric", "storage", "sql", "powerbi"] as const) await id.token(a);
    const scopes = bodies.map((b) => new URLSearchParams(b).get("scope"));
    expect(scopes).toEqual(["https://api.fabric.microsoft.com/.default", "https://storage.azure.com/.default", "https://database.windows.net/.default", "https://analysis.windows.net/powerbi/api/.default"]);
    expect(scopeFor("powerbi")).toContain("analysis.windows.net");
    const form = new URLSearchParams(bodies[0]);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("client_id")).toBe("client-sp1");
    expect(form.get("client_secret")).toBe(SECRET);
  });

  it("caches per service principal and audience until shortly before expiry, also across processes", async () => {
    let t = 1_000_000;
    const bodies: string[] = [];
    const f = fakeFetch([tokenRoute(bodies, 3600)]).fn as typeof fetch;
    const base = deps({}, { fetch: f, exec: () => SECRET, now: () => t });
    saveSpFile(base, { principals: { sp1: sp() } });
    const a = new FabricIdentity(base, "sp1");
    expect(await a.token("fabric")).toBe("Bearer tok-1");
    expect(await a.token("fabric")).toBe("Bearer tok-1");
    expect(bodies).toHaveLength(1);
    await a.token("storage");
    expect(bodies).toHaveLength(2);
    expect(await new FabricIdentity(base, "sp1").token("fabric")).toBe("Bearer tok-1");
    expect(bodies).toHaveLength(2);
    t += 3600_000 - 60_000;
    expect(await new FabricIdentity(base, "sp1").token("fabric")).toBe("Bearer tok-3");
  });

  it("never prints the secret, also when the login answer echoes it", async () => {
    const f = fakeFetch([{ method: "POST", match: /oauth2/, respond: () => ({ status: 401, body: { error: "invalid_client", error_description: `AADSTS7000215: Invalid client secret provided: ${SECRET} client_secret=${SECRET}` } }) }]).fn as typeof fetch;
    const d = deps({}, { fetch: f, exec: () => SECRET });
    saveSpFile(d, { principals: { sp1: sp() } });
    const err = await new FabricIdentity(d, "sp1").token("fabric").catch((e: Error) => e.message);
    expect(String(err)).toContain("could not sign in");
    expect(String(err)).not.toContain(SECRET);
  });

  it("reads a Key Vault reference with az", async () => {
    const seen: string[][] = [];
    const exec = (c: string, a: string[]) => {
      seen.push([c, ...a]);
      return `${SECRET}\n`;
    };
    expect(readKeyVaultSecret(deps({}, { exec }), "kv://vault1/sp-secret")).toBe(SECRET);
    expect(seen[0].slice(0, 7)).toEqual(["az", "keyvault", "secret", "show", "--vault-name", "vault1", "--name"]);
    expect(() => readKeyVaultSecret(deps(), "kv://broken")).toThrow(/kv:\/\/<vault>\/<secret>/);
    expect(() => readKeyVaultSecret(deps({}, { exec: () => { throw new Error(`denied ${SECRET}`); } }), "kv://v/s")).toThrow(/could not read Key Vault secret v\/s/);
    const bodies: string[] = [];
    const d = deps({}, { fetch: fakeFetch([tokenRoute(bodies)]).fn as typeof fetch, exec });
    saveSpFile(d, { principals: { kv: sp("kv", "kv://vault1/sp-secret") } });
    await new FabricIdentity(d, "kv").token("fabric");
    expect(new URLSearchParams(bodies[0]).get("client_secret")).toBe(SECRET);
  });

  it("environment service principal without a secret or certificate is not used", () => {
    expect(new FabricIdentity(deps({ AZURE_CLIENT_ID: "c", AZURE_TENANT_ID: "t" })).resolve().kind).toBe("user");
    expect(() => certAssertion(join(tmp(), "none.pem"), "t", "c", 0)).toThrow();
    const p = join(tmp(), "k.pem");
    writeFileSync(p, "no cert here");
    expect(() => certAssertion(p, "t", "c", 0)).toThrow(/no CERTIFICATE block/);
  });
});

describe("redaction", () => {
  it("removes SAS signatures, bearer tokens, client secrets, connection string passwords and JWTs", () => {
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop";
    const text = `url https://x.blob.core.windows.net/c?sv=2020&sig=AbC%2Fdef&se=2030 Authorization: Bearer abcdefghijklmnop1234 client_secret=${SECRET} Server=x;Password=hunter2; ${jwt} AZURE_CLIENT_SECRET=${SECRET}`;
    const out = redact(text);
    for (const leak of ["AbC%2Fdef", "abcdefghijklmnop1234", SECRET, "hunter2", jwt]) expect(out).not.toContain(leak);
    expect(out).toContain("<redacted>");
    expect(redact("plain text without secrets")).toBe("plain text without secrets");
  });
  it("stage words of the legacy naming: acceptatie and productie", () => {
    expect(inferEnv("Data acceptatie")).toBe("acc");
    expect(inferEnv("Data DEV PRD")).toBe("prd");
    expect(inferEnv("UAT-sales")).toBe("acc");
  });
});

const TEAM = `version: 1
repositories:
  - name: test-repo
    defaultTarget: main
fabric:
  workspaces:
    - { name: DEV-test-project, id: ${WS}, environment: dev, servicePrincipal: sp1 }
    - { name: ACC-test-project, id: 33333333-3333-3333-3333-333333333333, environment: acc }
`;

function repo(): string {
  const { dir } = makeRepo();
  write(dir, ".agents/skills/_shared/references/team.yaml", TEAM);
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "team"]);
  return dir;
}

function run(routes: Route[], args: string[], env: Record<string, string> = {}, extra: (c: any) => void = () => {}) {
  const f = fakeFetch(routes);
  const { ctx, lines, errs } = ctxFor(repo(), f.fn);
  ctx.env = { ...ctx.env, AIHUB_POLL_MS: "0", ...env };
  extra(ctx);
  return main(["fabric", ...args], ctx).then((code) => ({ code, out: lines.join("\n"), errs, calls: f.calls, ctx }));
}

describe("aihub fabric auth", () => {
  it("adds, lists, defaults, tests and removes a service principal; the secret goes to the credential store only", async () => {
    const store: { cmd: string; args: string[]; input?: string }[] = [];
    const env = { AIHUB_HOME: tmp() };
    const mkx = (c: any) => {
      c.stdin = () => `${SECRET}\n`;
      c.exec = (cmd: string, args: string[], input?: string) => {
        store.push({ cmd, args, input });
        return SECRET;
      };
    };
    const a = await run([], ["auth", "sp", "add", "sp1", "--tenant", "tenant-1", "--client-id", "client-sp1", "--secret-from-stdin"], env, mkx);
    expect(a.out).toContain("registered service principal sp1");
    expect(a.out).not.toContain(SECRET);
    expect(store.some((s) => s.input === SECRET || s.args.includes(SECRET))).toBe(true);
    const file = loadSpFile({ env });
    expect(file.principals.sp1.secretRef).toBe("store:sp1");
    expect(JSON.stringify(file)).not.toContain(SECRET);

    const l = await run([], ["auth", "sp", "list"], env);
    expect(l.out).toContain("sp1 | tenant-1 | client-sp1 | credential store");
    const d = await run([], ["auth", "sp", "default", "sp1"], env);
    expect(d.out).toContain("default service principal: sp1");
    const st = await run([tokenRoute([])], ["auth", "status", "--json"], env, mkx);
    const j = JSON.parse(st.out);
    expect(j.result.identity).toMatchObject({ kind: "service-principal", name: "sp1", tenant: "tenant-1", source: "user default service principal" });
    expect(j.result.expires).toBeGreaterThan(Date.now());
    const t = await run([tokenRoute([]), { match: /\/v1\/workspaces$/, respond: () => ({ body: { value: [{ id: WS, displayName: "DEV-test-project" }] } }) }], ["auth", "sp", "test", "sp1"], env, mkx);
    expect(t.out).toContain("signed in and sees 1 workspace(s)");
    const c = await run([], ["auth", "sp", "default", "--clear"], env);
    expect(c.out).toContain("no default service principal");
    const r = await run([], ["auth", "sp", "remove", "sp1"], env);
    expect(r.out).toContain("removed service principal sp1");
    expect((await run([], ["auth", "sp", "remove", "sp1"], env)).errs[0]).toContain("not registered");
  });

  it("add needs exactly one secret source and a valid Key Vault reference", async () => {
    const env = { AIHUB_HOME: tmp() };
    const none = await run([], ["auth", "sp", "add", "x", "--tenant", "t", "--client-id", "c"], env);
    expect(none.errs[0]).toContain("exactly one of");
    const bad = await run([], ["auth", "sp", "add", "x", "--tenant", "t", "--client-id", "c", "--keyvault", "vault/secret"], env);
    expect(bad.errs[0]).toContain("kv://");
    const ok = await run([], ["auth", "sp", "add", "x", "--tenant", "t", "--client-id", "c", "--keyvault", "kv://v/s"], env);
    expect(loadSpFile({ env }).principals.x.secretRef).toBe("kv://v/s");
    expect(ok.out).toContain("registered");
  });

  it("status without a service principal reports the az user", async () => {
    const s = await run([], ["auth", "status"], { AIHUB_HOME: tmp(), AIHUB_FABRIC_TOKEN: "tok" });
    expect(s.out).toContain("identity: bearer token from AIHUB_FABRIC_TOKEN");
  });
});

describe("commands as a service principal", () => {
  const items = { match: new RegExp(`/workspaces/${WS}/items$`), respond: () => ({ body: { value: [{ id: "nb-1", displayName: "nb_load", type: "Notebook" }] } }) } as Route;
  const prep = () => {
    const env = { AIHUB_HOME: tmp() };
    saveSpFile({ env }, { principals: { sp1: sp() } });
    return env;
  };
  const ex = (c: any) => {
    c.exec = () => SECRET;
  };

  it("uses the team.yaml service principal of the workspace, reports it in --json, and sends its token", async () => {
    const env = prep();
    const bodies: string[] = [];
    const r = await run([tokenRoute(bodies), items], ["items", "--workspace", "DEV-test-project", "--json"], env, ex);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).identity).toMatchObject({ kind: "service-principal", name: "sp1", source: "team.yaml fabric.servicePrincipal" });
    const call = r.calls.find((c) => c.url.includes("/items"))!;
    expect(call.headers.Authorization).toBe("Bearer tok-1");
    expect(r.out).not.toContain(SECRET);
  });

  it("--sp overrides everything, and the ACC/PRD guard applies equally to a service principal", async () => {
    const env = prep();
    const bodies: string[] = [];
    const ok = await run([tokenRoute(bodies), items], ["items", "--workspace", "DEV-test-project", "--sp", "sp1"], { ...env, AIHUB_FABRIC_TOKEN: "user-token" }, ex);
    expect(ok.calls.find((c) => c.url.includes("/items"))!.headers.Authorization).toBe("Bearer tok-1");
    const acc = await run([tokenRoute(bodies), items], ["item", "delete", "--workspace", "ACC-test-project", "--item", "x", "--yes", "--sp", "sp1"], env, ex);
    expect(acc.code).toBe(1);
    expect(acc.errs[0]).toContain("is ACC");
    expect(acc.calls).toHaveLength(0);
  });

  it("a failed sign-in is explained without the secret", async () => {
    const env = prep();
    const r = await run([{ method: "POST", match: /oauth2/, respond: () => ({ status: 400, body: { error_description: `bad secret ${SECRET}` } }) }], ["items", "--workspace", "DEV-test-project"], env, ex);
    expect(r.code).toBe(1);
    expect(r.errs[0]).toContain("could not sign in");
    expect(r.errs[0]).not.toContain(SECRET);
  });
});
