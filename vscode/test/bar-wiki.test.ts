import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { browseErrorOf, removePushFiles } from "../src/bar/browse";
import { askText, updateFromBranchText, wikiArgs, wikiUpdateStartArgs, wikiWriteFiles } from "../src/bar/wiki";
import { BAR_COMMANDS } from "../src/bar/types";

const C1 = "1".repeat(40);
const W = { project: "test-project", wiki: "orders.wiki" };

describe("wiki browser in the bar: arguments", () => {
  it("builds one aihub wiki browse call per read", () => {
    expect(wikiArgs.list()).toEqual(["wiki", "browse", "wikis"]);
    expect(wikiArgs.list({ org: "ferron-test", refresh: true })).toEqual(["wiki", "browse", "wikis", "--org", "ferron-test", "--refresh"]);
    expect(wikiArgs.tree({ ...W, path: "/Runbooks" })).toEqual(["wiki", "browse", "tree", "--project", "test-project", "--wiki", "orders.wiki", "--path", "/Runbooks"]);
    expect(wikiArgs.page({ ...W, path: "/Architecture/Data flow", version: C1 })).toEqual(["wiki", "browse", "page", "--project", "test-project", "--wiki", "orders.wiki", "--path", "/Architecture/Data flow", "--version", C1]);
    expect(wikiArgs.templates()).toEqual(["wiki", "browse", "templates"]);
    expect(wikiArgs.movePlan({ ...W, path: "/Runbooks/Backfill", to: "/How we work/Backfill" })).toEqual(["wiki", "browse", "move-plan", "--project", "test-project", "--wiki", "orders.wiki", "--path", "/Runbooks/Backfill", "--to", "/How we work/Backfill"]);
    expect(wikiArgs.history({ ...W, path: "/A", top: 20 })).toEqual(["wiki", "browse", "history", "--project", "test-project", "--wiki", "orders.wiki", "--path", "/A", "--top", "20"]);
    expect(wikiArgs.revisionDiff({ ...W, path: "/A", to: C1 })).toEqual(["wiki", "browse", "diff", "--project", "test-project", "--wiki", "orders.wiki", "--path", "/A", "--to", C1]);
    expect(wikiArgs.search({ text: "afstemming", project: "test-project", top: 25, skip: 0 })).toEqual(["wiki", "browse", "search", "--text", "afstemming", "--project", "test-project", "--top", "25", "--skip", "0"]);
    expect(wikiArgs.attachment({ ...W, ref: "/.attachments/flow.png" })).toEqual(["wiki", "browse", "attachment", "--project", "test-project", "--wiki", "orders.wiki", "--ref", "/.attachments/flow.png"]);
    expect(wikiArgs.upload({ ...W, file: "C:/tmp/flow.png" })).toEqual(["wiki", "browse", "upload", "--project", "test-project", "--wiki", "orders.wiki", "--file", "C:/tmp/flow.png"]);
  });

  it("refuses a call without its required arguments", () => {
    expect(() => wikiArgs.tree({ project: "p" } as never)).toThrow(/project and a wiki/);
    expect(() => wikiArgs.page({ ...W } as never)).toThrow(/page path/);
    expect(() => wikiArgs.search({ text: " " })).toThrow(/search text/);
    expect(() => wikiArgs.movePlan({ ...W, path: "/A" } as never)).toThrow(/new path/);
  });

  it("puts the page text and the comment of a write in private files, removed after", () => {
    const { args, dir } = wikiWriteFiles("publish", { ...W, path: "/A", content: "# A\nnew", etag: C1, comment: "Add the reconciliation (#4711)" });
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args.slice(0, 7)).toEqual(["wiki", "browse", "publish", "--project", "test-project", "--wiki", "orders.wiki"]);
    expect(at("--etag")).toBe(C1);
    expect(readFileSync(at("--content-file"), "utf8")).toBe("# A\nnew");
    expect(readFileSync(at("--comment-file"), "utf8")).toBe("Add the reconciliation (#4711)");
    expect(args.join(" ")).not.toMatch(/reconciliation/);
    removePushFiles(dir);
    expect(existsSync(join(dir, "page.md"))).toBe(false);
    expect(() => wikiWriteFiles("publish", { ...W, path: "/A", content: "x" })).toThrow(/etag/);
    expect(wikiWriteFiles("publish", { ...W, path: "/A", content: "x", force: true }).args).toContain("--force");
    const m = wikiWriteFiles("move", { ...W, path: "/A", to: "/B", updateLinks: false, order: 0 });
    expect(m.args).toEqual(expect.arrayContaining(["move", "--to", "/B", "--no-links", "--order", "0"]));
    const c = wikiWriteFiles("create", { ...W, parent: "/Architecture", name: "Caching strategy", template: "decision" });
    expect(c.args).toEqual(["wiki", "browse", "create", "--project", "test-project", "--wiki", "orders.wiki", "--parent", "/Architecture", "--name", "Caching strategy", "--template", "decision"]);
  });
});

describe("wiki browser in the bar: agent texts and failures", () => {
  it("asks about a page without publishing", () => {
    const t = askText({ ...W, path: "/Runbooks/Order export" });
    expect(t).toMatch(/aihub wiki browse page --project "test-project" --wiki "orders.wiki" --path "\/Runbooks\/Order export"/);
    expect(t).toMatch(/do not change or publish/);
    expect(askText({ ...W, path: "/A", question: "Who owns this?" })).toMatch(/Who owns this\?/);
  });
  it("updates from a branch as drafts only", () => {
    const t = updateFromBranchText({ ...W, branch: "feature/4711-orderexport", base: "main" });
    expect(t).toMatch(/feature\/4711-orderexport against main/);
    expect(t).toMatch(/\.aihub\/wiki-drafts\/orders\.wiki\//);
    expect(t).toMatch(/do not run aihub wiki browse publish/);
  });
  it("names an old CLI without the wiki browser, and passes the CLI's own error kinds", () => {
    expect(browseErrorOf(new Error("aihub: usage: aihub wiki list | pages [--path p] | read --page p")).error.kind).toBe("cliTooOld");
    expect(browseErrorOf(new Error('x {"error":{"kind":"searchUnavailable","message":"no search"}}')).error.kind).toBe("searchUnavailable");
  });
  it("has a command id for every wiki action", () => {
    const ids = Object.entries(BAR_COMMANDS).filter(([k]) => k.startsWith("wiki")).map(([, v]) => v);
    expect(ids).toHaveLength(20);
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { contributes: { commands: { command: string }[] } };
    for (const id of ids) expect(pkg.contributes.commands.some((c) => c.command === id)).toBe(true);
  });
});

describe("Update Wiki with Context from…: the start", () => {
  it("builds aihub wiki update start with the chosen pages; sources and prompt go in files; the window as chosen", () => {
    const r = wikiUpdateStartArgs({ ...W, pages: ["/Runbooks/Order export", "/Architecture/Data flow"], sources: [{ project: "test-project", repo: "orders-ingest", path: "/docs" }, { project: "test-project", repo: "x" }], prompt: "Use the new retry rule", where: "newWindow" });
    expect(r.args).toEqual(["wiki", "update", "start", "--project", "test-project", "--wiki", "orders.wiki", "--path", "/Runbooks/Order export", "--path", "/Architecture/Data flow"]);
    expect(r.sources).toHaveLength(2);
    expect(r.where).toBe("newWindow");
    expect(r.args.join(" ")).not.toMatch(/retry rule/);
    expect(wikiUpdateStartArgs({ ...W, sources: [{ project: "p", repo: "r" }] }).where).toBe("panel");
  });
  it("needs a wiki and at least one source", () => {
    expect(() => wikiUpdateStartArgs({ project: "p" } as never)).toThrow(/project and a wiki/);
    expect(() => wikiUpdateStartArgs({ ...W, sources: [] })).toThrow(/which repositories, folders or files/);
  });
});