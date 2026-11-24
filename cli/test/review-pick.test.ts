import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseFindings, parsePick } from "../src/lib/review.js";
import { commands, main } from "../src/router.js";
import { ctxFor, fakeFetch, sh, type Route } from "./helpers.js";
import { makeNamedRepo, newParent } from "./parity-helpers.js";

const PR = {
  pullRequestId: 5,
  title: "Zoek bouwen",
  description: "## Tests\n\nnog niets\n",
  status: "active",
  sourceRefName: "refs/heads/feature/1234-zoek",
  targetRefName: "refs/heads/main",
  createdBy: { displayName: "Dev One", id: "u1" },
  lastMergeSourceCommit: { commitId: "bbb" },
};

const prRoutes = (): Route[] => [
  { match: /\/pullrequests\/5\?/, respond: () => ({ body: PR }) },
  { match: /\/pullrequests\/5\/iterations\?/, respond: () => ({ body: { value: [{ id: 2, sourceRefCommit: { commitId: "bbb" }, commonRefCommit: { commitId: "aaa" } }] } }) },
  { match: /\/iterations\/2\/changes\?/, respond: () => ({ body: { changeEntries: [{ changeType: "edit", item: { path: "/a.py" } }] } }) },
  { match: /\/items\?/, respond: (c) => ({ text: decodeURIComponent(c.url).includes("version=aaa") ? "x = 1\ny = 2\n" : "x = 1\ny = 3\n" }) },
  { match: /\/pullrequests\/5\/threads\?/, respond: () => ({ body: { value: [] } }) },
];

async function run(dir: string, routes: Route[], argv: string[]) {
  const f = fakeFetch(routes);
  const { ctx, lines, errs } = ctxFor(dir, f.fn);
  const code = await main(argv, ctx, commands);
  return { code, out: lines.join("\n"), errs, calls: f.calls };
}

const FINDINGS = [
  "- n: 1",
  "  severity: major",
  "  file: a.py",
  "  line: 2",
  "  text: y is overwritten without a check.",
  "  suggestion: compare with the old value first.",
  "- n: 2",
  "  severity: nit",
  "  file: a.py",
  "  line: 1",
  "  text: Name x says nothing.",
  "- n: 3",
  "  severity: blocker",
  "  text: There is no test for the empty result.",
  "",
].join("\n");

function setup() {
  const { dir } = makeNamedRepo(newParent(), "test-repo");
  const gitDir = sh(dir, ["rev-parse", "--git-common-dir"]);
  const file = join(dir, gitDir, "aihub", "review", "pr-5.yaml");
  return { dir, file, write: () => (mkdirSync(dirname(file), { recursive: true }), writeFileSync(file, FINDINGS)) };
}

describe("aihub review prepare / post --pick", () => {
  it("prepare gives the diff with numbered lines and names the findings file; nothing is posted", async () => {
    const s = setup();
    const r = await run(s.dir, prRoutes(), ["review", "prepare", "--pr", "5"]);
    expect(r.errs).toEqual([]);
    expect(r.out).toContain("PRE-REVIEW !5: nothing is posted until the developer picks findings.");
    expect(r.out).toContain(s.file.replace(/\\/g, "\\"));
    expect(r.out).toContain("+    2 y = 3");
    expect(r.out).toContain("--pick 1,3");
    expect(r.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    // the folder of the findings file exists, so the agent can write it without a mkdir first
    expect(existsSync(dirname(s.file))).toBe(true);
    const j = await run(s.dir, prRoutes(), ["review", "prepare", "--pr", "5", "--json"]);
    expect(JSON.parse(j.out).findingsFile).toBe(s.file);
  });

  it("post without --pick lists the findings and posts nothing", async () => {
    const s = setup();
    s.write();
    const r = await run(s.dir, prRoutes(), ["review", "post", "--pr", "5"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("nothing posted (no --pick)");
    expect(r.out).toContain("1. [major] a.py:2 y is overwritten");
    expect(r.out).toContain("3. [blocker] (general) There is no test");
    expect(r.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("post --pick 1,3 posts only those two, on the right line, with severity and suggestion", async () => {
    const s = setup();
    s.write();
    const posted: any[] = [];
    const routes: Route[] = [{ method: "POST", match: /pullrequests\/5\/threads\?/, respond: (c) => (posted.push(c.body), { body: { id: 100 + posted.length } }) }, ...prRoutes()];
    const r = await run(s.dir, routes, ["review", "post", "--pr", "5", "--pick", "1,3"]);
    expect(r.errs).toEqual([]);
    expect(posted).toHaveLength(2);
    expect(posted[0].threadContext.filePath).toBe("/a.py");
    expect(posted[0].threadContext.rightFileStart.line).toBe(2);
    expect(posted[0].comments[0].content).toBe("[major] y is overwritten without a check.\n\nSuggestion: compare with the old value first.");
    expect(posted[1].threadContext).toBeUndefined();
    expect(posted[1].comments[0].content).toBe("[blocker] There is no test for the empty result.");
    expect(r.out).toContain("finding(s) 1, 3");
    expect(r.out).toContain("the other findings were not posted");
  });

  it("an unknown pick number posts nothing at all", async () => {
    const s = setup();
    s.write();
    const posted: any[] = [];
    const routes: Route[] = [{ method: "POST", match: /pullrequests\/5\/threads\?/, respond: (c) => (posted.push(c.body), { body: { id: 1 } }) }, ...prRoutes()];
    const r = await run(s.dir, routes, ["review", "post", "--pr", "5", "--pick", "1,9"]);
    expect(r.code).not.toBe(0);
    expect(r.errs.join("\n")).toContain("there is no finding 9");
    expect(posted).toHaveLength(0);
  });

  it("without a findings file it says how to make one; the old --comments-file route still works", async () => {
    const s = setup();
    const none = await run(s.dir, prRoutes(), ["review", "post", "--pr", "5", "--pick", "1"]);
    expect(none.errs.join("\n")).toContain("run 'aihub review prepare --pr 5'");
    expect(existsSync(s.file)).toBe(false);
    const cf = join(dirname(s.file), "..", "c.yaml");
    mkdirSync(dirname(cf), { recursive: true });
    writeFileSync(cf, "- text: Mooi werk.\n");
    const posted: any[] = [];
    const routes: Route[] = [{ method: "POST", match: /pullrequests\/5\/threads\?/, respond: (c) => (posted.push(c.body), { body: { id: 7 } }) }, ...prRoutes()];
    const old = await run(s.dir, routes, ["review", "post", "--pr", "5", "--comments-file", cf]);
    expect(old.out).toContain("1 thread(s) created");
    expect(readFileSync(cf, "utf8")).toContain("Mooi werk");
  });
});

describe("findings helpers", () => {
  it("numbers default to the position, duplicates and bad severities are refused", () => {
    expect(parseFindings("- text: a\n- text: b\n  severity: NIT\n").map((f) => [f.n, f.severity])).toEqual([[1, "minor"], [2, "nit"]]);
    expect(() => parseFindings("- n: 1\n  text: a\n- n: 1\n  text: b\n")).toThrow(/used twice/);
    expect(() => parseFindings("- text: a\n  severity: huge\n")).toThrow(/severity/);
    expect(() => parseFindings("- text: a\n  line: 3\n")).toThrow(/needs a file/);
  });

  it("pick accepts lists, ranges and all", () => {
    const f = parseFindings("- text: a\n- text: b\n- text: c\n- text: d\n");
    expect(parsePick("1,3", f)).toEqual([1, 3]);
    expect(parsePick("2-4", f)).toEqual([2, 3, 4]);
    expect(parsePick("all", f)).toEqual([1, 2, 3, 4]);
    expect(() => parsePick("", f)).toThrow(/empty/);
  });
});
