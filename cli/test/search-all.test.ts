import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { browseOf } from "../src/lib/browse/core.js";
import { rememberRepo } from "../src/lib/browse/search.js";
import { numberOf, parseKinds, rankItems, searchAll, searchAllText, titleScore, wiqlText, type SearchPart } from "../src/lib/searchAll.js";
import { ctxFor, fakeFetch, tmp, type Route } from "./helpers.js";

const NOW = Date.parse("2026-11-28T10:00:00Z");
const ME = { id: "me-id", providerDisplayName: "Test User", properties: { Account: { $value: "test.user@example.test" } } };

const base: Route[] = [
  { match: /\/_apis\/connectionData/, respond: () => ({ body: { authenticatedUser: ME } }) },
  { match: /^https:\/\/dev\.azure\.com\/ferron-test\/_apis\/projects\?/, respond: () => ({ body: { value: [{ id: "p1", name: "test-project" }, { id: "p2", name: "test-project-agile" }] } }) },
  {
    match: /^https:\/\/dev\.azure\.com\/ferron-test\/_apis\/git\/repositories\?/,
    respond: () => ({
      body: {
        value: [
          { id: "r1", name: "orders-etl", defaultBranch: "refs/heads/main", project: { id: "p1", name: "test-project" } },
          { id: "r2", name: "reporting", defaultBranch: "refs/heads/main", project: { id: "p1", name: "test-project" } },
          { id: "r3", name: "agile-orders", defaultBranch: "refs/heads/staging", project: { id: "p2", name: "test-project-agile" } },
        ],
      },
    }),
  },
  // file names and text: Code Search
  {
    method: "POST",
    match: /almsearch\.dev\.azure\.com\/ferron-test\/_apis\/search\/codesearchresults/,
    respond: (c) =>
      String(c.body?.searchText).startsWith("file:")
        ? { body: { count: 1, results: [{ fileName: "load_orders.py", path: "/notebooks/load_orders.py", project: { name: "test-project" }, repository: { name: "orders-etl" }, versions: [{ branchName: "main", changeId: "c1" }] }] } }
        : { body: { count: 0, results: [] } },
  },
  { method: "POST", match: /wikisearchresults/, respond: () => ({ body: { count: 1, results: [{ path: "/Runbooks/Orders-load.md", project: { name: "test-project" }, wiki: { id: "w1", name: "test-project.wiki", version: "wikiMaster" }, hits: [{ fieldReferenceName: "content", highlights: ["restart the <highlighthit>orders</highlighthit> load"] }] }] } }) },
  // work items: #12 exact, else WIQL on the title
  { match: /\/_apis\/wit\/workitems\/12\?/, respond: () => ({ body: { id: 12, fields: { "System.Title": "Orders: missing rows", "System.WorkItemType": "Bug", "System.State": "Active", "System.TeamProject": "test-project-agile" } } }) },
  { method: "POST", match: /\/_apis\/wit\/wiql/, respond: () => ({ body: { workItems: [{ id: 7 }, { id: 3 }] } }) },
  {
    method: "POST",
    match: /\/_apis\/wit\/workitemsbatch/,
    respond: () => ({
      body: {
        value: [
          { id: 3, fields: { "System.Title": "Load orders daily", "System.WorkItemType": "User Story", "System.State": "New", "System.TeamProject": "test-project", "System.ChangedDate": "2026-11-01T10:00:00Z" } },
          { id: 7, fields: { "System.Title": "Orders report", "System.WorkItemType": "Task", "System.State": "Closed", "System.TeamProject": "test-project", "System.ChangedDate": "2026-11-27T10:00:00Z" } },
        ],
      },
    }),
  },
  // pull requests per project
  {
    match: /test-project\/_apis\/git\/pullrequests\?/,
    respond: () => ({
      body: {
        value: [
          { pullRequestId: 40, title: "Orders: retry the load", status: "completed", sourceRefName: "refs/heads/feature/orders-retry", targetRefName: "refs/heads/main", repository: { name: "orders-etl", project: { name: "test-project" } } },
          { pullRequestId: 41, title: "Report layout", status: "active", sourceRefName: "refs/heads/feature/orders-report", targetRefName: "refs/heads/main", repository: { name: "reporting", project: { name: "test-project" } } },
          { pullRequestId: 42, title: "Unrelated", status: "active", sourceRefName: "refs/heads/feature/x", targetRefName: "refs/heads/main", repository: { name: "reporting", project: { name: "test-project" } } },
        ],
      },
    }),
  },
  { match: /test-project-agile\/_apis\/git\/pullrequests\?/, respond: () => ({ body: { value: [] } }) },
  // pipelines per project
  {
    match: /test-project\/_apis\/build\/definitions\?/,
    respond: () => ({ body: { value: [{ id: 5, name: "orders-etl-ci", path: "\\etl", repository: { name: "orders-etl", defaultBranch: "refs/heads/main" }, process: { type: 2, yamlFilename: "/azure-pipelines.yml" } }, { id: 6, name: "reporting-ci", path: "\\" }] } }),
  },
  { match: /test-project-agile\/_apis\/build\/definitions\?/, respond: () => ({ body: { value: [] } }) },
  // branches: refs with filterContains
  {
    match: /git\/repositories\/orders-etl\/refs\?/,
    respond: (c) => ({ body: { value: new URL(c.url).searchParams.get("filterContains") === "orders" ? [{ name: "refs/heads/feature/orders-retry", objectId: "1" }] : [] } }),
  },
  { match: /git\/repositories\/[^/]+\/refs\?/, respond: () => ({ body: { value: [] } }) },
];

function setup(extra: Route[] = [], hang?: RegExp) {
  const f = fakeFetch([...extra, ...base]);
  const fn = (async (url: unknown, init?: unknown) => (hang?.test(String(url)) ? new Promise(() => undefined) : f.fn(url as never, init as never))) as typeof fetch;
  const { ctx, lines, errs } = ctxFor(tmp(), fn);
  ctx.env.AIHUB_ADO_ORG = "ferron-test";
  ctx.env.AIHUB_COMMON_ROOTS = "none";
  ctx.now = () => NOW;
  return { ctx, lines, errs, calls: f.calls, b: () => browseOf(ctx, {}) };
}

const part = (r: { kinds: SearchPart[] }, k: string) => r.kinds.find((p) => p.kind === k)!;

describe("search all: helpers", () => {
  it("reads the kinds, with plain-word aliases", () => {
    expect(parseKinds(undefined)).toHaveLength(8);
    expect(parseKinds("repositories,stories,pr,wiki")).toEqual(["repos", "workitems", "prs", "wiki"]);
    expect(() => parseKinds("people")).toThrow(/unknown kind 'people'/);
  });
  it("knows a number and quotes WIQL text", () => {
    expect(numberOf("#12")).toBe(12);
    expect(numberOf("12")).toBe(12);
    expect(numberOf("12a")).toBeUndefined();
    expect(wiqlText("Ferron's")).toBe("Ferron''s");
  });
});

describe("search all: ranking", () => {
  it("scores a title: whole, start, word start, anywhere, every word", () => {
    expect(titleScore("Orders", "orders")).toBe(100);
    expect(titleScore("Orders report", "orders")).toBe(80);
    expect(titleScore("Daily orders load", "orders")).toBe(60);
    expect(titleScore("Preorders", "orders")).toBe(40);
    expect(titleScore("Load the daily orders", "daily load")).toBe(20);
    expect(titleScore("Something else", "orders")).toBe(0);
  });
  it("open before closed, then the best title match, then the most recently changed", () => {
    const rows = [
      { t: "Orders report", c: true, d: 9 },
      { t: "Fix the orders export", c: false, d: 1 },
      { t: "Orders", c: false, d: 2 },
      { t: "Something with orders", c: false, d: 5 },
    ];
    expect(rankItems(rows, { title: (x) => x.t, closed: (x) => x.c, changed: (x) => x.d }, "orders").map((x) => x.t)).toEqual(["Orders", "Something with orders", "Fix the orders export", "Orders report"]);
  });
});

describe("search all", () => {
  it("finds every kind at once, each part as soon as it is ready", async () => {
    const s = setup();
    rememberRepo(s.b(), "test-project", "orders-etl");
    const seen: string[] = [];
    const r = await searchAll(s.b(), { text: "orders", onPart: (p) => seen.push(p.kind) });
    expect(seen.sort()).toEqual(["branches", "files", "pipelines", "prs", "repos", "text", "wiki", "workitems"]);
    expect(r.kinds.map((p) => p.kind)).toEqual(["repos", "files", "text", "branches", "workitems", "prs", "wiki", "pipelines"]);
    expect(r.kinds.every((p) => p.status === "ok")).toBe(true);
    expect(part(r, "repos").results.map((h) => h.title)).toEqual(["orders-etl", "agile-orders"]);
    expect(part(r, "repos").results[0].detail).toBe("test-project");
    expect(part(r, "files").results[0]).toMatchObject({ title: "load_orders.py", project: "test-project", repo: "orders-etl", path: "/notebooks/load_orders.py" });
    expect(part(r, "branches").results[0]).toMatchObject({ title: "feature/orders-retry", repo: "orders-etl", branch: "feature/orders-retry" });
    // open before closed, even when the closed one changed later; the closed one is marked
    expect(part(r, "workitems").results.map((h) => [h.id, h.type, h.state, !!h.closed])).toEqual([
      [3, "User Story", "New", false],
      [7, "Task", "Closed", true],
    ]);
    // the title or the source branch; active first
    expect(part(r, "prs").results.map((h) => [h.id, !!h.closed])).toEqual([
      [41, false],
      [40, true],
    ]);
    expect(part(r, "wiki").results[0]).toMatchObject({ title: "Orders load", wiki: "test-project.wiki", detail: "restart the orders load" });
    expect(part(r, "pipelines").results[0]).toMatchObject({ title: "orders-etl-ci", id: 5, project: "test-project" });
    expect(searchAllText(r)).toMatch(/Pull Requests \(2\)\n {2}!41 Report layout/);
  });

  it("looks a number up exactly: #12 is work item 12 and pull request 12", async () => {
    const s = setup([{ match: /\/_apis\/git\/pullrequests\/12\?/, respond: () => ({ body: { pullRequestId: 12, title: "Fix", status: "active", repository: { name: "reporting", project: { name: "test-project" } } } }) }]);
    const r = await searchAll(s.b(), { text: "#12", kinds: ["workitems", "prs"] });
    expect(part(r, "workitems").results[0]).toMatchObject({ id: 12, title: "#12 Orders: missing rows", type: "Bug", project: "test-project-agile" });
    expect(part(r, "prs").results[0]).toMatchObject({ id: 12, title: "!12 Fix" });
  });

  it("a kind that fails is a part with the reason; the others still come", async () => {
    const s = setup([{ method: "POST", match: /wit\/wiql/, respond: () => ({ status: 500, body: { message: "boom" } }) }]);
    const r = await searchAll(s.b(), { text: "orders", kinds: ["repos", "workitems"] });
    expect(part(r, "repos").status).toBe("ok");
    expect(part(r, "workitems")).toMatchObject({ status: "failed", results: [] });
    expect(part(r, "workitems").error?.kind).toBe("failed");
    expect(searchAllText(r)).toMatch(/Work Items\n {2}not searched: /);
  });

  it("a slow kind fails with timeout and does not hold the others", async () => {
    const s = setup([], /wit\/wiql/);
    const r = await searchAll(s.b(), { text: "orders", kinds: ["repos", "workitems"], timeoutMs: 50 });
    expect(part(r, "repos").status).toBe("ok");
    expect(part(r, "workitems").error?.kind).toBe("timeout");
  });

  it("without a search service: file names from the trees, wiki from page titles, text from the clones", async () => {
    const s = setup([
      { method: "POST", match: /searchresults/, respond: () => ({ status: 404, body: { message: "Search is not installed" } }) },
      { match: /_apis\/wiki\/wikis\?/, respond: () => ({ body: { value: [{ id: "w1", name: "test-project.wiki", type: "projectWiki", projectId: "p1" }] } }) },
      { match: /_apis\/wiki\/wikis\/w1\/pages\?/, respond: () => ({ body: { path: "/", subPages: [{ path: "/Runbooks", subPages: [{ path: "/Runbooks/Orders load" }] }, { path: "/Home" }] } }) },
    ]);
    const r = await searchAll(s.b(), { text: "orders", kinds: ["wiki", "text"] });
    expect(part(r, "wiki")).toMatchObject({ status: "ok", route: "titles" });
    expect(part(r, "wiki").results.map((h) => h.path)).toEqual(["/Runbooks/Orders load"]);
    expect(part(r, "text")).toMatchObject({ status: "ok", route: "local" });
    expect(part(r, "text").note).toMatch(/only the clones on this PC/);
  });

  it("aihub search all --json answers every kind; --stream puts each part on stderr", async () => {
    const s = setup();
    expect(await main(["search", "all", "orders", "--kinds", "repos,pipelines", "--stream", "--json"], s.ctx)).toBe(0);
    const out = JSON.parse(s.lines.join("\n"));
    expect(out.kinds.map((p: SearchPart) => p.kind)).toEqual(["repos", "pipelines"]);
    const parts = s.errs.filter((l) => l.startsWith('{"part"')).map((l) => JSON.parse(l).part.kind);
    expect(parts.sort()).toEqual(["pipelines", "repos"]);
  });

  it("aihub search all without text says how", async () => {
    const s = setup();
    expect(await main(["search", "all"], s.ctx)).toBe(1);
    expect(s.errs.join("\n")).toMatch(/aihub search all <text>/);
  });
});
