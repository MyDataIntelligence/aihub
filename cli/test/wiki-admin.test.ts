import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, type Route } from "./helpers.js";

const NL = String.fromCharCode(10);
const WIKIS = [{ id: "w1", name: "test-project.wiki", type: "projectWiki", repositoryId: "wrepo", mappedPath: "/", versions: [{ version: "wikiMaster" }] }];
const tree = { path: "/", subPages: [{ path: "/Home" }, { path: "/Orders", subPages: [{ path: "/Orders/Daily" }] }] };

function routes(extra: Route[] = []): Route[] {
  return [{ match: /_apis\/wiki\/wikis\?/, respond: () => ({ body: { value: WIKIS } }) }, ...extra];
}

describe("aihub wiki", () => {
  it("lists wikis, prints the page tree and reads a page", async () => {
    const { dir } = makeRepo();
    const r = routes([
      { match: /wikis\/w1\/pages\?.*recursionLevel=full/, respond: () => ({ body: tree }) },
      { match: /wikis\/w1\/pages\?.*includeContent=true/, respond: (c) => (expect(c.url).toContain("path=%2FOrders%2FDaily"), { body: { id: 3, path: "/Orders/Daily", content: ["# Daily", "text"].join(NL) } }) },
    ]);
    const a = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["wiki", "list"], a.ctx)).toBe(0);
    expect(a.lines.join(NL)).toMatch(/test-project\.wiki\s+projectWiki\s+w1/);
    const b = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["wiki", "pages"], b.ctx)).toBe(0);
    expect(b.lines.join(NL)).toBe(["Home", "Orders/", "  Daily"].join(NL));
    const c = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["wiki", "read", "--page", "Orders/Daily.md"], c.ctx)).toBe(0);
    expect(c.lines.join(NL)).toBe(["# Daily", "text"].join(NL));
  });

  it("creates a page only when it does not exist; a dry-run writes nothing", async () => {
    const { dir } = makeRepo();
    const puts: any[] = [];
    let exists = false;
    const r = routes([
      { match: /wikis\/w1\/pages\?/, respond: () => (exists ? { body: { path: "/New" } } : { status: 404, body: { message: "not found" } }) },
      { method: "PUT", match: /wikis\/w1\/pages\?/, respond: (c) => (puts.push([c.url, c.body]), { body: {} }) },
    ]);
    const f = join(dir, "p.md");
    writeFileSync(f, "# New" + NL);
    const a = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["wiki", "create", "--page", "New", "--body-file", f], a.ctx)).toBe(0);
    expect(puts[0][1]).toEqual({ content: "# New" + NL });
    expect(puts[0][0]).toContain("path=%2FNew");
    puts.length = 0;
    expect(await main(["wiki", "create", "--page", "New", "--body-file", f, "--dry-run"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(puts).toEqual([]);
    exists = true;
    const e = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["wiki", "create", "--page", "New", "--body-file", f], e.ctx)).toBe(1);
    expect(e.errs.join(NL)).toContain("already exists");
  });

  it("moves a page, deletes only with --yes, and attaches a file as base64", async () => {
    const { dir } = makeRepo();
    const moved: any[] = [];
    const attached: any[] = [];
    let del = 0;
    const r = routes([
      { method: "POST", match: /wikis\/w1\/pagemoves\?/, respond: (c) => (moved.push(c.body), { body: {} }) },
      { method: "DELETE", match: /wikis\/w1\/pages\?/, respond: () => (del++, { body: {} }) },
      { method: "PUT", match: /wikis\/w1\/attachments\?/, respond: (c) => (attached.push([c.url, c.body]), { body: { name: "shot.png", path: ".attachments/shot-1.png" } }) },
    ]);
    expect(await main(["wiki", "move", "--page", "Old", "--to", "Archive/Old"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(moved[0]).toEqual({ path: "/Old", newPath: "/Archive/Old", newOrder: 0 });
    expect(await main(["wiki", "delete", "--page", "Old"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(1);
    expect(del).toBe(0);
    expect(await main(["wiki", "delete", "--page", "Old", "--yes"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(del).toBe(1);
    const img = join(dir, "shot.png");
    writeFileSync(img, "PNGDATA");
    const a = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["wiki", "attach", "--file", img], a.ctx)).toBe(0);
    expect(Buffer.from(attached[0][1]).toString("utf8")).toBe(Buffer.from("PNGDATA").toString("base64"));
    expect(a.lines.join(NL)).toContain("![shot.png](/.attachments/shot.png)");
  });

  it("shows the history of a page from the wiki repository and creates a code wiki", async () => {
    const { dir } = makeRepo();
    const posted: any[] = [];
    const r = routes([
      { match: /git\/repositories\/wrepo\/commits\?/, respond: (c) => (expect(c.url).toContain("itemPath=%2FOrders%2FDaily-Report.md"), { body: { value: [{ commitId: "abcdef1234", author: { name: "Ann", date: "2026-11-10T10:00:00Z" }, comment: "Update daily" }] } }) },
      { match: /_apis\/projects\/test-project\?/, respond: () => ({ body: { id: "proj-guid" } }) },
      { match: /_apis\/git\/repositories\/test-repo\?/, respond: () => ({ body: { id: "repo-guid" } }) },
      { method: "POST", match: /_apis\/wiki\/wikis\?/, respond: (c) => (posted.push(c.body), { body: { id: "w9" } }) },
    ]);
    const h = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["wiki", "history", "--page", "Orders/Daily Report"], h.ctx)).toBe(0);
    expect(h.lines.join(NL)).toContain("abcdef12 2026-11-10 Ann Update daily");
    expect(await main(["wiki", "create-wiki", "--name", "docs", "--code", "--folder", "docs", "--branch", "main"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(posted[0]).toEqual({ name: "docs", type: "codeWiki", projectId: "proj-guid", repositoryId: "repo-guid", mappedPath: "/docs", version: { version: "main" } });
  });

  it("keeps the existing update behaviour (diff without --publish)", async () => {
    const { dir } = makeRepo();
    const r = routes([{ match: /wikis\/w1\/pages\?/, respond: () => ({ body: { content: "old" + NL } }) }]);
    const f = join(dir, "n.md");
    writeFileSync(f, "new" + NL);
    const { ctx, lines } = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["wiki", "update", "--page", "Home", "--body-file", f], ctx)).toBe(0);
    expect(lines.join(NL)).toContain("not published, pass --publish");
  });
});
