import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPlan, chooseWorkspace, executionDataFromParams, fabricWorkspaces, formatJob, mapItems } from "../src/lib/fabric.js";
import { globMatch } from "../src/lib/glob.js";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, sh, tmp, write } from "./helpers.js";

const TEAM = `version: 1
repositories:
  - name: test-repo
    defaultTarget: main
fabric:
  workspaces:
    - { name: DEV-test-project, id: 11111111-1111-1111-1111-111111111111, environment: dev }
    - { name: FEAT-test-project, id: 22222222-2222-2222-2222-222222222222, environment: feature, branches: ["feature/*"] }
    - { name: ACC-test-project, id: 33333333-3333-3333-3333-333333333333, environment: acc }
    - { name: PRD-test-project, id: 44444444-4444-4444-4444-444444444444, environment: prd }
`;
const list = fabricWorkspaces({ fabric: { workspaces: [] } } as any);

function repoWithChanges(files: string[], team: string = TEAM): string {
  const { dir } = makeRepo();
  write(dir, ".agents/skills/_shared/references/team.yaml", team);
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "team"]);
  sh(dir, ["push", "origin", "main"]);
  sh(dir, ["checkout", "-b", "feature/12-orders"]);
  for (const f of files) write(dir, f, "x\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "change"]);
  return dir;
}

describe("item mapping", () => {
  it("maps git-integration folders to items, dependencies first, ignoring other files", () => {
    const items = mapItems([
      "fabric/nb_load_orders.Notebook/notebook-content.py",
      "fabric/nb_load_orders.Notebook/.platform",
      "fabric/pl_orders.DataPipeline/pipeline-content.json",
      "fabric/lh_core.Lakehouse/.platform",
      "README.md",
      "src/app.py",
    ]);
    expect(items.map((i) => `${i.type}:${i.name}:${i.files}`)).toEqual(["Lakehouse:lh_core:1", "Notebook:nb_load_orders:2", "DataPipeline:pl_orders:1"]);
    expect(items[0].jobType).toBeUndefined();
    expect(items[1].jobType).toBe("RunNotebook");
    expect(items[2].jobType).toBe("Pipeline");
  });

  it("returns nothing for a change without Fabric items", () => {
    expect(mapItems(["docs/a.md"])).toEqual([]);
  });

  it("globs", () => {
    expect(globMatch("feature/*", "feature/12-x")).toBe(true);
    expect(globMatch("feature/*", "feature/a/b")).toBe(false);
    expect(globMatch("src/**", "src/a/b.py")).toBe(true);
    expect(globMatch("**/*.robot", "t/x/a.robot")).toBe(true);
  });
});

describe("workspace choice", () => {
  const ws = fabricWorkspaces(JSON.parse(JSON.stringify({ fabric: { workspaces: [
    { name: "DEV-test-project", environment: "DEV" },
    { name: "FEAT-test-project", environment: "feature", branches: ["feature/*"] },
  ] } })));
  it("uses the branch rule, then feature, then dev; explicit name wins", () => {
    expect(chooseWorkspace(ws, { branch: "feature/1-x" })?.name).toBe("FEAT-test-project");
    expect(chooseWorkspace(ws, { branch: "main" })?.name).toBe("FEAT-test-project");
    expect(chooseWorkspace(ws, { workspace: "dev-test-project" })?.name).toBe("DEV-test-project");
    expect(chooseWorkspace(ws, { workspace: "nope" })).toBeUndefined();
    expect(buildPlan(["a.Notebook/x"], ws, {}).items).toHaveLength(1);
  });
  void list;
});

describe("params file", () => {
  it("types notebook parameters and passes pipeline parameters as is", () => {
    expect(executionDataFromParams('{"limit": 10, "ratio": 0.5, "full": true, "name": "a"}', { type: "Notebook" })).toEqual({
      parameters: {
        limit: { value: 10, type: "int" },
        ratio: { value: 0.5, type: "float" },
        full: { value: true, type: "bool" },
        name: { value: "a", type: "string" },
      },
    });
    expect(executionDataFromParams('{"parameters": {"limit": 10}}', { type: "DataPipeline" })).toEqual({ parameters: { limit: 10 } });
    expect(() => executionDataFromParams("nope", { type: "Notebook" })).toThrow(/JSON/);
  });
  it("formats a failed job with the reason", () => {
    expect(formatJob({ id: "j1", status: "Failed", failureReason: { errorCode: "SparkError", message: "Cell 3\nfailed" } }, "nb")).toContain("failure: SparkError: Cell 3 failed");
  });
});

describe("aihub fabric plan", () => {
  it("prints items in order for the branch workspace", async () => {
    const dir = repoWithChanges(["fabric/nb_load_orders.Notebook/notebook-content.py", "fabric/pl_orders.DataPipeline/pipeline-content.json", "src/x.py"]);
    const { ctx, lines } = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(["fabric", "plan"], ctx)).toBe(0);
    const out = lines[0].split("\n");
    expect(out.slice(0, 3)).toEqual([
      "Fabric plan for feature/12-orders (vs main):",
      "workspace: FEAT-test-project (feature)",
      "1. Notebook nb_load_orders (1 file): run: aihub fabric run --item nb_load_orders --wait",
    ]);
    expect(out[3]).toContain("deploy: aihub fabric item update --workspace FEAT-test-project --item nb_load_orders --type Notebook --definition-dir fabric/nb_load_orders.Notebook");
    expect(out[3]).toContain("item create --workspace FEAT-test-project --type Notebook --name nb_load_orders --definition-dir fabric/nb_load_orders.Notebook");
    expect(out[4]).toContain("2. DataPipeline pl_orders (1 file): run: aihub fabric run --item pl_orders --wait");
  });

  it("uses the feature workspace for a feature branch given with --branch", async () => {
    const dir = repoWithChanges(["fabric/nb_a.Notebook/x"]);
    const { ctx, lines } = ctxFor(dir, fakeFetch([]).fn);
    await main(["fabric", "plan", "--branch", "feature/12-orders"], ctx);
    expect(lines[0]).toContain("workspace: FEAT-test-project (feature)");
  });

  it("says so when no Fabric item changed", async () => {
    const dir = repoWithChanges(["src/x.py"]);
    const { ctx, lines } = ctxFor(dir, fakeFetch([]).fn);
    await main(["fabric", "plan"], ctx);
    expect(lines[0]).toContain("nothing to run in Fabric");
  });
});

const WS = "22222222-2222-2222-2222-222222222222";
function fabricRoutes(jobStates: any[]) {
  let polls = 0;
  return fakeFetch([
    {
      match: new RegExp(`/v1/workspaces/${WS}/items$`),
      respond: () => ({ body: { value: [{ id: "item-1", displayName: "nb_load_orders", type: "Notebook" }, { id: "item-2", displayName: "lh_core", type: "Lakehouse" }] } }),
    },
    {
      method: "POST",
      match: /\/items\/item-1\/jobs\/instances\?jobType=RunNotebook$/,
      respond: () => ({ status: 202, headers: { location: `https://api.fabric.microsoft.com/v1/workspaces/${WS}/items/item-1/jobs/instances/job-9` } }),
    },
    {
      match: /\/items\/item-1\/jobs\/instances\/job-9$/,
      respond: () => ({ body: jobStates[Math.min(polls++, jobStates.length - 1)] }),
    },
  ]);
}

describe("aihub fabric run/status", () => {
  const env = { AIHUB_FABRIC_TOKEN: "synthetic-token", AIHUB_POLL_MS: "0" };

  it("starts a notebook job with parameters and waits for completion", async () => {
    const dir = repoWithChanges(["fabric/nb_load_orders.Notebook/x"]);
    const pf = join(tmp(), "p.json");
    writeFileSync(pf, '{"limit": 5}');
    const { fn, calls } = fabricRoutes([{ id: "job-9", status: "InProgress" }, { id: "job-9", status: "Completed", startTimeUtc: "2026-01-01T10:00:00Z", endTimeUtc: "2026-01-01T10:01:00Z" }]);
    const { ctx, lines } = ctxFor(dir, fn);
    ctx.env = env;
    expect(await main(["fabric", "run", "--item", "nb_load_orders", "--workspace", "FEAT-test-project", "--params-file", pf, "--wait"], ctx)).toBe(0);
    expect(lines[0]).toBe("started Notebook nb_load_orders in FEAT-test-project (feature): job job-9");
    expect(lines[1]).toContain("job job-9: Completed (nb_load_orders)");
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ executionData: { parameters: { limit: { value: 5, type: "int" } } } });
    expect(post.headers.Authorization).toBe("Bearer synthetic-token");
  });

  it("prints the failure reason and exits 1 when the job fails", async () => {
    const dir = repoWithChanges(["fabric/nb_load_orders.Notebook/x"]);
    const { fn } = fabricRoutes([{ id: "job-9", status: "Failed", failureReason: { errorCode: "SparkError", message: "boom" } }]);
    const { ctx, lines, errs } = ctxFor(dir, fn);
    ctx.env = env;
    expect(await main(["fabric", "run", "--item", "nb_load_orders", "--workspace", "FEAT-test-project", "--wait"], ctx)).toBe(1);
    expect(lines.join("\n")).toContain("failure: SparkError: boom");
    expect(errs[0]).toContain("ended as Failed");
  });

  it("status reads one job", async () => {
    const dir = repoWithChanges(["fabric/nb_load_orders.Notebook/x"]);
    const { fn } = fabricRoutes([{ id: "job-9", status: "InProgress" }]);
    const { ctx, lines } = ctxFor(dir, fn);
    ctx.env = env;
    expect(await main(["fabric", "status", "--item", "nb_load_orders", "--job", "job-9", "--workspace", "FEAT-test-project"], ctx)).toBe(0);
    expect(lines[0]).toBe("job job-9: InProgress (nb_load_orders)");
  });

  it("refuses acc and prd workspaces without --allow-env, before any Fabric call", async () => {
    const dir = repoWithChanges(["fabric/nb_load_orders.Notebook/x"]);
    for (const w of ["ACC-test-project", "PRD-test-project"]) {
      const { fn, calls } = fabricRoutes([{ id: "job-9", status: "Completed" }]);
      const { ctx, errs } = ctxFor(dir, fn);
      ctx.env = env;
      expect(await main(["fabric", "run", "--item", "nb_load_orders", "--workspace", w], ctx)).toBe(1);
      expect(errs).toHaveLength(1);
      expect(errs[0]).toContain(`workspace '${w}' is ${w.slice(0, 3)}`);
      expect(errs[0]).toContain("developer runs");
      expect(calls).toHaveLength(0);
    }
  });

  it("an --allow-env for another environment does not unlock acc", async () => {
    const dir = repoWithChanges(["x.txt"]);
    const { fn, calls } = fabricRoutes([]);
    const { ctx, errs } = ctxFor(dir, fn);
    ctx.env = env;
    expect(await main(["fabric", "run", "--item", "nb_load_orders", "--workspace", "ACC-test-project", "--allow-env", "prd"], ctx)).toBe(1);
    expect(errs[0]).toContain("ACC");
    expect(calls).toHaveLength(0);
  });

  it("runs in acc only with the explicit matching --allow-env", async () => {
    const dir = repoWithChanges(["x.txt"]);
    const acc = "33333333-3333-3333-3333-333333333333";
    const { fn, calls } = fakeFetch([
      { match: new RegExp(`/workspaces/${acc}/items$`), respond: () => ({ body: { value: [{ id: "item-1", displayName: "nb_load_orders", type: "Notebook" }] } }) },
      { method: "POST", match: /jobs\/instances\?jobType=RunNotebook$/, respond: () => ({ status: 202, headers: { location: "https://x/v1/workspaces/w/items/item-1/jobs/instances/job-1" } }) },
    ]);
    const { ctx, lines } = ctxFor(dir, fn);
    ctx.env = env;
    expect(await main(["fabric", "run", "--item", "nb_load_orders", "--workspace", "ACC-test-project", "--allow-env", "acc"], ctx)).toBe(0);
    expect(lines[0]).toContain("(acc)");
    expect(calls.some((c) => c.method === "POST")).toBe(true);
  });

  it("a workspace that team.yaml does not list is resolved through the API, with did-you-mean", async () => {
    const dir = repoWithChanges(["x.txt"]);
    const { ctx, errs } = ctxFor(dir, fakeFetch([{ match: /\/v1\/workspaces$/, respond: () => ({ body: { value: [{ id: "x", displayName: "SOMETHING-elsewhere" }] } }) }]).fn);
    ctx.env = env;
    expect(await main(["fabric", "run", "--item", "a", "--workspace", "SOMETHING-else"], ctx)).toBe(1);
    expect(errs[0]).toContain("did you mean: SOMETHING-elsewhere");
    expect(errs[0]).toContain("SOMETHING-else");
    expect(errs[0]).not.toContain("team.yaml");
  });

  it("explains an item that cannot run on demand", async () => {
    const dir = repoWithChanges(["x.txt"]);
    const { fn } = fabricRoutes([]);
    const { ctx, errs } = ctxFor(dir, fn);
    ctx.env = env;
    expect(await main(["fabric", "run", "--item", "lh_core", "--workspace", "FEAT-test-project"], ctx)).toBe(1);
    expect(errs[0]).toContain("cannot run on demand");
  });

  it("asks to sign in when there is no token", async () => {
    const dir = repoWithChanges(["x.txt"]);
    const { fn } = fabricRoutes([]);
    const { ctx, errs } = ctxFor(dir, fn);
    ctx.env = {};
    ctx.exec = () => {
      throw new Error("no az");
    };
    ctx.tokenCache = join(tmp(), "none.json");
    expect(await main(["fabric", "run", "--item", "nb_load_orders", "--workspace", "FEAT-test-project"], ctx)).toBe(1);
    expect(errs[0]).toContain("az login");
  });

  it("gets a token from az when the env var is absent", async () => {
    const dir = repoWithChanges(["x.txt"]);
    const { fn, calls } = fabricRoutes([{ id: "job-9", status: "Completed" }]);
    const { ctx } = ctxFor(dir, fn);
    ctx.env = { AIHUB_POLL_MS: "0" };
    const seen: string[][] = [];
    ctx.exec = (_c, args) => {
      seen.push(args);
      return JSON.stringify({ accessToken: "az-token", expires_on: String(Math.floor(Date.now() / 1000) + 3600) });
    };
    ctx.tokenCache = join(tmp(), "t.json");
    await main(["fabric", "run", "--item", "nb_load_orders", "--workspace", "FEAT-test-project"], ctx);
    expect(seen[0]).toContain("https://api.fabric.microsoft.com");
    expect(calls[0].headers.Authorization).toBe("Bearer az-token");
  });
});

describe("several workspaces", () => {
  const A = "11111111-1111-1111-1111-111111111111";
  const B = "55555555-5555-5555-5555-555555555555";
  const MULTI = `version: 1
repositories:
  - name: test-repo
    defaultTarget: main
fabric:
  workspaces:
    - { name: DEV-anna, id: ${A}, environment: dev, branches: ["feature/*"] }
    - { name: DEV-shared, id: ${B}, environment: dev, branches: ["feature/*"] }
    - { name: ACC-test-project, id: 33333333-3333-3333-3333-333333333333, environment: acc }
  workspaceGroups:
    devs: [DEV-anna, DEV-shared]
    risky: [DEV-anna, ACC-test-project]
`;
  const env = { AIHUB_FABRIC_TOKEN: "synthetic-token", AIHUB_POLL_MS: "0" };

  function routes(opts: { missingIn?: string; failIn?: string } = {}) {
    const r: any[] = [];
    for (const [ws, tag] of [[A, "a"], [B, "b"]] as const) {
      r.push({
        match: new RegExp(`/v1/workspaces/${ws}/items$`),
        respond: () => ({ body: { value: opts.missingIn === ws ? [] : [{ id: `item-${tag}`, displayName: "nb_load_orders", type: "Notebook" }] } }),
      });
      r.push({
        method: "POST",
        match: new RegExp(`/workspaces/${ws}/items/item-${tag}/jobs/instances\\?jobType=RunNotebook$`),
        respond: () => ({ status: 202, headers: { location: `https://x/v1/workspaces/${ws}/items/item-${tag}/jobs/instances/job-${tag}` } }),
      });
      r.push({
        match: new RegExp(`/workspaces/${ws}/items/item-${tag}/jobs/instances/job-${tag}$`),
        respond: () => ({
          body: opts.failIn === ws ? { id: `job-${tag}`, status: "Failed", failureReason: { errorCode: "E", message: "boom" } } : { id: `job-${tag}`, status: "Completed" },
        }),
      });
    }
    return fakeFetch(r);
  }

  it("plan lists every workspace the branch rules match", async () => {
    const dir = repoWithChanges(["fabric/nb_load_orders.Notebook/x"], MULTI);
    const { ctx, lines } = ctxFor(dir, fakeFetch([]).fn);
    await main(["fabric", "plan"], ctx);
    expect(lines[0]).toContain("workspaces (branch rules): DEV-anna (dev), DEV-shared (dev)");
    expect(lines[0]).toContain("aihub fabric run --item nb_load_orders --workspace DEV-anna --workspace DEV-shared --wait");
  });

  it("runs the item in two --workspace flags and prints a results table", async () => {
    const dir = repoWithChanges(["x.txt"], MULTI);
    const { fn } = routes();
    const { ctx, lines } = ctxFor(dir, fn);
    ctx.env = env;
    expect(await main(["fabric", "run", "--item", "nb_load_orders", "--workspace", "DEV-anna", "--workspace", "DEV-shared", "--wait"], ctx)).toBe(0);
    const table = lines[lines.length - 1].split("\n");
    expect(table[0]).toBe("workspace | environment | job | result");
    expect(table[1]).toBe("DEV-anna | dev | job-a | Completed");
    expect(table[2]).toBe("DEV-shared | dev | job-b | Completed");
  });

  it("a group from team.yaml runs all its workspaces; errors in one do not stop the others", async () => {
    const dir = repoWithChanges(["x.txt"], MULTI);
    const { fn, calls } = routes({ missingIn: A });
    const { ctx, lines, errs } = ctxFor(dir, fn);
    ctx.env = env;
    expect(await main(["fabric", "run", "--item", "nb_load_orders", "--workspaces", "devs", "--wait"], ctx)).toBe(1);
    const table = lines[lines.length - 1].split("\n");
    expect(table[1]).toContain("DEV-anna | dev | - | error: item 'nb_load_orders' not found");
    expect(table[2]).toBe("DEV-shared | dev | job-b | Completed");
    expect(errs[0]).toContain("1 of 2 workspaces did not complete: DEV-anna");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("shows the failure reason of a failed workspace and still reports the other", async () => {
    const dir = repoWithChanges(["x.txt"], MULTI);
    const { fn } = routes({ failIn: B });
    const { ctx, lines } = ctxFor(dir, fn);
    ctx.env = env;
    expect(await main(["fabric", "run", "--item", "nb_load_orders", "--workspaces", "devs", "--wait"], ctx)).toBe(1);
    const table = lines[lines.length - 1].split("\n");
    expect(table[1]).toBe("DEV-anna | dev | job-a | Completed");
    expect(table[2]).toBe("DEV-shared | dev | job-b | Failed: boom");
  });

  it("refuses the whole run before any call when a group contains acc, unless allowed", async () => {
    const dir = repoWithChanges(["x.txt"], MULTI);
    const { fn, calls } = routes();
    const { ctx, errs } = ctxFor(dir, fn);
    ctx.env = env;
    expect(await main(["fabric", "run", "--item", "nb_load_orders", "--workspaces", "risky"], ctx)).toBe(1);
    expect(errs[0]).toContain("ACC");
    expect(calls).toHaveLength(0);
  });

  it("rejects an unknown group and an unknown workspace among several", async () => {
    const dir = repoWithChanges(["x.txt"], MULTI);
    const a = ctxFor(dir, routes().fn);
    a.ctx.env = env;
    expect(await main(["fabric", "run", "--item", "n", "--workspaces", "nope"], a.ctx)).toBe(1);
    expect(a.errs[0]).toContain("workspace group 'nope'");
    const b = ctxFor(dir, routes().fn);
    b.ctx.env = env;
    expect(await main(["fabric", "run", "--item", "n", "--workspace", "DEV-anna", "--workspace", "other"], b.ctx)).toBe(1);
    expect(b.errs[0]).toContain("did not complete");
  });
});
