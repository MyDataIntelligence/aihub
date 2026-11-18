import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, type Route } from "./helpers.js";

const NL = String.fromCharCode(10);

async function run(routes: Route[], argv: string[]) {
  const { dir } = makeRepo();
  const f = fakeFetch(routes);
  const { ctx, lines, errs } = ctxFor(dir, f.fn);
  const code = await main(argv, ctx);
  return { code, out: lines.join(NL), errs, calls: f.calls };
}

describe("aihub testplan", () => {
  it("plans, suites tree, cases and points with outcome counts", async () => {
    const routes: Route[] = [
      { match: /testplan\/plans\?/, respond: () => ({ body: { value: [{ id: 1, name: "Release 1", state: "Active", rootSuite: { id: 2 } }] } }) },
      { match: /testplan\/Plans\/1\/suites/, respond: () => ({ body: { value: [{ id: 2, name: "Release 1", suiteType: "staticTestSuite", children: [{ id: 3, name: "Orders", suiteType: "staticTestSuite" }] }] } }) },
      { match: /Suites\/3\/TestCase/, respond: () => ({ body: { value: [{ workItem: { id: 10, name: "Create order" } }] } }) },
      { match: /Suites\/3\/TestPoint/, respond: () => ({ body: { value: [{ id: 100, results: { outcome: "passed" }, testCaseReference: { id: 10, name: "Create order" } }, { id: 101, results: { outcome: "failed" }, testCaseReference: { id: 11, name: "Cancel order" } }, { id: 102, testCaseReference: { id: 12, name: "Refund" } }] } }) },
    ];
    expect((await run(routes, ["testplan", "plans"])).out).toMatch(/1\s+Active\s+2\s+Release 1/);
    expect((await run(routes, ["testplan", "suites", "--plan", "1"])).out).toBe(["Release 1 (2, staticTestSuite)", "  Orders (3, staticTestSuite)"].join(NL));
    expect((await run(routes, ["testplan", "cases", "--plan", "1", "--suite", "3"])).out).toMatch(/10\s+Create order/);
    const p = await run(routes, ["testplan", "points", "--plan", "1", "--suite", "3"]);
    expect(p.out).toContain("suite 3: 1 passed, 1 failed, 1 unspecified");
    expect((await run(routes, ["testplan", "points", "--plan", "x", "--suite", "3"])).code).not.toBe(0);
  });

  it("outcome patches the point; a dry-run and a bad outcome change nothing", async () => {
    const patches: any[] = [];
    const routes: Route[] = [{ method: "PATCH", match: /test\/Plans\/1\/Suites\/3\/points\/100/, respond: (c) => (patches.push(c.body), { body: {} }) }];
    const ok = await run(routes, ["testplan", "outcome", "--plan", "1", "--suite", "3", "--point", "100", "--to", "Passed"]);
    expect(ok.out).toContain("set to Passed");
    expect(patches).toEqual([{ outcome: "Passed" }]);
    await run(routes, ["testplan", "outcome", "--plan", "1", "--suite", "3", "--point", "100", "--to", "failed", "--dry-run"]);
    expect(patches).toHaveLength(1);
    expect((await run(routes, ["testplan", "outcome", "--plan", "1", "--suite", "3", "--point", "100", "--to", "great"])).code).not.toBe(0);
  });

  it("runs of a build and results with the failures first", async () => {
    const routes: Route[] = [
      { match: /test\/runs\/48\/results/, respond: () => ({ body: { value: [{ id: 1, outcome: "Passed", testCaseTitle: "ok one" }, { id: 2, outcome: "Failed", testCaseTitle: "bad one", errorMessage: "AssertionError: 1 != 2" }] } }) },
      { match: /test\/runs\?.*buildUri=vstfs%3A%2F%2F%2FBuild%2FBuild%2F7/, respond: () => ({ body: { value: [{ id: 48, name: "Fixture checks", totalTests: 13, passedTests: 11, completedDate: "2026-11-13T19:00:00Z" }] } }) },
    ];
    expect((await run(routes, ["testplan", "runs", "--build", "7"])).out).toMatch(/48\s+2026-11-13\s+11\/13\s+2\s+Fixture checks/);
    const r = await run(routes, ["testplan", "results", "--run", "48"]);
    expect(r.out).toBe(["run 48: 1 passed, 1 failed", "  Failed: bad one - AssertionError: 1 != 2"].join(NL));
    expect((await run(routes, ["testplan", "results", "--run", "48", "--all"])).out).toContain("Passed: ok one");
  });

  it("creates a plan, a suite under the root suite, and a test case added to a suite", async () => {
    const posts: [string, any][] = [];
    const routes: Route[] = [
      { method: "POST", match: /testplan\/plans\?/, respond: (c) => (posts.push(["plan", c.body]), { body: { id: 5, rootSuite: { id: 6 } } }) },
      { match: /testplan\/plans\/5\?/, respond: () => ({ body: { id: 5, name: "P", rootSuite: { id: 6 } } }) },
      { method: "POST", match: /testplan\/Plans\/5\/suites/, respond: (c) => (posts.push(["suite", c.body]), { body: { id: 7 } }) },
      { method: "POST", match: /wit\/workitems\/\$Test%20Case/, respond: (c) => (posts.push(["case", c.body]), { body: { id: 77 } }) },
      { method: "POST", match: /Suites\/7\/TestCase/, respond: (c) => (posts.push(["add", c.body]), { body: {} }) },
    ];
    expect((await run(routes, ["testplan", "create-plan", "--name", "P", "--area", "test-project"])).out).toContain("(5, root suite 6)");
    await run(routes, ["testplan", "create-suite", "--plan", "5", "--name", "Orders"]);
    await run(routes, ["testplan", "create-case", "--plan", "5", "--suite", "7", "--title", "Create order"]);
    expect(posts).toEqual([
      ["plan", { name: "P", areaPath: "test-project" }],
      ["suite", { suiteType: "staticTestSuite", name: "Orders", parentSuite: { id: 6 } }],
      ["case", [{ op: "add", path: "/fields/System.Title", value: "Create order" }]],
      ["add", [{ workItem: { id: 77 } }]],
    ]);
  });
});

describe("aihub artifacts", () => {
  it("feeds of the organisation and the project, packages with the latest version, versions with views", async () => {
    const routes: Route[] = [
      { match: /feeds\.dev\.azure\.com\/ferron-org\/_apis\/packaging\/feeds\?/, respond: () => ({ body: { value: [{ id: "f1", name: "org-feed", upstreamEnabled: true }] } }) },
      { match: /feeds\.dev\.azure\.com\/ferron-org\/test-project\/_apis\/packaging\/feeds\?/, respond: () => ({ body: { value: [{ id: "f2", name: "proj-feed", project: { name: "test-project" } }] } }) },
      { match: /feeds\/f1\/packages\?/i, respond: (c) => (expect(c.url).toContain("packageNameQuery=lib"), { body: { value: [{ id: "p1", name: "lib-core", protocolType: "NuGet", versions: [{ version: "1.2.0", isLatest: true }] }] } }) },
      { match: /Feeds\/f1\/Packages\/p1\/versions/i, respond: () => ({ body: { value: [{ version: "1.2.0", isLatest: true, publishDate: "2026-11-01T00:00:00Z", views: [{ name: "Release" }] }, { version: "1.1.0", isListed: false, publishDate: "2026-10-01T00:00:00Z" }] } }) },
      { match: /feeds\/f1\/packages\?/i, respond: () => ({ body: { value: [{ id: "p1", name: "lib-core", protocolType: "NuGet" }] } }) },
    ];
    const f = await run(routes, ["artifacts", "feeds"]);
    expect(f.out).toMatch(/org-feed\s+organisation\s+yes\s+f1/);
    expect(f.out).toMatch(/proj-feed\s+project\s+f2/);
    expect((await run(routes, ["artifacts", "packages", "--feed", "org-feed", "--filter", "lib"])).out).toMatch(/lib-core\s+NuGet\s+1\.2\.0/);
    const v = await run(routes, ["artifacts", "versions", "--feed", "org-feed", "--package", "lib-core"]);
    expect(v.out).toMatch(/1\.2\.0\s+2026-11-01\s+Release\s+latest/);
    expect(v.out).toMatch(/1\.1\.0\s+2026-10-01\s+unlisted/);
    expect((await run(routes, ["artifacts", "packages", "--feed", "nope"])).errs.join("")).toContain("feed 'nope' not found");
  });
});
