import { deflateRawSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { browseOf } from "../src/lib/browse/core.js";
import { fileInRepo, gitPathToPage, nameToFile, pagePath, pageToGitPath, wikiList, wikiOf } from "../src/lib/wiki/core.js";
import { attachmentFile, attachmentsOf, mapTree, wikiAttachment, wikiHistory, wikiPage, wikiRevisionDiff, wikiTree } from "../src/lib/wiki/read.js";
import { hitLines, mapSearch, wikiSearch } from "../src/lib/wiki/search.js";
import { templateText, WIKI_TEMPLATES } from "../src/lib/wiki/templates.js";
import { rewriteLinks, wikiCreate, wikiMove, wikiMovePlan, wikiPublish, wikiUpload } from "../src/lib/wiki/write.js";
import { readZip } from "../src/lib/wiki/zip.js";
import { ctxFor, fakeFetch, tmp, type Route } from "./helpers.js";

// A synthetic organisation: test-project has a project wiki (orders.wiki) and a code wiki (ingest.wiki on repo ingest, folder /docs).
const NOW = Date.parse("2026-11-27T10:00:00Z");
const C1 = "a".repeat(40);
const C2 = "b".repeat(40);
const E1 = "1".repeat(40);
const E2 = "2".repeat(40);
const ME = { id: "me-id", providerDisplayName: "Test User", properties: { Account: { $value: "test.user@example.test" } } };
const author = (name: string, date: string) => ({ name, email: `${name.toLowerCase().replace(/ /g, ".")}@example.test`, date });
const PW = "w-orders";
const CW = "w-ingest";

const wikis = [
  { id: CW, name: "ingest.wiki", type: "codeWiki", projectId: "p1", repositoryId: "r-ingest", mappedPath: "/docs", versions: [{ version: "main" }] },
  { id: PW, name: "orders.wiki", type: "projectWiki", projectId: "p1", repositoryId: PW, mappedPath: "/", versions: [{ version: "wikiMaster" }] },
];

const base: Route[] = [
  { match: /\/_apis\/connectionData/, respond: () => ({ body: { authenticatedUser: ME } }) },
  { match: /ferron-test\/_apis\/wiki\/wikis\?/, respond: () => ({ body: { value: wikis } }) },
  { match: /ferron-test\/_apis\/projects\?/, respond: () => ({ body: { value: [{ id: "p1", name: "test-project" }, { id: "p2", name: "empty-project" }] } }) },
  { match: /ferron-test\/_apis\/git\/repositories\?/, respond: () => ({ body: { value: [{ id: "r-ingest", name: "ingest" }] } }) },
];

function setup(extra: Route[] = [], binary?: (url: string) => Buffer | undefined) {
  const f = fakeFetch([...extra, ...base]);
  const fn = (async (input: any, init: any) => {
    const bin = binary?.(String(input));
    if (bin) {
      f.calls.push({ method: "GET", url: String(input), body: undefined, headers: {} } as never);
      return new Response(bin, { status: 200, headers: { "content-type": "application/octet-stream" } });
    }
    return f.fn(input, init);
  }) as typeof fetch;
  const { ctx, lines } = ctxFor(tmp(), fn);
  ctx.env.AIHUB_ADO_ORG = "ferron-test";
  ctx.env.AIHUB_CONFIG_HOME = tmp();
  ctx.now = () => NOW;
  return { ctx, lines, calls: f.calls, b: (refresh = false) => browseOf(ctx, { refresh }) };
}

/** A zip of stored and deflated entries, like the Items API answers with $format=zip. */
function zipOf(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const cens: Buffer[] = [];
  let offset = 0;
  Object.entries(files).forEach(([name, text], i) => {
    const data = Buffer.from(text, "utf8");
    const method = i % 2 ? 8 : 0;
    const comp = method === 8 ? deflateRawSync(data) : data;
    const n = Buffer.from(name, "utf8");
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(method, 8);
    loc.writeUInt32LE(comp.length, 18);
    loc.writeUInt32LE(data.length, 22);
    loc.writeUInt16LE(n.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(n.length, 28);
    cen.writeUInt32LE(offset, 42);
    locals.push(loc, n, comp);
    cens.push(cen, n);
    offset += 30 + n.length + comp.length;
  });
  const cenBuf = Buffer.concat(cens);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cenBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cenBuf, end]);
}

describe("wiki paths", () => {
  it("turns page paths into git files and back (a dash is a space, a real dash is %2D)", () => {
    expect(pagePath("Runbooks\\Order export.md")).toBe("/Runbooks/Order export");
    expect(nameToFile("bench-1a2b3c")).toBe("bench%2D1a2b3c");
    expect(pageToGitPath("/Runbooks/Order export")).toBe("/Runbooks/Order-export.md");
    expect(pageToGitPath("/bench-1a2b3c/Target page")).toBe("/bench%2D1a2b3c/Target-page.md");
    expect(gitPathToPage("/bench%2D1a2b3c/Target-page.md")).toBe("/bench-1a2b3c/Target page");
    expect(fileInRepo({ kind: "code", mappedPath: "/docs" }, "/architecture/data-flow.md")).toBe("/docs/architecture/data-flow.md");
    expect(fileInRepo({ kind: "code", mappedPath: "/docs" }, "/docs/x.md")).toBe("/docs/x.md");
    expect(fileInRepo({ kind: "project", mappedPath: null }, "/A.md")).toBe("/A.md");
  });
  it("finds the attachments of a page, not the web links", () => {
    const md = "![flow](/.attachments/flow-1.png)\n[doc](/.attachments/spec.pdf)\n[web](https://example.test/a.png)\n![local](./img/b%20c.png \"t\")\n[page](/Other)";
    expect(attachmentsOf(md)).toEqual([
      { name: "flow-1.png", ref: "/.attachments/flow-1.png" },
      { name: "spec.pdf", ref: "/.attachments/spec.pdf" },
      { name: "b c.png", ref: "./img/b%20c.png" },
    ]);
    expect(attachmentFile({ kind: "code", mappedPath: "/docs" }, "./img/b%20c.png", "/docs/arch/flow.md")).toBe("/docs/arch/img/b c.png");
    expect(attachmentFile({ kind: "project", mappedPath: null }, "/.attachments/x.png")).toBe("/.attachments/x.png");
  });
  it("orders a tree level as Azure DevOps does", () => {
    const t = mapTree({ path: "/", subPages: [{ path: "/B", order: 1 }, { path: "/A", order: 0, isParentPage: true }, { path: "/C" }, { path: "/.idea", isParentPage: true }] });
    expect(t.map((p) => [p.name, p.hasChildren])).toEqual([["A", true], ["B", false], ["C", false]]);
  });
  it("has the three templates", () => {
    expect(WIKI_TEMPLATES.map((t) => t.key)).toEqual(["empty", "runbook", "decision"]);
    expect(templateText("decision", "Caching strategy")).toMatch(/^# Caching strategy\n\n## Context/);
    expect(() => templateText("nope", "x")).toThrow(/unknown template/);
  });
});

describe("wiki zip", () => {
  it("reads stored and deflated entries", () => {
    const z = zipOf({ "A.md": "# A", "A/B.md": "# B".repeat(50), ".order": "A" });
    expect(readZip(z).map((e) => [e.name, e.data.toString("utf8").slice(0, 3)])).toEqual([["A.md", "# A"], ["A/B.md", "# B"], [".order", "A"]]);
  });
});

describe("wiki links", () => {
  it("rewrites links to a moved page and its subpages, keeps web links and the way they were written", () => {
    const md = [
      "See [backfill](/Runbooks/Backfill) and [check](/Runbooks/Backfill/Controle#stap-2).",
      "Old style [x](/Runbooks/Backfill.md) and [y](</Runbooks/Backfill>).",
      "[ref]: /Runbooks/Backfill",
      "Not [web](https://example.test/Runbooks/Backfill) nor [other](/Runbooks/Backfill-old).",
    ].join("\n");
    const r = rewriteLinks(md, "/Runbooks/Backfill", "/How we work/Backfill");
    expect(r.count).toBe(5);
    expect(r.content.split("\n")).toEqual([
      "See [backfill](/How-we-work/Backfill) and [check](/How-we-work/Backfill/Controle#stap-2).",
      "Old style [x](/How-we-work/Backfill.md) and [y](</How-we-work/Backfill>).",
      "[ref]: /How-we-work/Backfill",
      "Not [web](https://example.test/Runbooks/Backfill) nor [other](/Runbooks/Backfill-old).",
    ]);
    expect(r.before).toHaveLength(3);
  });
  it("treats a dash and a space alike, and keeps %20 style", () => {
    const r = rewriteLinks("[a](/Order%20export/Steps) [b](/Order-export)", "/Order export", "/Order export v2");
    expect(r.content).toBe("[a](/Order%20export%20v2/Steps) [b](/Order-export-v2)");
  });
  it("keeps the unchanged segments as written", () => {
    expect(rewriteLinks("[t](/bench-1a2b3c/Target-page)", "/bench-1a2b3c/Target page", "/bench-1a2b3c/Moved target").content).toBe("[t](/bench-1a2b3c/Moved-target)");
  });
});

describe("wiki search", () => {
  it("cuts highlights into lines with ranges", () => {
    expect(hitLines("intro\nDe <highlighthit>afstemming</highlighthit> draait na <highlighthit>afstemming</highlighthit>.\nrest")).toEqual([
      { line: null, text: "De afstemming draait na afstemming.", highlights: [{ start: 3, length: 10 }, { start: 24, length: 10 }] },
    ]);
  });
  it("maps results, facets and code wiki paths", () => {
    const r = mapSearch(
      {
        count: 2,
        results: [
          { path: "/Runbooks/Order-export.md", project: { name: "test-project" }, wiki: { id: PW, name: "orders.wiki", mappedPath: "/", version: "wikiMaster" }, hits: [{ fieldReferenceName: "content", highlights: ["Check the <highlighthit>afstemming</highlighthit>"] }, { fieldReferenceName: "content.pattern", highlights: ["x"] }] },
          { path: "/docs/reconciliation.md", project: { name: "test-project" }, wiki: { id: CW, name: "ingest.wiki", mappedPath: "/docs", version: "main" }, hits: [{ fieldReferenceName: "content.pattern", highlights: ["# <highlighthit>Afstemming</highlighthit>"] }] },
        ],
        facets: { Project: [{ name: "test-project", resultCount: 2 }], Wiki: [{ name: "orders.wiki", resultCount: 1 }] },
      },
      "afstemming",
      12,
    );
    expect(r.results.map((x) => [x.path, x.title, x.wiki.kind, x.hits.length])).toEqual([
      ["/Runbooks/Order export", "Runbooks / Order export", "project", 1],
      ["/reconciliation", "reconciliation", "code", 1],
    ]);
    expect(r.facets.projects).toEqual([{ name: "test-project", count: 2 }]);
  });
  it("answers searchUnavailable when the organisation has no search, and remembers it", async () => {
    const s = setup([{ method: "POST", match: /almsearch.*wikisearchresults/, respond: () => ({ status: 404, body: { message: "not found" } }) }]);
    await expect(wikiSearch(s.b(), { text: "x" })).rejects.toMatchObject({ kind: "searchUnavailable" });
    const n = s.calls.length;
    await expect(wikiSearch(s.b(), { text: "y" })).rejects.toMatchObject({ kind: "searchUnavailable" });
    expect(s.calls.length).toBe(n); // remembered 5 minutes: no second call
  });
  it("sends the filters", async () => {
    const s = setup([{ method: "POST", match: /almsearch.*wikisearchresults/, respond: () => ({ body: { count: 0, results: [] } }) }]);
    await wikiSearch(s.b(), { text: "afstemming", project: "test-project", wiki: "orders.wiki", top: 10 });
    expect(s.calls.find((c) => c.method === "POST")?.body).toMatchObject({ searchText: "afstemming", $top: 10, filters: { Project: ["test-project"], Wiki: ["orders.wiki"] } });
  });
});

describe("wiki reads", () => {
  it("lists the wikis with project names, project wikis first, and the code wiki's repository", async () => {
    const s = setup();
    const r = await wikiList(s.b());
    expect(r.wikis.map((w) => [w.project, w.name, w.kind, w.repo, w.branch, w.mappedPath])).toEqual([
      ["test-project", "orders.wiki", "project", null, null, null],
      ["test-project", "ingest.wiki", "code", "ingest", "main", "/docs"],
    ]);
    expect(r.projects).toEqual([{ name: "test-project", wikis: 2 }]);
    const n = s.calls.length;
    expect((await wikiList(s.b())).cached).toBe(true);
    expect(s.calls.length).toBe(n);
  });
  it("tells which wikis exist when one is not found", async () => {
    const s = setup();
    await expect(wikiOf(s.b(), "test-project", "nope")).rejects.toMatchObject({ kind: "notFound", message: expect.stringMatching(/orders\.wiki, ingest\.wiki/) });
  });
  it("reads one tree level, cached", async () => {
    const s = setup([{ match: /wikis\/w-orders\/pages\?.*recursionLevel=oneLevel/, respond: () => ({ body: { path: "/Runbooks", subPages: [{ path: "/Runbooks/Backfill", order: 1, gitItemPath: "/Runbooks/Backfill.md", isParentPage: true }, { path: "/Runbooks/Order export", order: 0 }] } }) }]);
    const r = await wikiTree(s.b(), { project: "test-project", wiki: "orders.wiki", path: "Runbooks" });
    expect(r.pages.map((p) => p.path)).toEqual(["/Runbooks/Order export", "/Runbooks/Backfill"]);
    expect(s.calls.some((c) => /path=%2FRunbooks&/.test(c.url))).toBe(true);
    expect((await wikiTree(s.b(), { project: "test-project", wiki: "orders.wiki", path: "/Runbooks" })).cached).toBe(true);
  });
  it("reads a project wiki page: markdown, ETag, the last change and the attachments", async () => {
    const s = setup([
      { match: /wikis\/w-orders\/pages\?.*includeContent=true/, respond: () => ({ body: { id: 7, path: "/Architecture/Data flow", gitItemPath: "/Architecture/Data-flow.md", content: "# Data flow\r\n![x](/.attachments/flow.png)" }, headers: { etag: `"${E1}"` } }) },
      { match: /repositories\/w-orders\/commits\?.*itemPath=%2FArchitecture%2FData-flow\.md/, respond: () => ({ body: { value: [{ commitId: C1, comment: "Add the retry rules (#4688)\n\nmore", author: author("Test User", "2026-11-25T16:20:00Z") }] } }) },
    ]);
    const r = await wikiPage(s.b(), { project: "test-project", wiki: "orders.wiki", path: "/Architecture/Data flow" });
    expect(r.page).toMatchObject({ id: 7, etag: E1, version: C1, content: "# Data flow\n![x](/.attachments/flow.png)" });
    expect(r.lastChange).toMatchObject({ short: "aaaaaaa", message: "Add the retry rules (#4688)", by: { isMe: true } });
    expect(r.attachments).toEqual([{ name: "flow.png", ref: "/.attachments/flow.png" }]);
    expect(r.code).toBeNull();
    expect(r.webUrl).toBe("https://dev.azure.com/ferron-test/test-project/_wiki/wikis/w-orders?pagePath=%2FArchitecture%2FData%20flow");
  });
  it("reads a code wiki page as a file of its repository, with what aihub browse push needs", async () => {
    const s = setup([
      {
        match: /repositories\/r-ingest\/items\?.*path=%2Fdocs%2Farchitecture%2Fdata-flow\.md.*versionDescriptor\.version=main/,
        respond: () => ({ body: { objectId: E2, gitObjectType: "blob", commitId: C2, path: "/docs/architecture/data-flow.md", content: "# data flow", latestProcessedChange: { commitId: C1, comment: "Docs", author: author("Other Person", "2026-11-20T10:00:00Z") } } }),
      },
    ]);
    const r = await wikiPage(s.b(), { project: "test-project", wiki: "ingest.wiki", path: "/architecture/data flow" });
    expect(r.code).toEqual({ project: "test-project", repo: "ingest", branch: "main", filePath: "/docs/architecture/data-flow.md", baseCommit: C2 });
    expect(r.lastChange).toMatchObject({ commit: C1, by: { name: "Other Person", isMe: false } });
  });
  it("lists the versions of a page with their parent, and diffs two of them", async () => {
    const s = setup([
      { match: /repositories\/w-orders\/commits\?.*itemPath=%2FA\.md.*%24top=51/, respond: () => ({ body: { value: [{ commitId: C2, comment: "Second", author: author("Test User", "2026-11-26T10:00:00Z") }, { commitId: C1, comment: "First", author: author("Other Person", "2026-11-20T10:00:00Z") }] } }) },
      { match: /repositories\/w-orders\/commits\?.*itemVersion\.version=b{40}.*%24top=2/, respond: () => ({ body: { value: [{ commitId: C2 }, { commitId: C1 }] } }) },
      { match: /repositories\/w-orders\/items\?.*versionDescriptor\.version=a{40}/, respond: () => ({ body: { objectId: E1, gitObjectType: "blob", commitId: C1, path: "/A.md", content: "one\ntwo\n" } }) },
      { match: /repositories\/w-orders\/items\?.*versionDescriptor\.version=b{40}/, respond: () => ({ body: { objectId: E2, gitObjectType: "blob", commitId: C2, path: "/A.md", content: "one\n2\nthree\n" } }) },
    ]);
    const h = await wikiHistory(s.b(), { project: "test-project", wiki: "orders.wiki", path: "/A" });
    expect(h.versions.map((v) => [v.short, v.parent])).toEqual([["bbbbbbb", C1], ["aaaaaaa", null]]);
    const d = await wikiRevisionDiff(s.b(), { project: "test-project", wiki: "orders.wiki", path: "/A", to: C2 });
    expect([d.from, d.added, d.removed]).toEqual([C1, 2, 1]);
  });
  it("downloads an attachment once and keeps it as a file", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const s = setup([], (url) => (/items\?path=%2F\.attachments%2Fflow\.png.*octetStream/.test(url) ? png : undefined));
    const r = await wikiAttachment(s.b(), { project: "test-project", wiki: "orders.wiki", ref: "/.attachments/flow.png" });
    expect(r).toMatchObject({ name: "flow.png", mime: "image/png", bytes: 7, cached: false });
    expect(readFileSync(r.file)).toEqual(png);
    expect((await wikiAttachment(s.b(), { project: "test-project", wiki: "orders.wiki", ref: "/.attachments/flow.png" })).cached).toBe(true);
  });
});

describe("wiki writes", () => {
  const pageGet = (content: string, etag: string): Route => ({ match: /wikis\/w-orders\/pages\?.*includeContent=true/, respond: () => ({ body: { id: 7, path: "/A", gitItemPath: "/A.md", content }, headers: { etag: `"${etag}"` } }) });
  const commits: Route = { match: /repositories\/w-orders\/commits\?/, respond: () => ({ body: { value: [{ commitId: C2, comment: "Their change", author: author("Other Person", "2026-11-27T09:56:00Z") }] } }) };

  it("publishes with If-Match and the revision comment", async () => {
    const s = setup([{ method: "PUT", match: /wikis\/w-orders\/pages\?/, respond: () => ({ body: { path: "/A", gitItemPath: "/A.md" }, headers: { etag: `"${E2}"` } }) }, commits]);
    const r = await wikiPublish(s.b(), { project: "test-project", wiki: "orders.wiki", path: "/A", content: "new", etag: E1, comment: "Add the reconciliation (#4711)" });
    expect(r).toMatchObject({ status: "published", etag: E2, version: C2 });
    const put = s.calls.find((c) => c.method === "PUT")!;
    expect((put.headers as Record<string, string>)["If-Match"]).toBe(`"${E1}"`);
    expect(put.url).toMatch(/comment=Add\+the\+reconciliation/);
    expect(put.body).toEqual({ content: "new" });
  });
  it("answers a conflict with the current version and both changes when the ETag is stale; nothing is written", async () => {
    const s = setup([
      { method: "PUT", match: /wikis\/w-orders\/pages\?/, respond: () => ({ status: 412, body: { message: "The page has been modified" } }) },
      pageGet("one\ntheirs\nthree\n", E2),
      commits,
      { match: /repositories\/w-orders\/blobs\/1{40}\?.*format=text/, respond: () => ({ text: "one\ntwo\nthree\n" }) },
    ]);
    const r = await wikiPublish(s.b(), { project: "test-project", wiki: "orders.wiki", path: "/A", content: "one\ntwo\nthree\nmine\n", etag: E1 });
    expect(r.status).toBe("conflict");
    if (r.status !== "conflict") return;
    expect(r.kind).toBe("conflict");
    expect(r.current).toMatchObject({ etag: E2, lastChange: { message: "Their change", by: { name: "Other Person" } } });
    expect(r.base.content).toBe("one\ntwo\nthree\n");
    expect(r.theirs.hunks[0].lines.filter((l) => l.kind !== "ctx").map((l) => l.text)).toEqual(["two", "theirs"]);
    expect(r.mine.hunks[0].lines.filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["mine"]);
  });
  it("overwrites on purpose with --force on top of the newest version", async () => {
    const s = setup([pageGet("x", E2), commits, { method: "PUT", match: /wikis\/w-orders\/pages\?/, respond: () => ({ body: {}, headers: { etag: `"${E1}"` } }) }]);
    const r = await wikiPublish(s.b(), { project: "test-project", wiki: "orders.wiki", path: "/A", content: "mine", force: true });
    expect(r).toMatchObject({ status: "published", overwrote: true });
    expect((s.calls.find((c) => c.method === "PUT")!.headers as Record<string, string>)["If-Match"]).toBe(`"${E2}"`);
  });
  it("refuses to publish to a code wiki or without an ETag", async () => {
    const s = setup();
    await expect(wikiPublish(s.b(), { project: "test-project", wiki: "ingest.wiki", path: "/A", content: "x", etag: E1 })).rejects.toMatchObject({ kind: "badInput", message: expect.stringMatching(/code wiki/) });
    await expect(wikiPublish(s.b(), { project: "test-project", wiki: "orders.wiki", path: "/A", content: "x" })).rejects.toMatchObject({ kind: "badInput" });
  });
  it("a publish makes the next page read fresh", async () => {
    let content = "old";
    const s = setup([
      { match: /wikis\/w-orders\/pages\?.*includeContent=true/, respond: () => ({ body: { path: "/A", gitItemPath: "/A.md", content }, headers: { etag: `"${E1}"` } }) },
      { method: "PUT", match: /wikis\/w-orders\/pages\?/, respond: () => ((content = "new"), { body: {}, headers: { etag: `"${E2}"` } }) },
      commits,
    ]);
    expect((await wikiPage(s.b(), { project: "test-project", wiki: "orders.wiki", path: "/A" })).page.content).toBe("old");
    await wikiPublish(s.b(), { project: "test-project", wiki: "orders.wiki", path: "/A", content: "new", etag: E1 });
    const again = await wikiPage(s.b(), { project: "test-project", wiki: "orders.wiki", path: "/A" });
    expect([again.cached, again.page.content]).toEqual([false, "new"]);
  });
  it("creates a page under a parent from a template, and refuses an existing one", async () => {
    let exists = false;
    const s = setup([
      { match: /wikis\/w-orders\/pages\?path=%2FArchitecture%2FCaching\+strategy/, respond: () => (exists ? { body: { path: "x" } } : { status: 404, body: { message: "not found" } }) },
      { method: "PUT", match: /wikis\/w-orders\/pages\?/, respond: () => ((exists = true), { body: {}, headers: { etag: `"${E1}"` } }) },
    ]);
    const r = await wikiCreate(s.b(), { project: "test-project", wiki: "orders.wiki", parent: "/Architecture", name: "Caching strategy", template: "decision" });
    expect(r).toMatchObject({ status: "created", path: "/Architecture/Caching strategy", etag: E1 });
    expect((s.calls.find((c) => c.method === "PUT")!.body as { content: string }).content).toMatch(/^# Caching strategy\n\n## Context/);
    await expect(wikiCreate(s.b(), { project: "test-project", wiki: "orders.wiki", parent: "/Architecture", name: "Caching strategy" })).rejects.toMatchObject({ kind: "badInput", message: expect.stringMatching(/already exists/) });
  });
  it("a new page in a code wiki is a file for aihub browse push", async () => {
    const s = setup([{ match: /repositories\/r-ingest\/refs\?.*filter=heads%2Fmain/, respond: () => ({ body: { value: [{ name: "refs/heads/main", objectId: C1 }] } }) }]);
    const r = await wikiCreate(s.b(), { project: "test-project", wiki: "ingest.wiki", parent: "/architecture", name: "Caching strategy", template: "runbook" });
    expect(r).toMatchObject({ status: "push", code: { repo: "ingest", branch: "main", filePath: "/docs/architecture/Caching-strategy.md", baseCommit: C1 } });
    expect(s.calls.some((c) => c.method !== "GET")).toBe(false);
  });
  it("plans a move: subpages and the links in other pages, from one download", async () => {
    const zip = zipOf({
      "Runbooks.md": "# Runbooks",
      "Runbooks/Backfill.md": "# Backfill\nSee [check](/Runbooks/Backfill/Controle).",
      "Runbooks/Backfill/Controle.md": "# Controle",
      "Runbooks/Order-export.md": "Run [backfill](/Runbooks/Backfill) or [again](/Runbooks/Backfill#x).",
      "Onboarding/First-week.md": "[b](/Runbooks/Backfill)",
      ".attachments/x.md": "[b](/Runbooks/Backfill)",
    });
    const s = setup([], (url) => (/w-orders\/items\?path=%2F&.*format=zip/.test(url) ? zip : undefined));
    const p = await wikiMovePlan(s.b(), { project: "test-project", wiki: "orders.wiki", path: "/Runbooks/Backfill", to: "/How we work/Backfill" });
    expect(p.subpages).toEqual(["/Runbooks/Backfill/Controle"]);
    expect(p.links.map((l) => [l.page, l.count])).toEqual([["/Runbooks/Backfill", 1], ["/Runbooks/Order export", 2], ["/Onboarding/First week", 1]]);
    expect([p.linkCount, p.pageCount]).toEqual([4, 3]);
    await expect(wikiMovePlan(s.b(), { project: "test-project", wiki: "orders.wiki", path: "/Runbooks/Backfill", to: "/Runbooks/Backfill/Sub" })).rejects.toMatchObject({ kind: "badInput" });
  });
  it("moves the page and updates the links, a page that moved along at its new path", async () => {
    const zip = zipOf({ "Runbooks/Backfill.md": "[self](/Runbooks/Backfill)", "Runbooks/Order-export.md": "[b](/Runbooks/Backfill)" });
    const pages: Record<string, string> = { "/How we work/Backfill": "[self](/Runbooks/Backfill)", "/Runbooks/Order export": "[b](/Runbooks/Backfill)" };
    const s = setup(
      [
        { method: "POST", match: /wikis\/w-orders\/pagemoves\?/, respond: () => ({ body: {} }) },
        { match: /wikis\/w-orders\/pages\?.*includeContent=true/, respond: (c) => ({ body: { path: "x", content: pages[new URL(c.url).searchParams.get("path")!] }, headers: { etag: `"${E1}"` } }) },
        { method: "PUT", match: /wikis\/w-orders\/pages\?/, respond: () => ({ body: {} }) },
        commits,
      ],
      (url) => (/format=zip/.test(url) ? zip : undefined),
    );
    const r = await wikiMove(s.b(), { project: "test-project", wiki: "orders.wiki", path: "/Runbooks/Backfill", to: "/How we work/Backfill" });
    expect(r.linksUpdated).toEqual([{ page: "/How we work/Backfill", count: 1 }, { page: "/Runbooks/Order export", count: 1 }]);
    expect(r.linkErrors).toEqual([]);
    expect(s.calls.find((c) => c.method === "POST")!.body).toEqual({ path: "/Runbooks/Backfill", newPath: "/How we work/Backfill" });
    expect(s.calls.filter((c) => c.method === "PUT").map((c) => (c.body as { content: string }).content)).toEqual(["[self](/How-we-work/Backfill)", "[b](/How-we-work/Backfill)"]);
  });
  it("uploads an attachment and answers its markdown", async () => {
    const s = setup([{ method: "PUT", match: /wikis\/w-orders\/attachments\?name=flow-diagram\.png/, respond: () => ({ body: { name: "flow-diagram.png", path: "/.attachments/flow-diagram.png" } }) }]);
    const f = join(tmp(), "flow diagram.png");
    writeFileSync(f, Buffer.from([1, 2, 3]));
    const r = await wikiUpload(s.b(), { project: "test-project", wiki: "orders.wiki", file: f });
    expect(r).toEqual({ name: "flow-diagram.png", ref: "/.attachments/flow-diagram.png", markdown: "![flow-diagram](/.attachments/flow-diagram.png)", bytes: 3 });
  });
});

describe("aihub wiki browse", () => {
  it("answers JSON, and a failure as {error:{kind}} with exit 1", async () => {
    const s = setup();
    expect(await main(["wiki", "browse", "templates"], s.ctx)).toBe(0);
    expect(JSON.parse(s.lines.join("")).templates).toHaveLength(3);
    s.lines.length = 0;
    expect(await main(["wiki", "browse", "page", "--project", "test-project", "--wiki", "orders.wiki"], s.ctx)).toBe(1);
    expect(JSON.parse(s.lines.join(""))).toEqual({ error: { kind: "badInput", message: expect.stringMatching(/--path/) } });
  });
});
