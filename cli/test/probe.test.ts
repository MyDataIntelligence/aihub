import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { interpret, normalizeFabricPath, shapeOf } from "../src/lib/probe.js";
import { missingHeadings, REPORT_TEMPLATE } from "../src/lib/research.js";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, tmp, type Route } from "./helpers.js";

const WS = "11111111-1111-1111-1111-111111111111";
const ENV = { AIHUB_FABRIC_TOKEN: "fabric-token", AIHUB_ADO_PAT: "synthetic-pat", AIHUB_POLL_MS: "0" };
const WORKSPACES: Route = { match: /api\.fabric\.microsoft\.com\/v1\/workspaces(\?|$)/, respond: () => ({ body: { value: [{ id: WS, displayName: "aihub-test-dev-20261118b" }] } }) };

function go(routes: Route[], args: string[]) {
  const { dir } = makeRepo();
  const f = fakeFetch(routes);
  const { ctx, lines, errs } = ctxFor(dir, f.fn);
  ctx.env = { ...ENV, AIHUB_HOME: ctx.env.AIHUB_HOME };
  return main(args, ctx).then((code) => ({ code, out: lines.join("\n"), errs: errs.join("\n"), calls: f.calls, dir, ctx }));
}

describe("interpret", () => {
  it("maps statuses to yes, no or unknown, and says why", () => {
    expect(interpret(200).answer).toBe("yes");
    expect(interpret(404).answer).toBe("no");
    expect(interpret(403).answer).toBe("unknown");
    expect(interpret(403).meaning).toContain("permission");
    expect(interpret(400).answer).toBe("unknown");
    expect(interpret(500).answer).toBe("unknown");
  });

  it("describes the shape of an answer, never its content", () => {
    expect(shapeOf({ value: [{ secret: "x" }, { secret: "y" }], continuationToken: null })).toEqual({ keys: ["value", "continuationToken"], count: 2 });
    expect(JSON.stringify(shapeOf({ value: [{ secret: "x" }] }))).not.toContain("secret");
  });
});

describe("normalizeFabricPath", () => {
  it("accepts the path with or without slash and /v1, as a URL, and undoes Git Bash path conversion", () => {
    expect(normalizeFabricPath("workspaces/x/items")).toBe("/workspaces/x/items");
    expect(normalizeFabricPath("/v1/workspaces/x")).toBe("/workspaces/x");
    expect(normalizeFabricPath("https://api.fabric.microsoft.com/v1/capacities")).toBe("/capacities");
    expect(normalizeFabricPath("C:/Program Files/Git/workspaces/x/items")).toBe("/workspaces/x/items");
    expect(() => normalizeFabricPath(" ")).toThrow();
  });

  it("expands {workspaceId} like {workspace}", async () => {
    const r = await go([WORKSPACES, { match: /workspaces\/1111[^/]*\/items/, respond: () => ({ body: { value: [] } }) }], ["probe", "fabric", "endpoint", "workspaces/{workspaceId}/items", "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({ answer: "yes", status: 200 });
  });
});

describe("aihub probe fabric", () => {
  it("endpoint: a 200 is YES with the item count, one GET only", async () => {
    const r = await go([WORKSPACES, { match: /workspaces\/1111[^/]*\/copyJobs/, respond: () => ({ body: { value: [{ displayName: "my secret job" }] } }) }], ["probe", "fabric", "endpoint", "/workspaces/{workspace}/copyJobs", "--workspace", "aihub-test-dev-20261118b"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("YES");
    expect(r.out).toContain("1 item(s)");
    expect(r.out).not.toContain("my secret job");
    expect(r.out).toContain("read-only");
    expect(r.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("endpoint: a 404 is NO, a 403 is UNKNOWN with the permission hint", async () => {
    const no = await go([WORKSPACES], ["probe", "fabric", "endpoint", "/workspaces/{workspace}/nonexistentThings", "--json"]);
    expect(JSON.parse(no.out)).toMatchObject({ answer: "no", status: 404, readOnly: true });
    const denied = await go([WORKSPACES, { match: /mirroredDatabases/, respond: () => ({ status: 403, body: { message: "denied" } }) }], ["probe", "fabric", "capacity", "--feature", "mirroring", "--json"]);
    expect(JSON.parse(denied.out)).toMatchObject({ answer: "unknown", status: 403 });
  });

  it("capacity: lists SKU, region and state of the capacities and probes a feature", async () => {
    const caps: Route = { match: /\/v1\/capacities/, respond: () => ({ body: { value: [{ displayName: "trial", sku: "FT1", region: "West Europe", state: "Active" }] } }) };
    const r = await go([WORKSPACES, caps, { match: /spark\/settings/, respond: () => ({ body: { automaticLog: { enabled: true } } }) }], ["probe", "fabric", "capacity", "--feature", "spark", "--json"]);
    const j = JSON.parse(r.out);
    expect(j.answer).toBe("yes");
    expect(j.facts.capacities[0]).toEqual({ name: "trial", sku: "FT1", region: "West Europe", state: "Active" });
    expect(j.facts.checkedInWorkspace).toBe("aihub-test-dev-20261118b");
  });

  it("capacity: an unknown feature is refused with the list", async () => {
    const r = await go([WORKSPACES, { match: /capacities/, respond: () => ({ body: { value: [] } }) }], ["probe", "fabric", "capacity", "--feature", "teleport"]);
    expect(r.code).toBe(1);
    expect(r.errs).toContain("known: spark");
  });
});

describe("safe default workspace", () => {
  const REAL: Route = { match: /api\.fabric\.microsoft\.com\/v1\/workspaces(\?|$)/, respond: () => ({ body: { value: [{ id: WS, displayName: "DEV-real-project" }] } }) };
  it("without --workspace and without an aihub-test-dev workspace the answer is UNKNOWN, and no item endpoint is called", async () => {
    const caps: Route = { match: /\/v1\/capacities/, respond: () => ({ body: { value: [] } }) };
    const r = await go([REAL, caps], ["probe", "fabric", "capacity", "--feature", "copyjob", "--json"]);
    const j = JSON.parse(r.out);
    expect(j).toMatchObject({ answer: "unknown", status: null });
    expect(j.meaning).toContain("maak een aihub-test-dev-workspace");
    expect(r.calls.some((c) => /copyJobs/.test(c.url))).toBe(false);
    const e = await go([REAL], ["probe", "fabric", "endpoint", "workspaces/{workspace}/items", "--json"]);
    expect(JSON.parse(e.out).answer).toBe("unknown");
  });

  it("an explicit --workspace is still honoured", async () => {
    const r = await go([REAL, { match: /workspaces\/1111[^/]*\/copyJobs/, respond: () => ({ body: { value: [] } }) }], ["probe", "fabric", "endpoint", "workspaces/{workspace}/copyJobs", "--workspace", "DEV-real-project", "--json"]);
    expect(JSON.parse(r.out).answer).toBe("yes");
  });
});

describe("the feasibility skill keeps the mandatory section", () => {
  it("the report template, the skill reference and the command all name Waar hoort het: Fabric, DevOps/CI-CD of beide?", () => {
    const H = "Waar hoort het: Fabric, DevOps/CI-CD of beide?";
    expect(REPORT_TEMPLATE).toContain(`## ${H}`);
    expect(readFileSync(join(__dirname, "../../skills/feasibility/references/where.md"), "utf8")).toContain(H);
    expect(readFileSync(join(__dirname, "../../commands/opencode/kan-dit.md"), "utf8")).toContain(H);
    expect(readFileSync(join(__dirname, "../../skills/feasibility/SKILL.md"), "utf8")).toContain("Waar hoort het");
  });
});

describe("aihub probe devops and api", () => {
  it("devops feature: probes the project endpoint with GET", async () => {
    const r = await go([{ match: /_apis\/wiki\/wikis/, respond: () => ({ body: { value: [{ name: "w" }, { name: "x" }] } }) }], ["probe", "devops", "feature", "wiki"]);
    expect(r.out).toContain("YES");
    expect(r.out).toContain("2 item(s)");
    expect(r.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("devops feature: an HTML sign-in page is UNKNOWN (not signed in), never YES", async () => {
    const r = await go([{ match: /_apis\/pipelines/, respond: () => ({ status: 203, text: "<html>sign in</html>" }) }], ["probe", "devops", "feature", "pipelines", "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({ answer: "unknown", status: 401 });
  });

  it("api --get: allowed hosts only; docs hosts return an excerpt, Fabric shows shape", async () => {
    const docs = await go([{ match: /learn\.microsoft\.com/, respond: () => ({ text: "<html><script>x()</script><h1>Job scheduler</h1><p>Run on demand.</p></html>" }) }], ["probe", "api", "--get", "https://learn.microsoft.com/rest/api/fabric/core/job-scheduler"]);
    expect(docs.out).toContain("Job scheduler Run on demand.");
    expect(docs.out).not.toContain("x()");
    const bad = await go([], ["probe", "api", "--get", "https://evil.example.com/x"]);
    expect(bad.code).toBe(1);
    expect(bad.errs).toContain("not allowed");
    const http = await go([], ["probe", "api", "--get", "http://learn.microsoft.com/x"]);
    expect(http.errs).toContain("only https");
  });

  it("never offers a write: no POST, PUT, PATCH or DELETE is possible", async () => {
    const r = await go([WORKSPACES, { match: /./, respond: () => ({ body: {} }) }], ["probe", "fabric", "endpoint", "/workspaces/{workspace}/items"]);
    expect(r.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
});

describe("aihub research save", () => {
  it("keeps the report in the git-excluded aihub folder under a dated slug", async () => {
    const f = join(tmp(), "report.md");
    writeFileSync(f, REPORT_TEMPLATE.replace("<de vraag, een regel>", "Kan een notebook vanuit DevOps?").replace("Ja / Nee / Deels, en de workaround in een zin.", "Verdict: Ja"));
    const r = await go([], ["research", "save", "--file", f, "--json"]);
    expect(r.code).toBe(0);
    const saved = JSON.parse(r.out).saved as string;
    expect(saved).toMatch(/aihub[\\/]research[\\/]\d{4}-\d{2}-\d{2}-kan-een-notebook-vanuit-devops\.md$/);
    expect(existsSync(saved)).toBe(true);
    expect(readFileSync(saved, "utf8")).toContain("Verdict: Ja");
  });

  it("refuses a report that lacks the Waar hoort het section, and prints the template with every heading", async () => {
    const f = join(tmp(), "short.md");
    writeFileSync(f, ["# Q", "", "## Verdict", "Ja", "", "## Hoe", "1", ""].join(String.fromCharCode(10)));
    const r = await go([], ["research", "save", "--file", f]);
    expect(r.code).toBe(1);
    expect(r.errs).toContain("Waar hoort het: Fabric, DevOps/CI-CD of beide?");
    expect(missingHeadings(REPORT_TEMPLATE)).toEqual([]);
    const t = await go([], ["research", "template"]);
    expect(t.out).toContain("### Fabric");
    expect(t.out).toContain("### Azure DevOps");
    expect(t.out).toContain("Advies:");
  });

  it("refuses a missing or empty file", async () => {
    expect((await go([], ["research", "save", "--file", "/no/such.md"])).errs).toContain("not found");
    const f = join(tmp(), "e.md");
    writeFileSync(f, " \n");
    expect((await go([], ["research", "save", "--file", f])).errs).toContain("empty");
  });
});
