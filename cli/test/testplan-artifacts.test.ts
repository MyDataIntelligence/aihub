import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, type Route } from "./helpers.js";

const NL = String.fromCharCode(10);
const PLAN = { id: 4, name: "Release plan", state: "Active", iteration: "p\\Sprint 1", rootSuite: { id: 10 } };

function routes(extra: Route[] = []): Route[] {
  return [
    { match: /_apis\/testplan\/plans\/4\?/, respond: () => ({ body: PLAN }) },
    { match: /_apis\/testplan\/plans\?/, respond: () => ({ body: { value: [PLAN] } }) },
    ...extra,
  ];
}

describe("aihub testplan", () => {
  it("lists plans, the suite tree, test cases and points filtered by outcome", async () => {
    const { dir } = makeRepo();
    const r = routes([
      { match: /testplan\/Plans\/4\/suites\?/, respond: () => ({ body: { value: [{ id: 10, name: "Release plan", suiteType: "staticTestSuite" }, { id: 11, name: "Smoke", suiteType: "staticTestSuite", parentSuite: { id: 10 } }, { id: 12, name: "Regression", suiteType: "dynamicTestSuite", parentSuite: { id: 10 } }] } }) },
      { match: /testplan\/Plans\/4\/Suites\/11\/TestCase\?/, respond: () => ({ body: { value: [{ workItem: { id: 101, name: "Login works" } }] } }) },
      { match: /testplan\/Plans\/4\/Suites\/11\/TestPoint\?/, respond: () => ({ body: { value: [{ id: 1, testCaseReference: { id: 101, name: "Login works" }, results: { outcome: "passed" }, tester: { displayName: "Ann" } }, { id: 2, testCaseReference: { id: 102, name: "Logout" }, results: { outcome: "failed" } }] } }) },
    ]);
    const a = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["testplan", "plans"], a.ctx)).toBe(0);
    expect(a.lines.join(NL)).toMatch(/4\s+Release plan\s+Active/);
    const b = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["testplan", "suites", "--plan", "Release plan"], b.ctx)).toBe(0);
    expect(b.lines.join(NL)).toContain("  Smoke  (#11, static)");
    expect(b.lines.join(NL)).toContain("  Regression  (#12, dynamic)");
    const c = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["testplan", "cases", "--plan", "4", "--suite", "11"], c.ctx)).toBe(0);
    expect(c.lines.join(NL)).toBe("AB#101 Login works");
    const d = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["testplan", "points", "--plan", "4", "--suite", "11", "--outcome", "failed"], d.ctx)).toBe(0);
    expect(d.lines.join(NL)).toMatch(/2\s+AB#102\s+failed/);
    expect(d.lines.join(NL)).not.toContain("Login");
  });

  it("sets outcomes (validated), creates plan, suite and case, and deletes only with --yes", async () => {
    const { dir } = makeRepo();
    const bodies: Record<string, any> = {};
    let del = 0;
    const r = routes([
      { method: "PATCH", match: /testplan\/Plans\/4\/Suites\/11\/TestPoint\?/, respond: (c) => ((bodies.outcome = c.body), { body: {} }) },
      { method: "POST", match: /testplan\/plans\?/, respond: (c) => ((bodies.plan = c.body), { body: { id: 9 } }) },
      { method: "POST", match: /testplan\/Plans\/4\/suites\?/, respond: (c) => ((bodies.suite = c.body), { body: { id: 21 } }) },
      { method: "POST", match: /wit\/workitems\/\$Test%20Case\?/, respond: (c) => ((bodies.wi = c.body), { body: { id: 301 } }) },
      { method: "POST", match: /testplan\/Plans\/4\/Suites\/11\/TestCase\?/, respond: (c) => ((bodies.add = c.body), { body: {} }) },
      { method: "DELETE", match: /testplan\/plans\/4\?/, respond: () => (del++, { body: {} }) },
    ]);
    expect(await main(["testplan", "outcome", "--plan", "4", "--suite", "11", "--points", "1,2", "--outcome", "passed"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(bodies.outcome).toEqual([{ id: 1, results: { outcome: "passed" } }, { id: 2, results: { outcome: "passed" } }]);
    const bad = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["testplan", "outcome", "--plan", "4", "--suite", "11", "--points", "1", "--outcome", "great"], bad.ctx)).toBe(1);
    expect(await main(["testplan", "create-plan", "--name", "New plan", "--iteration", "p\\S2"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(bodies.plan).toEqual({ name: "New plan", iteration: "p\\S2" });
    expect(await main(["testplan", "create-suite", "--plan", "4", "--name", "Smoke 2"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(bodies.suite).toEqual({ suiteType: "staticTestSuite", name: "Smoke 2", parentSuite: { id: 10 } });
    expect(await main(["testplan", "create-case", "--plan", "4", "--suite", "11", "--title", "Checkout"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(bodies.wi[0]).toEqual({ op: "add", path: "/fields/System.Title", value: "Checkout" });
    expect(bodies.add).toEqual([{ workItem: { id: 301 } }]);
    expect(await main(["testplan", "delete-plan", "--plan", "4"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(1);
    expect(del).toBe(0);
    expect(await main(["testplan", "delete-plan", "--plan", "4", "--yes"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(del).toBe(1);
  });

  it("lists test runs of a build and failed results", async () => {
    const { dir } = makeRepo();
    const r: Route[] = [
      { match: /_apis\/test\/runs\?/, respond: (c) => (expect(c.url).toContain("buildUri=vstfs%3A%2F%2F%2FBuild%2FBuild%2F21"), { body: { value: [{ id: 100, name: "pytest", state: "Completed", totalTests: 40, passedTests: 38, completedDate: "2026-11-18T10:00:00Z" }] } }) },
      { match: /_apis\/test\/runs\/100\/results\?/, respond: () => ({ body: { value: [{ id: 1, automatedTestName: "t.a", outcome: "Failed", errorMessage: "assert 1 == 2" }] } }) },
    ];
    const a = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["testplan", "runs", "--build", "21"], a.ctx)).toBe(0);
    expect(a.lines.join(NL)).toMatch(/100\s+pytest\s+Completed\s+38\/40\s+2026-11-18/);
    const b = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["testplan", "results", "--run", "100"], b.ctx)).toBe(0);
    expect(b.lines.join(NL)).toContain("Failed t.a" + NL + "    assert 1 == 2");
  });
});

describe("aihub artifacts", () => {
  it("lists feeds on the feeds host, packages by type and versions of a package", async () => {
    const { dir } = makeRepo();
    const feed = { id: "f1", name: "team-feed", description: "synthetic", project: { name: "test-project" }, upstreamEnabled: true };
    const r: Route[] = [
      { match: /feeds\.dev\.azure\.com\/ferron-org\/test-project\/_apis\/packaging\/feeds\?/, respond: () => ({ body: { value: [feed] } }) },
      { match: /feeds\.dev\.azure\.com\/ferron-org\/_apis\/packaging\/feeds\?/, respond: () => ({ body: { value: [] } }) },
      { match: /feeds\/f1\/packages\/p1\/versions\?/, respond: () => ({ body: { value: [{ version: "1.2.0", isLatest: true, publishDate: "2026-11-01T00:00:00Z", views: [{ name: "Release" }] }, { version: "1.1.0", isListed: false, publishDate: "2026-10-01T00:00:00Z" }] } }) },
      { match: /feeds\/f1\/packages\?.*packageNameQuery=lib/, respond: () => ({ body: { value: [{ id: "p1", name: "lib", protocolType: "PyPi", versions: [{ version: "1.2.0", isLatest: true, publishDate: "2026-11-01T00:00:00Z" }] }] } }) },
      { match: /feeds\/f1\/packages\?/, respond: (c) => (expect(c.url).toContain("protocolType=pypi"), { body: { value: [{ id: "p1", name: "lib", protocolType: "PyPi", versions: [{ version: "1.2.0", isLatest: true, publishDate: "2026-11-01T00:00:00Z" }] }] } }) },
    ];
    const a = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["artifacts", "feeds"], a.ctx)).toBe(0);
    expect(a.lines.join(NL)).toMatch(/team-feed\s+test-project\s+yes\s+synthetic/);
    const b = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["artifacts", "packages", "--feed", "team-feed", "--type", "pypi"], b.ctx)).toBe(0);
    expect(b.lines.join(NL)).toMatch(/lib\s+PyPi\s+1\.2\.0\s+2026-11-01/);
    const c = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["artifacts", "versions", "--feed", "team-feed", "--package", "lib"], c.ctx)).toBe(0);
    expect(c.lines.join(NL)).toMatch(/1\.2\.0\s+2026-11-01\s+Release\s+latest/);
    expect(c.lines.join(NL)).toMatch(/1\.1\.0\s+2026-10-01\s+unlisted/);
    const e = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["artifacts", "packages", "--feed", "nope"], e.ctx)).toBe(1);
    expect(e.errs.join(NL)).toContain("feeds: team-feed");
  });
});
