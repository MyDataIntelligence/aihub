import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, type Route } from "./helpers.js";

const NL = String.fromCharCode(10);
const defn = (id: number, name: string, extra: object = {}) => ({ id, name, path: "\\", queueStatus: "enabled", process: { type: 2, yamlFilename: "ci/x.yml" }, repository: { id: "repo-guid", name: "test-repo", defaultBranch: "refs/heads/main" }, variableGroups: [{ id: 3, name: "vg-dev" }], triggers: [{ triggerType: "continuousIntegration" }], ...extra });

function routes(extra: Route[] = []): Route[] {
  return [
    { match: /_apis\/git\/repositories\/test-repo\?/, respond: () => ({ body: { id: "repo-guid", name: "test-repo" } }) },
    { match: /_apis\/build\/definitions\?/, respond: () => ({ body: { value: [defn(5, "ci"), defn(6, "deploy-prd")] } }) },
    { match: /_apis\/build\/definitions\/5\?/, respond: () => ({ body: defn(5, "ci") }) },
    { match: /_apis\/build\/definitions\/6\?/, respond: () => ({ body: defn(6, "deploy-prd") }) },
    ...extra,
  ];
}

describe("aihub pipeline def", () => {
  it("lists and shows definitions, creates a YAML pipeline, updates and deletes with --yes", async () => {
    const { dir } = makeRepo();
    const posted: any[] = [];
    const put: any[] = [];
    let del = 0;
    const r = routes([
      { method: "POST", match: /_apis\/pipelines\?/, respond: (c) => (posted.push(c.body), { body: { id: 9 } }) },
      { method: "PUT", match: /_apis\/build\/definitions\/5\?/, respond: (c) => (put.push(c.body), { body: {} }) },
      { method: "DELETE", match: /_apis\/build\/definitions\/5\?/, respond: () => (del++, { body: {} }) },
    ]);
    const l = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["pipeline", "def", "list"], l.ctx)).toBe(0);
    expect(l.lines.join(NL)).toContain("5     ci  ci/x.yml");
    const s = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["pipeline", "def", "show", "--pipeline", "5"], s.ctx)).toBe(0);
    expect(s.lines.join(NL)).toContain("variable groups vg-dev");
    expect(await main(["pipeline", "def", "create", "--name", "new-ci", "--yaml", "/ci/new.yml"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(posted[0]).toEqual({ name: "new-ci", folder: "\\", configuration: { type: "yaml", path: "ci/new.yml", repository: { id: "repo-guid", name: "test-repo", type: "azureReposGit" } } });
    expect(await main(["pipeline", "def", "update", "--pipeline", "ci", "--status", "paused", "--name", "ci2"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(put[0]).toMatchObject({ id: 5, name: "ci2", queueStatus: "paused" });
    expect(await main(["pipeline", "def", "delete", "--pipeline", "5"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(1);
    expect(del).toBe(0);
    expect(await main(["pipeline", "def", "delete", "--pipeline", "5", "--yes"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(del).toBe(1);
  });

  it("refuses to change a PRD pipeline unless --allow-env prd", async () => {
    const { dir } = makeRepo();
    let del = 0;
    const r = routes([{ method: "DELETE", match: /_apis\/build\/definitions\/6\?/, respond: () => (del++, { body: {} }) }]);
    const a = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["pipeline", "def", "delete", "--pipeline", "6", "--yes"], a.ctx)).toBe(1);
    expect(a.errs.join(NL)).toContain("is PRD");
    expect(del).toBe(0);
    expect(await main(["pipeline", "def", "delete", "--pipeline", "6", "--yes", "--allow-env", "prd"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(del).toBe(1);
  });
});

describe("aihub pipeline validate, cancel, artifacts", () => {
  it("validates YAML by a preview run and reports the errors", async () => {
    const { dir } = makeRepo();
    const bodies: any[] = [];
    let bad = false;
    const r = routes([{ method: "POST", match: /_apis\/pipelines\/5\/runs\?/, respond: (c) => (bodies.push(c.body), bad ? { status: 400, body: { message: "/ci/x.yml (Line: 3, Col: 1): Unexpected value 'stepz'" } } : { body: { finalYaml: "steps:" + NL + "- script: x" } }) }]);
    const f = join(dir, "x.yml");
    writeFileSync(f, "steps:\n- script: x\n");
    const ok = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["pipeline", "validate", "--pipeline", "ci", "--file", f], ok.ctx)).toBe(0);
    expect(bodies[0]).toMatchObject({ previewRun: true, yamlOverride: "steps:\n- script: x\n", resources: { repositories: { self: { refName: "refs/heads/main" } } } });
    expect(ok.lines.join(NL)).toContain("the YAML is valid (2 lines");
    bad = true;
    const e = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["pipeline", "validate", "--pipeline", "ci"], e.ctx)).toBe(1);
    expect(e.errs.join(NL)).toContain("NOT valid: /ci/x.yml (Line: 3, Col: 1): Unexpected value 'stepz'");
  });

  it("cancels a run (guarded by the pipeline name), and lists and downloads artifacts", async () => {
    const { dir } = makeRepo();
    const patched: any[] = [];
    const dl = "https://dev.azure.com/ferron-org/proj/_apis/build/builds/21/artifacts?artifactName=drop&api-version=7.1&%24format=zip";
    const r = routes([
      { match: /_apis\/build\/builds\/20\?/, respond: () => ({ body: { id: 20, status: "inProgress", definition: { name: "ci" } } }) },
      { match: /_apis\/build\/builds\/22\?/, respond: () => ({ body: { id: 22, status: "inProgress", definition: { name: "deploy-prd" } } }) },
      { method: "PATCH", match: /_apis\/build\/builds\/20\?/, respond: (c) => (patched.push(c.body), { body: {} }) },
      { match: /_apis\/build\/builds\/21\/artifacts\?artifactName/, respond: () => ({ text: "ZIPBYTES" }) },
      { match: /_apis\/build\/builds\/21\/artifacts\?/, respond: () => ({ body: { value: [{ id: 1, name: "drop", resource: { type: "Container", downloadUrl: dl, properties: { artifactsize: "2048" } } }] } }) },
    ]);
    expect(await main(["pipeline", "cancel", "--run", "20"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(patched).toEqual([{ status: "cancelling" }]);
    const g = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["pipeline", "cancel", "--run", "22"], g.ctx)).toBe(1);
    expect(g.errs.join(NL)).toContain("is PRD");
    const l = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["pipeline", "artifacts", "list", "--run", "21"], l.ctx)).toBe(0);
    expect(l.lines.join(NL)).toMatch(/drop\s+Container\s+2 KB/);
    const out = join(dir, "dl");
    const d = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["pipeline", "artifacts", "download", "--run", "21", "--out", out], d.ctx)).toBe(0);
    expect(existsSync(join(out, "drop.zip"))).toBe(true);
    expect(readFileSync(join(out, "drop.zip"), "utf8")).toBe("ZIPBYTES");
  });
});

describe("aihub pipeline env, approvals, securefiles, connections", () => {
  const envs = [{ id: 3, name: "dev", description: "dev stage" }, { id: 4, name: "prd" }];
  const approval = (id: string, env: string) => ({ id, status: "pending", createdOn: "2026-11-18T10:00:00Z", pipeline: { name: "deploy", owner: { id: 31, name: "deploy" } }, resource: { type: "environment", name: env }, steps: [{ assignedApprover: { displayName: "Ann" } }] });
  const r = (patched: any[] = []): Route[] =>
    routes([
      { match: /pipelines\/environments\/3\/environmentdeploymentrecords\?/, respond: () => ({ body: { value: [{ owner: { id: 31 }, definition: { name: "deploy" }, stageName: "release", result: "succeeded", startTime: "2026-11-18T09:00:00Z" }] } }) },
      { match: /pipelines\/environments\/3\?/, respond: () => ({ body: { ...envs[0], resources: [{ type: "kubernetes", name: "k1" }] } }) },
      { match: /pipelines\/environments\?/, respond: () => ({ body: { value: envs } }) },
      { method: "POST", match: /pipelines\/environments\?/, respond: (c) => (patched.push(c.body), { body: { id: 8 } }) },
      { match: /pipelines\/checks\/configurations\?/, respond: () => ({ body: { value: [{ id: 5, type: { name: "Approval" }, timeout: 1440, settings: { approvers: [{ displayName: "Ann" }] } }] } }) },
      { match: /pipelines\/approvals\/a1\?/, respond: () => ({ body: approval("a1", "dev") }) },
      { match: /pipelines\/approvals\/a2\?/, respond: () => ({ body: approval("a2", "prd") }) },
      { match: /pipelines\/approvals\?/, respond: () => ({ body: { value: [approval("a1", "dev"), approval("a2", "prd")] } }) },
      { method: "PATCH", match: /pipelines\/approvals\?/, respond: (c) => (patched.push(c.body), { body: {} }) },
      { match: /distributedtask\/securefiles\?/, respond: () => ({ body: { value: [{ id: "f", name: "cert.pfx", createdBy: { displayName: "Ann" }, modifiedOn: "2026-11-01T00:00:00Z", properties: { secret: "x" } }] } }) },
      { match: /serviceendpoint\/endpoints\?/, respond: () => ({ body: { value: [{ id: "e", name: "kv-conn", type: "azurerm", isReady: true, authorization: { scheme: "ServicePrincipal", parameters: { serviceprincipalkey: "TOPSECRET" } } }] } }) },
    ]);

  it("lists, shows, creates environments and reads checks and deployments", async () => {
    const { dir } = makeRepo();
    const posted: any[] = [];
    const run = async (a: string[]) => {
      const c = ctxFor(dir, fakeFetch(r(posted)).fn);
      const code = await main(a, c.ctx);
      return { code, out: c.lines.join(NL), err: c.errs.join(NL) };
    };
    expect((await run(["pipeline", "env", "list"])).out).toMatch(/3\s+dev\s+dev stage/);
    expect((await run(["pipeline", "env", "show", "--env", "dev"])).out).toContain("resources kubernetes:k1");
    expect((await run(["pipeline", "env", "deployments", "--env", "dev"])).out).toMatch(/31\s+deploy\s+release\s+succeeded\s+2026-11-18/);
    expect((await run(["pipeline", "env", "checks", "--env", "dev"])).out).toContain("#5 Approval (Ann) timeout 1440 min");
    expect((await run(["pipeline", "env", "create", "--name", "test-env"])).code).toBe(0);
    expect(posted[0]).toMatchObject({ name: "test-env" });
    expect((await run(["pipeline", "env", "create", "--name", "prd"])).err).toContain("is PRD");
  });

  it("approves a dev approval and refuses a PRD one", async () => {
    const { dir } = makeRepo();
    const patched: any[] = [];
    const run = async (a: string[]) => {
      const c = ctxFor(dir, fakeFetch(r(patched)).fn);
      const code = await main(a, c.ctx);
      return { code, out: c.lines.join(NL), err: c.errs.join(NL) };
    };
    expect((await run(["pipeline", "approvals", "list"])).out).toMatch(/a2\s+pending\s+prd/);
    expect((await run(["pipeline", "approvals", "approve", "--approval", "a1", "--comment", "ok"])).code).toBe(0);
    expect(patched[0]).toEqual([{ approvalId: "a1", status: "approved", comment: "ok" }]);
    patched.length = 0;
    const refused = await run(["pipeline", "approvals", "approve", "--approval", "a2"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("is PRD");
    expect(patched).toEqual([]);
    expect((await run(["pipeline", "approvals", "reject", "--approval", "a2", "--allow-env", "prd"])).code).toBe(0);
    expect(patched[0][0]).toMatchObject({ approvalId: "a2", status: "rejected" });
  });

  it("shows secure files and service connections as metadata only, never credentials", async () => {
    const { dir } = makeRepo();
    const f = ctxFor(dir, fakeFetch(r()).fn);
    expect(await main(["pipeline", "securefiles", "list"], f.ctx)).toBe(0);
    expect(f.lines.join(NL)).toMatch(/cert\.pfx\s+2026-11-01\s+Ann/);
    expect(f.lines.join(NL)).not.toContain("secret");
    const c = ctxFor(dir, fakeFetch(r()).fn);
    expect(await main(["pipeline", "connections", "show", "--name", "kv-conn", "--json"], c.ctx)).toBe(0);
    expect(c.lines.join(NL)).not.toContain("TOPSECRET");
    expect(JSON.parse(c.lines.join(NL))[0]).toMatchObject({ name: "kv-conn", type: "azurerm", scheme: "ServicePrincipal", ready: true });
  });
});

describe("aihub devops (read only)", () => {
  it("lists projects, teams with members, pools with agents and checks a permission", async () => {
    const { dir } = makeRepo();
    const r: Route[] = [
      { match: /ferron-org\/_apis\/projects\?/, respond: () => ({ body: { value: [{ id: "p1", name: "test-project", state: "wellFormed", description: "synthetic" }] } }) },
      { match: /_apis\/projects\/test-project\/teams\/t1\/members\?/, respond: () => ({ body: { value: [{ identity: { displayName: "Ann", uniqueName: "ann@example.invalid" }, isTeamAdmin: true }] } }) },
      { match: /_apis\/projects\/test-project\/teams\?/, respond: () => ({ body: { value: [{ id: "t1", name: "test-project Team", description: "default" }] } }) },
      { match: /_apis\/distributedtask\/pools\/7\/agents\?/, respond: () => ({ body: { value: [{ name: "agent-1", status: "online", enabled: true, version: "4.0", osDescription: "Linux" }] } }) },
      { match: /_apis\/distributedtask\/pools\?/, respond: () => ({ body: { value: [{ id: 7, name: "Default", isHosted: false, size: 1 }] } }) },
      { match: /_apis\/securitynamespaces\?/, respond: () => ({ body: { value: [{ namespaceId: "ns-git", name: "Git Repositories", actions: [{ name: "GenericContribute", bit: 4 }, { name: "PullRequestContribute", bit: 16384 }] }] } }) },
      { match: /_apis\/permissions\/ns-git\/4\?/, respond: (c) => (expect(c.url).toContain("tokens=repoV2%2Fp1%2Fr1"), { body: { value: [true] } }) },
      { match: /_apis\/permissions\/ns-git\/16384\?/, respond: () => ({ body: { value: [false] } }) },
    ];
    const run = async (a: string[]) => {
      const c = ctxFor(dir, fakeFetch(r).fn);
      expect(await main(a, c.ctx)).toBe(0);
      return c.lines.join(NL);
    };
    expect(await run(["devops", "projects"])).toMatch(/test-project\s+wellFormed\s+synthetic/);
    expect(await run(["devops", "teams"])).toMatch(/test-project Team\s+default/);
    expect(await run(["devops", "teams", "--members", "test-project Team"])).toContain("Ann <ann@example.invalid> (admin)");
    expect(await run(["devops", "pools", "--agents", "Default"])).toMatch(/agent-1\s+online\s+yes\s+4\.0/);
    expect(await run(["devops", "permissions", "check", "--namespace", "Git Repositories", "--token", "repoV2/p1/r1", "--actions", "GenericContribute,PullRequestContribute"])).toBe("allowed GenericContribute" + NL + "DENIED  PullRequestContribute");
  });
});
