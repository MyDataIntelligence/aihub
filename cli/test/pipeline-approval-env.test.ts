import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, type Route } from "./helpers.js";

const NL = String.fromCharCode(10);

// The real answer of pipelines/approvals names no environment (proven live in ferron-test): the guard must read it from the run's YAML.
function routes(yaml: string, patched: any[]): Route[] {
  return [
    { match: /pipelines\/approvals\/a1\?/, respond: () => ({ body: { id: "a1", status: "pending", pipeline: { id: "17", name: "deploy", owner: { id: 283, name: "20261118.1" } } } }) },
    { match: /_apis\/build\/builds\/283\?/, respond: () => ({ body: { definition: { id: 17 }, sourceVersion: "abc123" } }) },
    { match: /_apis\/build\/definitions\/17\?/, respond: () => ({ body: { id: 17, name: "deploy", process: { type: 2, yamlFilename: "ci/deploy.yml" }, repository: { id: "repo-guid", type: "TfsGit" } } }) },
    { match: /git\/repositories\/repo-guid\/items\?/, respond: () => ({ text: yaml }) },
    { method: "PATCH", match: /pipelines\/approvals\?/, respond: (c) => (patched.push(c.body), { body: {} }) },
  ];
}

async function decide(yaml: string, extra: string[] = []) {
  const { dir } = makeRepo();
  const patched: any[] = [];
  const c = ctxFor(dir, fakeFetch(routes(yaml, patched)).fn);
  const code = await main(["pipeline", "approvals", "reject", "--approval", "a1", ...extra], c.ctx);
  return { code, err: c.errs.join(NL), patched };
}

describe("approvals whose answer names no environment", () => {
  it("refuses when the run's YAML deploys to an ACC or PRD environment", async () => {
    const r = await decide("stages:\n- stage: Deploy\n  jobs:\n  - deployment: d\n    environment: shop-prd\n");
    expect(r.code).toBe(1);
    expect(r.err).toContain("is PRD");
    expect(r.patched).toEqual([]);
  });

  it("handles the nested environment name form", async () => {
    const r = await decide("jobs:\n- deployment: d\n  environment:\n    name: shop-acc\n");
    expect(r.code).toBe(1);
    expect(r.err).toContain("is ACC");
  });

  it("allows a dev environment", async () => {
    const r = await decide("jobs:\n- deployment: d\n  environment: shop-dev\n");
    expect(r.code).toBe(0);
    expect(r.patched[0][0]).toMatchObject({ approvalId: "a1", status: "rejected" });
  });

  it("fails closed when no environment can be found, unless --allow-env is given", async () => {
    const none = await decide("steps:\n- script: echo\n");
    expect(none.code).toBe(1);
    expect(none.err).toContain("cannot tell which environment");
    expect(none.patched).toEqual([]);
    const forced = await decide("steps:\n- script: echo\n", ["--allow-env", "acc"]);
    expect(forced.code).toBe(0);
  });
});
