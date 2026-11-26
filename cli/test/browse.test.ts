import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { browseOf, errorJson, kindOf, normPath, parseRef, BrowseError } from "../src/lib/browse/core.js";
import { hunks, merge3, edits, splitLines } from "../src/lib/browse/lineDiff.js";
import { browseBranches, browseDiff, browseFile, browseHistory, browseItems, browseProject, browseProjects, browseRepo, mapBranches, parsePorcelain, readmeSummary } from "../src/lib/browse/read.js";
import { browseFind, browseSearch, linesOf, nameScore, rankFind, rememberRepo } from "../src/lib/browse/search.js";
import { browsePush, isProtected, suggestBranch } from "../src/lib/browse/push.js";
import { ctxFor, fakeFetch, tmp, type Route } from "./helpers.js";

const ORG = "https://dev.azure.com/ferron-test";
const NOW = Date.parse("2026-11-26T14:21:00Z");
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const C3 = "3".repeat(40);
const ME = { id: "me-id", providerDisplayName: "Test User", properties: { Account: { $value: "test.user@example.test" } } };
const author = (name: string, date: string) => ({ name, email: `${name.toLowerCase().replace(/ /g, ".")}@example.test`, date });

const base: Route[] = [
  { match: /\/_apis\/connectionData/, respond: () => ({ body: { authenticatedUser: ME } }) },
  {
    match: /^https:\/\/dev\.azure\.com\/ferron-test\/_apis\/projects\?/,
    respond: () => ({ body: { value: [{ id: "p1", name: "test-project", description: "Synthetic project" }, { id: "p2", name: "test-project-agile" }] } }),
  },
  {
    match: /^https:\/\/dev\.azure\.com\/ferron-test\/_apis\/git\/repositories\?/,
    respond: () => ({
      body: {
        value: [
          { id: "r1", name: "repo-a", defaultBranch: "refs/heads/main", size: 1200, remoteUrl: "https://ferron-test@dev.azure.com/ferron-test/test-project/_git/repo-a", project: { id: "p1", name: "test-project" } },
          { id: "r2", name: "repo-old", defaultBranch: "refs/heads/main", isDisabled: true, project: { id: "p1", name: "test-project" } },
          { id: "r3", name: "repo-empty", project: { id: "p1", name: "test-project" } },
          { id: "r4", name: "agile-repo", defaultBranch: "refs/heads/staging", project: { id: "p2", name: "test-project-agile" } },
        ],
      },
    }),
  },
];

function setup(extra: Route[] = []) {
  const f = fakeFetch([...extra, ...base]);
  const { ctx, lines, errs } = ctxFor(tmp(), f.fn);
  ctx.env.AIHUB_ADO_ORG = "ferron-test";
  ctx.now = () => NOW;
  return { ctx, lines, errs, calls: f.calls, b: (refresh = false) => browseOf(ctx, { refresh }) };
}

const item = (path: string, type: "tree" | "blob", commit = C1, extra: object = {}) => ({ objectId: `obj-${path}`, gitObjectType: type, commitId: commit, path, ...(type === "tree" ? { isFolder: true } : {}), ...extra });

describe("browse core", () => {
  it("parses refs: branch, tag:, commit:", () => {
    expect(parseRef(undefined)).toBeUndefined();
    expect(parseRef("refs/heads/main")).toEqual({ name: "main", kind: "branch" });
    expect(parseRef("tag:v1.2")).toEqual({ name: "v1.2", kind: "tag" });
    expect(parseRef(`commit:${C1}`)).toEqual({ name: C1, kind: "commit" });
    expect(() => parseRef("commit:xyz")).toThrow(/not a commit id/);
  });
  it("normalises paths", () => {
    expect(normPath(undefined)).toBe("/");
    expect(normPath("dbt\\models\\")).toBe("/dbt/models");
  });
  it("names the kind of a failure", () => {
    expect(kindOf(new Error("not signed in to Azure DevOps: run 'az login'"))).toBe("signedOut");
    expect(kindOf(new Error("Azure DevOps denied access (403): ..."))).toBe("noAccess");
    expect(kindOf(new Error("Azure DevOps: not found (404) for GET x"))).toBe("notFound");
    expect(kindOf(new Error("fetch failed"))).toBe("offline");
    expect(errorJson(new BrowseError("conflict" as never, "x")).error.kind).toBe("conflict");
  });
  it("needs an organisation", () => {
    const { ctx } = ctxFor(tmp(), fakeFetch([]).fn);
    expect(() => browseOf(ctx, {})).toThrow(/--org/);
  });
});

describe("browse projects", () => {
  it("lists projects with their repositories; disabled ones cannot be opened; a second read comes from the cache", async () => {
    const s = setup();
    const r = await browseProjects(s.b());
    expect(r.org).toBe("ferron-test");
    expect(r.cached).toBe(false);
    expect(r.projects.map((p) => p.name)).toEqual(["test-project", "test-project-agile"]);
    const tp = r.projects[0];
    expect(tp.repos.map((x) => [x.repo, x.canOpen, x.reason])).toEqual([
      ["repo-a", true, null],
      ["repo-empty", true, "empty"],
      ["repo-old", false, "disabled"],
    ]);
    expect(tp.cannotOpen).toBe(1);
    expect(tp.repos[0].remoteUrl).toBe("https://dev.azure.com/ferron-test/test-project/_git/repo-a"); // no user name
    expect(tp.repos[0].webUrl).toBe(`${ORG}/test-project/_git/repo-a`);
    const n = s.calls.length;
    const again = await browseProjects(s.b());
    expect(again.cached).toBe(true);
    expect(s.calls.length).toBe(n);
    await browseProjects(s.b(true));
    expect(s.calls.length).toBeGreaterThan(n);
  });

  it("remembers not signed in for 5 minutes", async () => {
    const f = fakeFetch([{ match: /.*/, respond: () => ({ status: 401 }) }]);
    const { ctx } = ctxFor(tmp(), f.fn);
    ctx.env.AIHUB_ADO_ORG = "ferron-test";
    let t = NOW;
    ctx.now = () => t;
    await expect(browseProjects(browseOf(ctx, {}))).rejects.toMatchObject({ kind: "signedOut" });
    const n = f.calls.length;
    await expect(browseProjects(browseOf(ctx, {}))).rejects.toMatchObject({ kind: "signedOut" });
    expect(f.calls.length).toBe(n);
    t += 6 * 60_000;
    await expect(browseProjects(browseOf(ctx, {}))).rejects.toMatchObject({ kind: "signedOut" });
    expect(f.calls.length).toBeGreaterThan(n);
  });
});

describe("browse items and file", () => {
  const routes: Route[] = [
    {
      match: /repo-a\/items\?.*scopePath=%2Fdbt&recursionLevel=OneLevel/,
      respond: () => ({ body: { value: [item("/dbt", "tree"), item("/dbt/zeta.sql", "blob"), item("/dbt/models", "tree", C1, { latestProcessedChange: { commitId: C2, comment: "Add models\n\nbody", author: author("Sanne de Vries", "2026-11-20T10:00:00Z") } }), item("/dbt/Alpha.yml", "blob")] } }),
    },
    { match: /repo-a\/items\?path=%2Fsrc%2Fbig\.txt/, respond: () => ({ body: { ...item("/src/big.txt", "blob"), content: "x".repeat(2048) } }) },
    { match: /repo-a\/items\?path=%2Flogo\.png/, respond: () => ({ body: { ...item("/logo.png", "blob"), content: "PNG\u0000\u0001", contentMetadata: { isBinary: true } } }) },
    {
      match: /repo-a\/items\?path=%2Fsrc%2Fapp\.py/,
      respond: () => ({ body: { ...item("/src/app.py", "blob", C1), content: "print('hi')\n", latestProcessedChange: { commitId: C2, comment: "Fix", author: author("Test User", "2026-11-21T09:00:00Z") } } }),
    },
  ];

  it("lists one folder level, folders first, names the commit; the same commit is then read from the cache", async () => {
    const s = setup(routes);
    const r = await browseItems(s.b(), { project: "test-project", repo: "repo-a", path: "dbt", lastCommit: true });
    expect(r.ref).toEqual({ name: "main", kind: "branch", commit: C1 });
    expect(r.items.map((x) => [x.name, x.kind])).toEqual([
      ["models", "folder"],
      ["Alpha.yml", "file"],
      ["zeta.sql", "file"],
    ]);
    expect(r.items[0].lastCommit).toMatchObject({ id: C2, short: "2222222", message: "Add models", by: { name: "Sanne de Vries", isMe: false } });
    const url = s.calls.find((c) => c.url.includes("scopePath"))!.url;
    expect(url).toContain("versionDescriptor.version=main");
    expect(url).toContain("latestProcessedChange=true");
    const n = s.calls.length;
    const byCommit = await browseItems(s.b(), { project: "test-project", repo: "repo-a", path: "/dbt", lastCommit: true, ref: `commit:${C1}` });
    expect(byCommit.cached).toBe(true);
    expect(s.calls.length).toBe(n);
  });

  it("reads a text file with its last commit; binary and too large come without content", async () => {
    const s = setup(routes);
    const f = await browseFile(s.b(), { project: "test-project", repo: "repo-a", path: "/src/app.py" });
    expect(f).toMatchObject({ content: "print('hi')\n", binary: false, tooLarge: false, sizeBytes: 12, ref: { commit: C1 }, lastCommit: { id: C2, by: { isMe: true } } });
    expect(f.webUrl).toBe(`${ORG}/test-project/_git/repo-a?path=%2Fsrc%2Fapp.py&version=GBmain`);
    const big = await browseFile(s.b(), { project: "test-project", repo: "repo-a", path: "/src/big.txt", maxBytes: 1000 });
    expect(big).toMatchObject({ tooLarge: true, content: null });
    const png = await browseFile(s.b(), { project: "test-project", repo: "repo-a", path: "/logo.png" });
    expect(png).toMatchObject({ binary: true, content: null, sizeBytes: null });
  });

  it("refuses a disabled repository and an unknown one", async () => {
    const s = setup(routes);
    await expect(browseItems(s.b(), { project: "test-project", repo: "repo-old" })).rejects.toMatchObject({ kind: "noAccess" });
    await expect(browseItems(s.b(), { project: "test-project", repo: "nope" })).rejects.toMatchObject({ kind: "notFound" });
  });
});

describe("browse branches, history, diff", () => {
  it("maps branches: default first, then mine, then by name; tags peeled", () => {
    const me = { id: "me-id", name: "Test User", email: "test.user@example.test" };
    const r = mapBranches(
      [
        { name: "refs/heads/zeta", objectId: C1, creator: { displayName: "Other", uniqueName: "o@example.test", id: "x" } },
        { name: "refs/heads/feature/4711-fix", objectId: C2, creator: { displayName: "Test User", uniqueName: "test.user@example.test", id: "me-id" } },
        { name: "refs/heads/main", objectId: C3 },
        { name: "refs/tags/v1.2", objectId: "tagobj", peeledObjectId: C1 },
        { name: "refs/tags/v1.10", objectId: C2 },
      ],
      "main",
      me,
    );
    expect(r.branches.map((x) => x.name)).toEqual(["main", "feature/4711-fix", "zeta"]);
    expect(r.branches[1].isMine).toBe(true);
    expect(r.tags).toEqual([
      { name: "v1.10", commit: C2 },
      { name: "v1.2", commit: C1 },
    ]);
    expect(mapBranches([{ name: "refs/heads/a", objectId: C1 }, { name: "refs/heads/b", objectId: C1 }], "a", me, undefined, 1).more).toBe(true);
  });

  it("reads branches through the API", async () => {
    const s = setup([{ match: /repo-a\/refs\?filter=heads/, respond: () => ({ body: { value: [{ name: "refs/heads/main", objectId: C1 }] } }) }, { match: /repo-a\/refs\?filter=tags/, respond: () => ({ body: { value: [] } }) }]);
    const r = await browseBranches(s.b(), { project: "test-project", repo: "repo-a" });
    expect(r).toMatchObject({ default: "main", count: 1, more: false });
  });

  it("reads the history of a file, one more than asked to know there is more", async () => {
    const s = setup([
      {
        match: /repo-a\/commits\?/,
        respond: (c) => {
          expect(c.url).toContain("searchCriteria.itemPath=%2Fsrc%2Fapp.py");
          expect(c.url).toContain("searchCriteria.%24top=3");
          return { body: { value: [C1, C2, C3].map((id, i) => ({ commitId: id, comment: `change ${i}`, author: author("Noor Visser", `2026-11-2${i}T10:00:00Z`) })) } };
        },
      },
    ]);
    const h = await browseHistory(s.b(), { project: "test-project", repo: "repo-a", path: "/src/app.py", top: 2 });
    expect(h.commits.map((c) => c.message)).toEqual(["change 0", "change 1"]);
    expect(h.more).toBe(true);
    expect(h.commits[0].webUrl).toBe(`${ORG}/test-project/_git/repo-a/commit/${C1}`);
  });

  it("gives the diff of one commit to one file as hunks", async () => {
    const s = setup([
      { match: new RegExp(`repo-a/commits/${C2}\\?`), respond: () => ({ body: { commitId: C2, parents: [C1], comment: "Fix typo", author: author("Tom Bakker", "2026-11-22T08:00:00Z") } }) },
      { match: new RegExp(`repo-a/commits/${C2}/changes`), respond: () => ({ body: { changes: [{ item: { path: "/a.py" }, changeType: "edit" }] } }) },
      { match: new RegExp(`items\\?path=%2Fa\\.py.*version=${C1}`), respond: () => ({ body: { ...item("/a.py", "blob", C1), content: "one\ntwo\nthree\n" } }) },
      { match: new RegExp(`items\\?path=%2Fa\\.py.*version=${C2}`), respond: () => ({ body: { ...item("/a.py", "blob", C2), content: "one\nTWO\nthree\n" } }) },
    ]);
    const d = await browseDiff(s.b(), { project: "test-project", repo: "repo-a", commit: C2, path: "a.py" });
    expect(d).toMatchObject({ changeType: "edit", parent: C1, commit: { message: "Fix typo", by: { name: "Tom Bakker" } } });
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks[0].lines.map((l) => `${l.kind}:${l.text}`)).toEqual(["ctx:one", "del:two", "add:TWO", "ctx:three"]);
  });
});

describe("browse project and repository pages", () => {
  const commits = [
    { commitId: C3, comment: "Newest", author: author("Sanne de Vries", "2026-11-25T10:00:00Z") },
    { commitId: C2, comment: "Mine", author: { name: "Test User", email: "test.user@example.test", date: "2026-11-20T10:00:00Z" } },
    { commitId: C1, comment: "Old", author: author("Sanne de Vries", "2026-09-01T10:00:00Z") },
  ];
  const routes: Route[] = [
    { match: /projectanalysis\/languagemetrics/, respond: () => ({ body: { repositoryLanguageAnalytics: [{ name: "repo-a", languageBreakdown: [{ name: "SQL", languagePercentage: 20 }, { name: "Python", languagePercentage: 70 }] }] } }) },
    { match: /repo-a\/commits\/[0-9]+\/changes/, respond: () => ({ body: { changes: [{ item: { path: "/src/app.py", gitObjectType: "blob" }, changeType: "edit" }, { item: { path: "/src", isFolder: true }, changeType: "edit" }, { item: { path: "/gone.py" }, changeType: "delete" }] } }) },
    { match: /repo-a\/commits\?/, respond: () => ({ body: { value: commits } }) },
    { match: /repo-a\/items\?path=%2FREADME\.md/, respond: () => ({ body: { ...item("/README.md", "blob"), content: "# repo-a\n\n[![badge](x)](y)\n\nOrders **export** for fixture_a.\n" } }) },
    { match: /repo-empty|repo-old/, respond: () => ({ status: 500 }) },
    { match: /repo-a\/items\?scopePath=%2F&/, respond: () => ({ body: { value: [item("/", "tree"), item("/README.md", "blob"), item("/src", "tree")] } }) },
    { match: /repo-a\/refs\?filter=heads/, respond: () => ({ body: { value: [{ name: "refs/heads/main", objectId: C1 }, { name: "refs/heads/x", objectId: C1 }] } }) },
    { match: /repo-a\/pullrequests\?/, respond: () => ({ body: { value: [{ pullRequestId: 42, title: "Export", createdBy: { displayName: "Test User", id: "me-id" }, sourceRefName: "refs/heads/feature/4711", targetRefName: "refs/heads/main", creationDate: "2026-11-24T10:00:00Z" }] } }) },
    { match: /build\/builds\?/, respond: () => ({ status: 500, body: { message: "pipelines are down" } }) },
  ];

  it("project page: languages, README summary, last activity, recent files and active authors of 30 days", async () => {
    const s = setup(routes);
    const p = await browseProject(s.b(), "test-project");
    const a = p.repos.find((r) => r.repo === "repo-a")!;
    expect(a).toMatchObject({ language: "Python", description: "Orders export for fixture_a.", lastActivity: { commit: C3, message: "Newest" } });
    expect(p.cannotOpen).toEqual([{ repo: "repo-old", reason: "disabled" }]);
    expect(p.recentFiles).toEqual([{ repo: "repo-a", path: "/src/app.py", at: "2026-11-25T10:00:00Z", by: { name: "Sanne de Vries", email: "sanne.de.vries@example.test", isMe: false }, commit: C3, message: "Newest" }]);
    expect(p.activeAuthors.map((x) => [x.name, x.commits, x.isMe])).toEqual([
      ["Sanne de Vries", 1, false],
      ["Test User", 1, true],
    ]);
    expect(p.errors).toEqual([]);
  });

  it("repository page: README, root, counts, PRs and commits; a failing part fails on its own and is not cached", async () => {
    const s = setup(routes);
    const r = await browseRepo(s.b(), { project: "test-project", repo: "repo-a" });
    expect(r.readme?.markdown).toContain("Orders **export**");
    expect(r.root.map((x) => x.name)).toEqual(["src", "README.md"]);
    expect(r.ref).toEqual({ name: "main", kind: "branch", commit: C1 });
    expect(r.branches).toEqual({ count: 2, default: "main" });
    expect(r.pullRequests.items[0]).toMatchObject({ id: 42, source: "feature/4711", target: "main", by: { isMe: true }, webUrl: `${ORG}/test-project/_git/repo-a/pullrequest/42` });
    expect(r.commits).toHaveLength(3);
    expect(r.pipelines.runs).toEqual([]);
    expect(r.errors.map((e) => e.part)).toEqual(["pipelines"]);
    const again = await browseRepo(s.b(), { project: "test-project", repo: "repo-a" });
    expect(again.cached).toBe(false);
  });

  it("summarises a README by its first prose paragraph", () => {
    expect(readmeSummary("# T\n\n![x](y)\n\n```\ncode\n```\n\nThe __real__ text with `snake_case` and [a link](u).\n")).toBe("The real text with snake_case and a link.");
    expect(readmeSummary("# only a title\n")).toBeNull();
  });
});

describe("line diffs", () => {
  it("finds the edits and numbers the hunk lines", () => {
    expect(edits(splitLines("a\nb\nc\n"), splitLines("a\nx\nc\n"))).toEqual([{ start: 1, end: 2, lines: ["x"] }]);
    const h = hunks("1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n", "1\n2\n3\n4\nfive\n6\n7\n8\n9\n10\neleven\n", 1);
    expect(h).toHaveLength(2);
    expect(h[0]).toMatchObject({ oldStart: 4, oldLines: 3, newStart: 4, newLines: 3 });
    expect(h[1].lines.at(-1)).toEqual({ kind: "add", text: "eleven", old: null, new: 11 });
    expect(hunks("same\n", "same\n")).toEqual([]);
  });
  it("re-applies my change on theirs when the lines do not overlap; neighbouring or same lines overlap", () => {
    const base = "a\nb\nc\nd\ne\n";
    expect(merge3(base, "A\nb\nc\nd\ne\n", "a\nb\nc\nd\nE\n")).toEqual({ overlap: false, merged: "A\nb\nc\nd\nE\n" });
    expect(merge3(base, "a\nB\nc\nd\ne\n", "a\nb\nC\nd\ne\n").overlap).toBe(true);
    expect(merge3(base, "a\nX\nc\nd\ne\n", "a\nY\nc\nd\ne\n").overlap).toBe(true);
  });
  it("parses git blame --porcelain", () => {
    const text = [`${C1} 1 1 2`, "author Noor Visser", "author-mail <noor.visser@example.test>", "author-time 1764000000", "summary First", "filename a.py", "\tline one", `${C1} 2 2`, "\tline two", `${C2} 3 3 1`, "author Test User", "author-mail <test.user@example.test>", "author-time 1764100000", "summary Second", "filename a.py", "\tline three"].join("\n");
    const r = parsePorcelain(text, { id: "", name: "", email: "test.user@example.test" });
    expect(r.lines).toEqual([
      { n: 1, commit: C1 },
      { n: 2, commit: C1 },
      { n: 3, commit: C2 },
    ]);
    expect(r.commits[C2]).toMatchObject({ short: "2222222", message: "Second", by: { isMe: true } });
  });
});

describe("Ctrl+P and code search", () => {
  it("scores file names: exact, prefix, word start, anywhere, fuzzy; clones first", () => {
    expect(nameScore("orders_export.py", "orders_export.py")).toBe(100);
    expect(nameScore("orders_export.py", "orders")).toBe(80);
    expect(nameScore("stg_orders.sql", "orders")).toBe(60);
    expect(nameScore("myorders.sql", "orders")).toBe(40);
    expect(nameScore("orders_export.py", "oexp")).toBe(10);
    expect(nameScore("x.py", "zz")).toBe(0);
    const rows = rankFind(
      [
        { name: "orders.py", path: "/a/orders.py", project: "p", repo: "remote", clone: null },
        { name: "orders.py", path: "/b/orders.py", project: "p", repo: "local", clone: { path: "C:/src/local", branch: "main" } },
      ],
      "orders",
      10,
    );
    expect(rows[0].repo).toBe("local");
  });

  it("finds file names with Code Search", async () => {
    const s = setup([
      {
        method: "POST",
        match: /almsearch\.dev\.azure\.com\/ferron-test\/_apis\/search\/codesearchresults/,
        respond: (c) => {
          expect(c.body.searchText).toBe("file:*orders_exp*");
          return { body: { count: 1, results: [{ fileName: "orders_export.py", path: "/src/export/orders_export.py", project: { name: "test-project" }, repository: { name: "repo-a" } }] } };
        },
      },
    ]);
    const r = await browseFind(s.b(), { query: "orders_exp" });
    expect(r.route).toBe("codeSearch");
    expect(r.results).toEqual([{ name: "orders_export.py", path: "/src/export/orders_export.py", project: "test-project", repo: "repo-a", clone: null }]);
  });

  it("without Code Search, Ctrl+P searches the kept trees of the recent and favourite repositories", async () => {
    const s = setup([
      { method: "POST", match: /codesearchresults/, respond: () => ({ status: 404, body: { message: "Code Search is not installed" } }) },
      { match: /repo-a\/refs\?filter=heads%2Fmain/, respond: () => ({ body: { value: [{ name: "refs/heads/main", objectId: C1 }] } }) },
      { match: /repo-a\/items\?scopePath=%2F&recursionLevel=Full/, respond: () => ({ body: { value: [item("/", "tree"), item("/src/orders_export.py", "blob"), item("/README.md", "blob")] } }) },
    ]);
    rememberRepo(s.b(), "test-project", "repo-a");
    const r = await browseFind(s.b(), { query: "orders" });
    expect(r.route).toBe("treeCache");
    expect(r.results.map((x) => x.path)).toEqual(["/src/orders_export.py"]);
    expect(r.searched.repos).toBe(1);
    expect(r.searched.notSearched.map((x) => `${x.repo}:${x.reason}`)).toContain("agile-repo:never opened");
  });

  it("turns Code Search offsets into lines with ranges", () => {
    const content = "a = 1\nMAX_RETRIES = 3\nretry(MAX_RETRIES)\n";
    expect(linesOf(content, [{ charOffset: 6, length: 11 }, { charOffset: 28, length: 11 }])).toEqual([
      { line: 2, text: "MAX_RETRIES = 3", ranges: [[0, 11]] },
      { line: 3, text: "retry(MAX_RETRIES)", ranges: [[6, 17]] },
    ]);
  });

  it("searches code with filters and reads the matching lines at the indexed commit", async () => {
    const s = setup([
      {
        method: "POST",
        match: /codesearchresults/,
        respond: (c) => {
          expect(c.body.searchText).toBe("MAX_RETRIES (ext:py OR ext:sql)");
          expect(c.body.filters).toEqual({ Project: ["test-project"], Repository: ["repo-a"], Path: ["/src"] });
          return { body: { count: 3, results: [{ fileName: "x.py", path: "/src/x.py", project: { name: "test-project" }, repository: { name: "repo-a" }, versions: [{ branchName: "main", changeId: C1 }], matches: { content: [{ charOffset: 0, length: 11 }] } }] } };
        },
      },
      { match: new RegExp(`items\\?path=%2Fsrc%2Fx\\.py.*version=${C1}`), respond: () => ({ body: { ...item("/src/x.py", "blob"), content: "MAX_RETRIES = 3\n" } }) },
    ]);
    const r = await browseSearch(s.b(), { text: "MAX_RETRIES", project: "test-project", repo: "repo-a", path: "src", ext: ["py", ".sql"] });
    expect(r.count).toBe(3);
    expect(r.results[0]).toMatchObject({ repo: "repo-a", branch: "main", commit: C1, matches: [{ line: 1, text: "MAX_RETRIES = 3", ranges: [[0, 11]] }] });
    expect(r.notSearched[0].what).toBe("2 more file(s)");
  });

  it("names a missing Code Search searchUnavailable", async () => {
    const s = setup([{ method: "POST", match: /codesearchresults/, respond: () => ({ status: 404, body: { message: "not found" } }) }]);
    await expect(browseSearch(s.b(), { text: "x" })).rejects.toMatchObject({ kind: "searchUnavailable" });
  });
});

describe("push without a clone", () => {
  const BASE = "line 1\nline 2\nline 3\nline 4\nline 5\n";
  function pushSetup(o: { head?: string; headContent?: string; exists?: boolean } = {}) {
    const head = o.head ?? C1;
    const pushes: any[] = [];
    const prs: any[] = [];
    const s = setup([
      { match: /repo-a\?api-version/, respond: () => ({ body: { id: "r1", defaultBranch: "refs/heads/main" } }) },
      { match: /refs\?filter=heads%2Ffeature%2F4711-fix/, respond: () => ({ body: { value: o.exists ? [{ name: "refs/heads/feature/4711-fix", objectId: C3 }] : [] } }) },
      { match: /refs\?filter=heads%2Fmain/, respond: () => ({ body: { value: [{ name: "refs/heads/main", objectId: head }] } }) },
      { match: /items\?path=%2F\.agents/, respond: () => ({ status: 404, body: { message: "not found" } }) },
      { match: /items\?path=%2F\.azuredevops%2Fpull_request_template\.md/, respond: () => ({ body: { ...item("/.azuredevops/pull_request_template.md", "blob"), content: "## Story\n\n## Changes\n\n## Tests\n" } }) },
      { match: /items\?path=%2F(\.azuredevops|\.vsts|docs|pull_request)/, respond: () => ({ status: 404, body: { message: "not found" } }) },
      { match: new RegExp(`items\\?path=%2Fsrc%2Fa\\.py.*version=${C1}`), respond: () => ({ body: { ...item("/src/a.py", "blob", C1, { objectId: "blob-base" }), content: BASE } }) },
      { match: new RegExp(`items\\?path=%2Fsrc%2Fa\\.py.*version=${C2}`), respond: () => ({ body: { ...item("/src/a.py", "blob", C2, { objectId: "blob-new" }), content: o.headContent ?? BASE } }) },
      { match: /commits\?/, respond: () => ({ body: { value: [{ commitId: C2, comment: "Their change", author: author("Tom Bakker", "2026-11-26T12:00:00Z") }] } }) },
      { match: /wit\/workitems\/4711/, respond: () => ({ body: { fields: { "System.Title": "Orderexport" } } }) },
      { method: "POST", match: /repo-a\/pushes/, respond: (c) => (pushes.push(c.body), { status: 201, body: { commits: [{ commitId: C3 }] } }) },
      { method: "POST", match: /repo-a\/pullrequests/, respond: (c) => (prs.push(c.body), { status: 201, body: { pullRequestId: 77, title: c.body.title } }) },
    ]);
    return { ...s, pushes, prs };
  }
  const input = (o: object = {}) => ({ project: "test-project", repo: "repo-a", path: "/src/a.py", baseCommit: C1, baseBranch: "main", content: BASE.replace("line 1", "LINE 1"), branch: "feature/4711-fix", message: "Fix the first line", ...o });

  it("refuses main, staging, master, develop and the default branch", async () => {
    for (const branch of ["main", "staging", "Master", "develop"]) await expect(browsePush(pushSetup().b(), input({ branch }))).rejects.toMatchObject({ kind: "protectedBranch" });
    expect(isProtected("release/1.2", { branches: { protected: ["release/*"] } })).toBe(true);
    expect(isProtected("feature/x", {})).toBe(false);
  });

  it("refuses a branch that exists", async () => {
    await expect(browsePush(pushSetup({ exists: true }).b(), input())).rejects.toMatchObject({ kind: "branchExists" });
  });

  it("pushes one commit on a new branch from the base commit and opens a pull request with the template and the story", async () => {
    const s = pushSetup();
    const r = await browsePush(s.b(), input({ pr: true, story: 4711 }));
    expect(r).toMatchObject({ status: "pushed", branch: "feature/4711-fix", startedFrom: C1, rebased: false, pr: { id: 77, title: "4711 Orderexport" }, prError: null });
    expect(s.pushes[0]).toEqual({
      refUpdates: [{ name: "refs/heads/feature/4711-fix", oldObjectId: "0".repeat(40) }],
      commits: [{ comment: "Fix the first line", parents: [C1], changes: [{ changeType: "edit", item: { path: "/src/a.py" }, newContent: { content: BASE.replace("line 1", "LINE 1"), contentType: "rawtext" } }] }],
    });
    expect(s.prs[0]).toMatchObject({ sourceRefName: "refs/heads/feature/4711-fix", targetRefName: "refs/heads/main", workItemRefs: [{ id: "4711" }] });
    expect(s.prs[0].description).toContain("AB#4711");
    expect(s.prs[0].description).toContain("## Changes");
  });

  it("gives a conflict when the file changed on the base branch; nothing is pushed", async () => {
    const s = pushSetup({ head: C2, headContent: BASE.replace("line 1", "line one") });
    const r = await browsePush(s.b(), input());
    expect(r).toMatchObject({ status: "conflict", overlap: true, latest: { id: C2, message: "Their change", by: { name: "Tom Bakker" } } });
    expect(s.pushes).toEqual([]);
  });

  it("rebase re-applies a change that does not overlap on the newest version", async () => {
    const s = pushSetup({ head: C2, headContent: BASE.replace("line 5", "line five") });
    const noRebase = await browsePush(s.b(), input());
    expect(noRebase).toMatchObject({ status: "conflict", overlap: false });
    const r = await browsePush(s.b(), input({ rebase: true }));
    expect(r).toMatchObject({ status: "pushed", rebased: true, startedFrom: C2 });
    expect(s.pushes[0].commits[0].changes[0].newContent.content).toBe("LINE 1\nline 2\nline 3\nline 4\nline five\n");
  });

  it("suggests a branch from the story and the file", () => {
    expect(suggestBranch(4711, "/src/export/orders_export.py")).toBe("feature/4711-orders-export");
    expect(suggestBranch(undefined, "/README.md", "Fix typo in README")).toBe("feature/fix-typo-in-readme");
  });
});

describe("aihub browse (the command)", () => {
  it("prints JSON, and a failure as {error:{kind,message}} with exit 1", async () => {
    const s = setup();
    expect(await main(["browse", "projects"], s.ctx)).toBe(0);
    expect(JSON.parse(s.lines[0]).projects).toHaveLength(2);
    expect(await main(["browse", "items", "--project", "test-project"], s.ctx)).toBe(1);
    expect(JSON.parse(s.lines[1])).toEqual({ error: { kind: "badInput", message: "aihub browse needs --repo (aihub browse --help)" } });
    expect(await main(["browse", "suggest-branch", "--story", "12", "--path", "/a/b_c.sql"], s.ctx)).toBe(0);
    expect(JSON.parse(s.lines[2])).toEqual({ branch: "feature/12-b-c" });
  });
});
