import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, type Route } from "./helpers.js";

const NL = String.fromCharCode(10);
const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);
const repoBody = { id: "repo-guid", name: "test-repo", defaultBranch: "refs/heads/main", size: 2048, webUrl: "https://dev.azure.com/o/p/_git/test-repo", project: { id: "proj-guid" } };

function base(extra: Route[] = []): Route[] {
  return [{ match: /_apis\/git\/repositories\/test-repo\?/, respond: () => ({ body: repoBody }) }, ...extra];
}

describe("aihub repo", () => {
  it("shows the repository and lists branches with lock state and ahead/behind", async () => {
    const { dir } = makeRepo();
    const r = base([
      { match: /repositories\/test-repo\/refs\?/, respond: () => ({ body: { value: [{ name: "refs/heads/main", objectId: SHA }, { name: "refs/heads/feat/x", objectId: SHA2, isLocked: true }] } }) },
      { match: /repositories\/test-repo\/stats\/branches\?/, respond: () => ({ body: { value: [{ name: "feat/x", aheadCount: 2, behindCount: 1 }] } }) },
    ]);
    const { ctx, lines } = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["repo", "show"], ctx)).toBe(0);
    expect(lines.join(NL)).toContain("default branch main, 2 KB");
    lines.length = 0;
    expect(await main(["repo", "branch", "list", "--stats"], ctx)).toBe(0);
    expect(lines.join(NL)).toMatch(/feat\/x\s+bbbbbbbb\s+locked\s+2\/1/);
  });

  it("creates a branch from the default branch, refuses an existing one, and a dry-run writes nothing", async () => {
    const { dir } = makeRepo();
    const posted: any[] = [];
    let existing = false;
    const r = base([
      { match: /repositories\/test-repo\/refs\?/, respond: (c) => ({ body: { value: new URL(c.url).searchParams.get("filter") === "heads/feat/new" ? (existing ? [{ name: "refs/heads/feat/new", objectId: SHA }] : []) : [{ name: "refs/heads/main", objectId: SHA }] } }) },
      { method: "POST", match: /repositories\/test-repo\/refs\?/, respond: (c) => (posted.push(c.body), { body: { value: [{ success: true }] } }) },
    ]);
    const a = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["repo", "branch", "create", "--name", "feat/new"], a.ctx)).toBe(0);
    expect(posted[0]).toEqual([{ name: "refs/heads/feat/new", oldObjectId: "0".repeat(40), newObjectId: SHA }]);
    posted.length = 0;
    const d = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["repo", "branch", "create", "--name", "feat/new", "--dry-run"], d.ctx)).toBe(0);
    expect(posted).toEqual([]);
    existing = true;
    const e = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["repo", "branch", "create", "--name", "feat/new"], e.ctx)).toBe(1);
    expect(e.errs.join(NL)).toContain("already exists");
  });

  it("deletes a branch only with --yes and never the default branch", async () => {
    const { dir } = makeRepo();
    const posted: any[] = [];
    const r = base([
      { match: /repositories\/test-repo\/refs\?/, respond: () => ({ body: { value: [{ name: "refs/heads/feat/old", objectId: SHA2 }, { name: "refs/heads/main", objectId: SHA }] } }) },
      { method: "POST", match: /repositories\/test-repo\/refs\?/, respond: (c) => (posted.push(c.body), { body: { value: [{ success: true }] } }) },
    ]);
    expect(await main(["repo", "branch", "delete", "--name", "feat/old"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(1);
    expect(posted).toEqual([]);
    expect(await main(["repo", "branch", "delete", "--name", "feat/old", "--yes"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(posted[0]).toEqual([{ name: "refs/heads/feat/old", oldObjectId: SHA2, newObjectId: "0".repeat(40) }]);
    const m = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["repo", "branch", "delete", "--name", "main", "--yes"], m.ctx)).toBe(1);
    expect(m.errs.join(NL)).toContain("default branch");
  });

  it("locks a branch and creates an annotated and a lightweight tag", async () => {
    const { dir } = makeRepo();
    const patched: any[] = [];
    const annotated: any[] = [];
    const refsPosts: any[] = [];
    const r = base([
      { method: "PATCH", match: /repositories\/test-repo\/refs\?/, respond: (c) => (patched.push([c.url, c.body]), { body: {} }) },
      { match: /repositories\/test-repo\/refs\?/, respond: () => ({ body: { value: [{ name: "refs/heads/main", objectId: SHA }] } }) },
      { method: "POST", match: /repositories\/test-repo\/annotatedtags\?/, respond: (c) => (annotated.push(c.body), { body: {} }) },
      { method: "POST", match: /repositories\/test-repo\/refs\?/, respond: (c) => (refsPosts.push(c.body), { body: { value: [{ success: true }] } }) },
    ]);
    expect(await main(["repo", "branch", "lock", "--name", "release/1"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(patched[0][1]).toEqual({ isLocked: true });
    expect(patched[0][0]).toContain("filter=heads%2Frelease%2F1");
    expect(await main(["repo", "tag", "create", "--name", "v1.0", "--message", "first"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(annotated[0]).toEqual({ name: "v1.0", message: "first", taggedObject: { objectId: SHA } });
    expect(await main(["repo", "tag", "create", "--name", "v1.1", "--lightweight"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(refsPosts[0]).toEqual([{ name: "refs/tags/v1.1", oldObjectId: "0".repeat(40), newObjectId: SHA }]);
  });

  it("reads a tree, a file with a line range, commits, a commit with its changes and a diff", async () => {
    const { dir } = makeRepo();
    const r = base([
      { match: /repositories\/test-repo\/items\?.*scopePath/, respond: (c) => (expect(c.url).toContain("versionDescriptor.version=release%2F1"), { body: { value: [{ path: "/src", isFolder: true }, { path: "/src/a.py", size: 5 }, { path: "/README.md" }] } }) },
      { match: /repositories\/test-repo\/items\?.*path=%2Fsrc%2Fa\.py/, respond: () => ({ text: ["l1", "l2", "l3", "l4"].join(NL) }) },
      { match: /repositories\/test-repo\/commits\/abc\/changes\?/, respond: () => ({ body: { changes: [{ changeType: "edit", item: { path: "/src/a.py" } }] } }) },
      { match: /repositories\/test-repo\/commits\/abc\?/, respond: () => ({ body: { commitId: SHA, author: { name: "Ann", date: "2026-11-10T10:00:00Z" }, comment: "Fix a" } }) },
      { match: /repositories\/test-repo\/commits\?/, respond: (c) => (expect(c.url).toContain("searchCriteria.itemPath=src"), { body: { value: [{ commitId: SHA, author: { name: "Ann", date: "2026-11-10T10:00:00Z" }, comment: "Fix a" }] } }) },
      { match: /repositories\/test-repo\/diffs\/commits\?/, respond: () => ({ body: { aheadCount: 1, behindCount: 0, changes: [{ changeType: "add", item: { path: "/b.py" } }] } }) },
    ]);
    const a = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["repo", "tree", "--branch", "release/1"], a.ctx)).toBe(0);
    expect(a.lines.join(NL)).toBe(["d src/", "- src/a.py", "- README.md"].join(NL));
    const f = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["repo", "file", "--path", "src/a.py", "--lines", "2-3"], f.ctx)).toBe(0);
    expect(f.lines.join(NL)).toBe(["l2", "l3"].join(NL));
    const cm = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["repo", "commits", "--path", "src"], cm.ctx)).toBe(0);
    expect(cm.lines.join(NL)).toContain("aaaaaaaa 2026-11-10 Ann Fix a");
    const one = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["repo", "commit", "--id", "abc"], one.ctx)).toBe(0);
    expect(one.lines.join(NL)).toContain("edit   /src/a.py");
    const d = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["repo", "diff", "--base", "main", "--target", "feat/x"], d.ctx)).toBe(0);
    expect(d.lines.join(NL)).toContain("feat/x is 1 ahead and 0 behind main; 1 file change(s)");
  });

  it("lists forks and creates one from this repository (dry-run plan, then the request body)", async () => {
    const { dir } = makeRepo();
    const posted: any[] = [];
    const r = base([
      { match: /_apis\/connectionData\?/, respond: () => ({ body: { instanceId: "coll-guid" } }) },
      { match: /repositories\/repo-guid\/forks\/coll-guid\?/, respond: () => ({ body: { value: [{ name: "test-repo-fork", id: "f1", project: { name: "other" } }] } }) },
      { method: "POST", match: /_apis\/git\/repositories\?/, respond: (c) => (posted.push(c.body), { body: { id: "new-guid", name: c.body.name } }) },
    ]);
    const l = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["repo", "forks", "list"], l.ctx)).toBe(0);
    expect(l.lines.join(NL)).toBe("other/test-repo-fork");
    expect(await main(["repo", "forks", "create", "--name", "my-fork"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(posted[0]).toEqual({ name: "my-fork", parentRepository: { id: "repo-guid", project: { id: "proj-guid" } }, project: { id: "proj-guid" } });
    posted.length = 0;
    expect(await main(["repo", "forks", "create", "--dry-run"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(posted).toEqual([]);
  });

  it("posts a commit status and lists them", async () => {
    const { dir } = makeRepo();
    const posted: any[] = [];
    const r = base([
      { method: "POST", match: /commits\/abc\/statuses\?/, respond: (c) => (posted.push(c.body), { body: {} }) },
      { match: /commits\/abc\/statuses\?/, respond: () => ({ body: { value: [{ state: "succeeded", context: { name: "ci", genre: "aihub" }, description: "green" }] } }) },
    ]);
    expect(await main(["repo", "status", "post", "--sha", "abc", "--state", "succeeded", "--name", "ci"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(posted[0]).toMatchObject({ state: "succeeded", context: { name: "ci", genre: "aihub" } });
    const bad = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["repo", "status", "post", "--sha", "abc", "--state", "ok", "--name", "ci"], bad.ctx)).toBe(1);
    const l = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["repo", "status", "list", "--sha", "abc"], l.ctx)).toBe(0);
    expect(l.lines.join(NL)).toContain("succeeded  aihub/ci green");
  });
});

describe("aihub search", () => {
  it("searches code on the search host, scoped to this repository, and reads only", async () => {
    const { dir } = makeRepo();
    const calls: string[] = [];
    const r: Route[] = [{ method: "POST", match: /almsearch\.dev\.azure\.com\/ferron-org\/test-project\/_apis\/search\/codesearchresults/, respond: (c) => (calls.push(JSON.stringify(c.body.filters)), { body: { count: 1, results: [{ repository: { name: "test-repo" }, path: "/src/a.py", fileName: "a.py", matches: { content: [{ charOffset: 1, length: 3 }] } }] } }) }];
    const { ctx, lines } = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["search", "code", "--text", "totals", "--path", "/src", "--dry-run"], ctx)).toBe(0); // a query is a read: it runs in a dry-run too
    expect(calls[0]).toContain('"Repository":["test-repo"]');
    expect(lines.join(NL)).toContain("test-repo/src/a.py (1 match)");
  });

  it("searches wiki pages and work items", async () => {
    const { dir } = makeRepo();
    const r: Route[] = [
      { method: "POST", match: /wikisearchresults/, respond: () => ({ body: { count: 1, results: [{ wiki: { name: "test-project.wiki" }, path: "/Home", fileName: "Home.md" }] } }) },
      { method: "POST", match: /workitemsearchresults/, respond: () => ({ body: { count: 1, results: [{ fields: { "system.id": "12", "system.workitemtype": "User Story", "system.state": "Active", "system.title": "Export totals" } }] } }) },
    ];
    const w = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["search", "wiki", "--text", "home"], w.ctx)).toBe(0);
    expect(w.lines.join(NL)).toContain("test-project.wiki: /Home");
    const i = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["search", "items", "--text", "totals", "--type", "User Story"], i.ctx)).toBe(0);
    expect(i.lines.join(NL)).toMatch(/12\s+User Story\s+Active\s+Export totals/);
    expect(await main(["search", "code"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(1);
  });
});
