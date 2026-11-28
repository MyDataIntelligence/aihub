import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { browseOf } from "../src/lib/browse/core.js";
import { fileToPage, pageFile, parseSources, updateApply, updateDiff, updateDiscard, updateList, updateRead, updateStart, updateWrite } from "../src/lib/wiki/update.js";
import { ctxFor, fakeFetch, tmp, write, type Route } from "./helpers.js";

// A synthetic organisation: test-project has a project wiki orders.wiki and a code wiki ingest.wiki.
const NOW = Date.parse("2026-11-28T10:00:00Z");
const E1 = "1".repeat(40);
const E2 = "2".repeat(40);
const E9 = "9".repeat(40);
const C1 = "a".repeat(40);
const PW = "w-orders";
const wikis = [
  { id: PW, name: "orders.wiki", type: "projectWiki", projectId: "p1", repositoryId: PW, mappedPath: "/", versions: [{ version: "wikiMaster" }] },
  { id: "w-ingest", name: "ingest.wiki", type: "codeWiki", projectId: "p1", repositoryId: "r-ingest", mappedPath: "/docs", versions: [{ version: "main" }] },
];

/** The wiki as a map path -> { content, etag }; GET/PUT pages work on it, If-Match is checked like Azure DevOps does. */
function wikiWorld(pages: Record<string, { content: string; etag: string }>): Route[] {
  return [
    { match: /\/_apis\/connectionData/, respond: () => ({ body: { authenticatedUser: { id: "me", providerDisplayName: "Test User" } } }) },
    { match: /ferron-test\/_apis\/wiki\/wikis\?/, respond: () => ({ body: { value: wikis } }) },
    { match: /ferron-test\/_apis\/projects\?/, respond: () => ({ body: { value: [{ id: "p1", name: "test-project" }] } }) },
    { match: /ferron-test\/_apis\/git\/repositories\?/, respond: () => ({ body: { value: [{ id: "r-ingest", name: "ingest" }] } }) },
    { match: /repositories\/w-orders\/commits\?/, respond: () => ({ body: { value: [{ commitId: C1, comment: "Their change", author: { name: "Other Person", email: "other@example.test", date: "2026-11-28T09:00:00Z" } }] } }) },
    {
      match: /wikis\/w-orders\/pages\?/,
      respond: (c) => {
        const p = pages[new URL(c.url).searchParams.get("path")!];
        return p ? { body: { path: new URL(c.url).searchParams.get("path"), gitItemPath: "/x.md", content: p.content }, headers: { etag: `"${p.etag}"` } } : { status: 404, body: { message: "The page could not be found (404)" } };
      },
    },
    {
      method: "PUT",
      match: /wikis\/w-orders\/pages\?/,
      respond: (c) => {
        const path = new URL(c.url).searchParams.get("path")!;
        const ifMatch = (c.headers as Record<string, string>)["If-Match"];
        const cur = pages[path];
        if (cur && ifMatch !== `"${cur.etag}"`) return { status: 412, body: { message: "The page has been modified" } };
        pages[path] = { content: (c.body as { content: string }).content, etag: E9 };
        return { body: { path }, headers: { etag: `"${E9}"` } };
      },
    },
    { match: /repositories\/w-orders\/blobs\//, respond: () => ({ text: "old" }) },
  ];
}

function setup(pages: Record<string, { content: string; etag: string }>, team?: string) {
  const f = fakeFetch(wikiWorld(pages));
  const dir = tmp();
  if (team !== undefined) {
    write(dir, ".agents/skills/_shared/references/team.yaml", team);
    write(dir, "docs/wiki-page.md", "# <title>\n\n## Purpose\n\n## Owner\n");
  }
  const { ctx, lines } = ctxFor(dir, f.fn);
  ctx.env.AIHUB_ADO_ORG = "ferron-test";
  ctx.env.AIHUB_CONFIG_HOME = tmp();
  ctx.now = () => NOW;
  return { ctx, lines, calls: f.calls, b: () => browseOf(ctx, {}) };
}

const SOURCES = [
  { project: "test-project", repo: "orders-ingest", path: "/docs/retry.md" },
  { project: "test-project", repo: "orders-api", local: "C:/src/orders-api" },
];

describe("wiki update: names", () => {
  it("maps a page to a readable file and back", () => {
    expect(pageFile("/Runbooks/Order export")).toBe("Runbooks/Order export.md");
    expect(pageFile("/A/Why? Because: yes")).toBe("A/Why%3F Because%3A yes.md");
    expect(fileToPage("A/Why%3F Because%3A yes.md")).toBe("/A/Why? Because: yes");
    expect(fileToPage("Runbooks\\Order export.md")).toBe("/Runbooks/Order export");
  });
  it("checks the sources", () => {
    expect(parseSources([{ project: "p", repo: "r", path: "docs" }])).toEqual([{ project: "p", repo: "r", path: "/docs" }]);
    expect(() => parseSources([{ repo: "r" }])).toThrow(/project and a repo/);
    expect(() => parseSources({})).toThrow(/JSON list/);
  });
});

describe("wiki update: chosen pages", () => {
  it("starts a workspace with the chosen pages, TASK.md with the sources, the team language and the limits", async () => {
    const s = setup({ "/Runbooks/Order export": { content: "# Order export\nRetries: once.\n", etag: E1 }, "/Architecture/Data flow": { content: "# Data flow\n", etag: E2 } }, "language: nl\nwiki:\n  pageTemplate: docs/wiki-page.md\n");
    const r = await updateStart(s.b(), { project: "test-project", wiki: "orders.wiki", pages: ["/Runbooks/Order export", "Architecture/Data flow"], sources: SOURCES, prompt: "Describe the new retry rule." });
    expect(r.chosen).toEqual(["/Runbooks/Order export", "/Architecture/Data flow"]);
    expect(r.allowNew).toBe(false);
    expect(r.language).toBe("nl");
    expect(r.template).toBe(true);
    expect(readFileSync(join(r.pagesDir, "Runbooks/Order export.md"), "utf8")).toBe("# Order export\nRetries: once.\n");
    const task = readFileSync(r.taskFile, "utf8");
    expect(task).toMatch(/Describe the new retry rule\./);
    expect(task).toMatch(/Update only these pages: \/Runbooks\/Order export, \/Architecture\/Data flow/);
    expect(task).toMatch(/Read it: `aihub browse file --project "test-project" --repo "orders-ingest" --path "\/docs\/retry.md"`/);
    expect(task).toMatch(/a clone on this PC at .*orders-api.*never change, commit or push it/);
    expect(task).toMatch(/Write in Dutch/);
    expect(task).toMatch(/## Purpose/); // the team's page template
    expect(task).toMatch(/never run `aihub wiki update apply`/);
    expect(r.agentPrompt).toBe("Read TASK.md and update the wiki pages under ./pages as it describes. Do not publish.");
    expect(s.calls.some((c) => c.method !== "GET")).toBe(false); // nothing written to the wiki
  });

  it("shows the proposal per page and names what may not change", async () => {
    const s = setup({ "/Runbooks/Order export": { content: "# Order export\nRetries: once.\n", etag: E1 }, "/Onboarding": { content: "# Onboarding\n", etag: E2 } });
    const r = await updateStart(s.b(), { project: "test-project", wiki: "orders.wiki", pages: ["/Runbooks/Order export"], sources: SOURCES });
    writeFileSync(join(r.pagesDir, "Runbooks/Order export.md"), "# Order export\nRetries: three times (MAX_RETRIES = 3).\n");
    await updateRead(s.b(), r.id, "/Onboarding"); // read for context
    writeFileSync(join(r.pagesDir, "Onboarding.md"), "# Onboarding\nchanged\n");
    updateWrite(s.ctx.env, r.id, "/Runbooks/New page", "# New\n");
    const d = updateDiff(s.ctx.env, r.id);
    expect(d.pages.map((p) => [p.path, p.status, p.additions, p.deletions])).toEqual([
      ["/Onboarding", "modified", 1, 0],
      ["/Runbooks/New page", "added", 1, 0],
      ["/Runbooks/Order export", "modified", 1, 1],
    ]);
    expect(d.problems.map((p) => [p.path, p.kind])).toEqual([
      ["/Onboarding", "notChosen"],
      ["/Runbooks/New page", "newNotAllowed"],
    ]);
  });

  it("publishes with If-Match on the ETag each page was read at; refuses what may not change; a page changed meanwhile is a conflict and stays a proposal", async () => {
    const pages = { "/Runbooks/Order export": { content: "# Order export\nRetries: once.\n", etag: E1 }, "/Architecture/Data flow": { content: "# Data flow\n", etag: E2 } };
    const s = setup(pages);
    const r = await updateStart(s.b(), { project: "test-project", wiki: "orders.wiki", pages: ["/Runbooks/Order export", "/Architecture/Data flow"], sources: SOURCES });
    writeFileSync(join(r.pagesDir, "Runbooks/Order export.md"), "# Order export\nRetries: three times.\n");
    writeFileSync(join(r.pagesDir, "Architecture/Data flow.md"), "# Data flow\nAfstemming added.\n");
    updateWrite(s.ctx.env, r.id, "/Runbooks/Extra", "# Extra\n");
    pages["/Architecture/Data flow"] = { content: "# Data flow\nTheir edit.\n", etag: "3".repeat(40) }; // someone else published meanwhile
    const a = await updateApply(s.b(), r.id, { comment: "Retry rule from orders-ingest (#4711)" });
    expect(a.results.map((x) => [x.path, x.status])).toEqual([
      ["/Architecture/Data flow", "conflict"],
      ["/Runbooks/Extra", "refused"],
      ["/Runbooks/Order export", "published"],
    ]);
    expect(a.results[0].message).toMatch(/changed in the wiki after it was read \(Other Person\); nothing was published/);
    expect(pages["/Architecture/Data flow"].content).toBe("# Data flow\nTheir edit.\n"); // never overwritten
    expect(pages["/Runbooks/Order export"].content).toBe("# Order export\nRetries: three times.\n");
    const put = s.calls.find((c) => c.method === "PUT" && /Order\+export/.test(c.url))!;
    expect((put.headers as Record<string, string>)["If-Match"]).toBe(`"${E1}"`);
    expect(put.url).toMatch(/comment=Retry\+rule/);
    expect(a.left).toEqual(["/Architecture/Data flow", "/Runbooks/Extra"]);
    // a second apply does not publish the same page again
    const again = await updateApply(s.b(), r.id, { paths: ["/Architecture/Data flow"] });
    expect(again.results.map((x) => x.status)).toEqual(["conflict"]);
    expect(s.calls.filter((c) => c.method === "PUT" && /Order\+export/.test(c.url))).toHaveLength(1);
  });

  it("discards one proposal or the whole update", async () => {
    const s = setup({ "/A": { content: "# A\n", etag: E1 } });
    const r = await updateStart(s.b(), { project: "test-project", wiki: "orders.wiki", pages: ["/A"], sources: [] });
    writeFileSync(join(r.pagesDir, "A.md"), "# A changed\n");
    expect(updateDiff(s.ctx.env, r.id).pages).toHaveLength(1);
    updateDiscard(s.ctx.env, r.id, "/A");
    expect(updateDiff(s.ctx.env, r.id).pages).toHaveLength(0);
    expect(updateList(s.ctx.env).updates.map((u) => u.id)).toEqual([r.id]);
    updateDiscard(s.ctx.env, r.id);
    expect(existsSync(r.dir)).toBe(false);
    expect(s.calls.some((c) => c.method !== "GET")).toBe(false);
  });
});

describe("wiki update: a whole wiki", () => {
  it("allows new pages when no page was chosen, and creates them on apply", async () => {
    const pages: Record<string, { content: string; etag: string }> = {};
    const s = setup(pages);
    const r = await updateStart(s.b(), { project: "test-project", wiki: "orders.wiki", sources: SOURCES });
    expect(r.allowNew).toBe(true);
    expect(readFileSync(r.taskFile, "utf8")).toMatch(/You may propose a NEW page/);
    expect(readFileSync(r.taskFile, "utf8")).toMatch(/Write in the language the page is already written in/);
    updateWrite(s.ctx.env, r.id, "/Runbooks/Retry rules", "# Retry rules\nThree times.\n");
    expect(updateDiff(s.ctx.env, r.id).problems).toEqual([]);
    const a = await updateApply(s.b(), r.id, {});
    expect(a.results).toMatchObject([{ path: "/Runbooks/Retry rules", status: "created" }]);
    expect(pages["/Runbooks/Retry rules"].content).toBe("# Retry rules\nThree times.\n");
    expect(updateDiff(s.ctx.env, r.id).status).toBe("applied");
  });

  it("refuses a code wiki and points at Change with Agent", async () => {
    const s = setup({});
    await expect(updateStart(s.b(), { project: "test-project", wiki: "ingest.wiki" })).rejects.toMatchObject({ kind: "badInput", message: expect.stringMatching(/code wiki.*browse change start/) });
  });
});

describe("aihub wiki update", () => {
  it("answers JSON with the sources from a file, and a failure as {error:{kind}}", async () => {
    const s = setup({ "/A": { content: "# A\n", etag: E1 } });
    const sf = join(tmp(), "sources.json");
    writeFileSync(sf, JSON.stringify(SOURCES));
    expect(await main(["wiki", "update", "start", "--project", "test-project", "--wiki", "orders.wiki", "--path", "/A", "--sources-file", sf], s.ctx)).toBe(0);
    const started = JSON.parse(s.lines.join(""));
    expect(started.sources).toHaveLength(2);
    s.lines.length = 0;
    expect(await main(["wiki", "update", "diff", "--id", started.id], s.ctx)).toBe(0);
    expect(JSON.parse(s.lines.join(""))).toMatchObject({ id: started.id, pages: [] });
    s.lines.length = 0;
    expect(await main(["wiki", "update", "diff", "--id", "nope"], s.ctx)).toBe(1);
    expect(JSON.parse(s.lines.join("")).error.kind).toBe("notFound");
  });
});
