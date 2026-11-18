import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, type Route } from "./helpers.js";

const NL = String.fromCharCode(10);
const GUID = "11111111-2222-3333-4444-555555555555";

function base(extra: Route[] = [], status = "active"): Route[] {
  return [
    { match: /_apis\/git\/repositories\/test-repo\?/, respond: () => ({ body: { id: "repo-guid", project: { id: "proj-guid" } } }) },
    { match: /pullrequests\/7\?/, respond: () => ({ body: { pullRequestId: 7, status } }) },
    ...extra,
  ];
}

describe("aihub pr administration", () => {
  it("abandons and reactivates, is idempotent and refuses a completed PR", async () => {
    const { dir } = makeRepo();
    const patched: any[] = [];
    const patch: Route = { method: "PATCH", match: /pullrequests\/7\?/, respond: (c) => (patched.push(c.body), { body: {} }) };
    const a = ctxFor(dir, fakeFetch(base([patch])).fn);
    expect(await main(["pr", "abandon", "--pr", "7"], a.ctx)).toBe(0);
    expect(patched[0]).toEqual({ status: "abandoned" });
    expect(a.lines.join(NL)).toContain("PR !7: abandoned");
    const b = ctxFor(dir, fakeFetch(base([patch], "abandoned")).fn);
    expect(await main(["pr", "abandon", "--pr", "7"], b.ctx)).toBe(0);
    expect(b.lines.join(NL)).toContain("already abandoned");
    expect(patched.length).toBe(1);
    expect(await main(["pr", "reactivate", "--pr", "7"], ctxFor(dir, fakeFetch(base([patch], "abandoned")).fn).ctx)).toBe(0);
    expect(patched[1]).toEqual({ status: "active" });
    const c = ctxFor(dir, fakeFetch(base([patch], "completed")).fn);
    expect(await main(["pr", "abandon", "--pr", "7"], c.ctx)).toBe(1);
    expect(c.errs.join(NL)).toContain("completed");
  });

  it("publishes, turns into a draft, and cancels auto-complete; --dry-run patches nothing", async () => {
    const { dir } = makeRepo();
    const patched: any[] = [];
    const patch: Route = { method: "PATCH", match: /pullrequests\/7\?/, respond: (c) => (patched.push(c.body), { body: {} }) };
    expect(await main(["pr", "publish", "--pr", "7"], ctxFor(dir, fakeFetch(base([patch])).fn).ctx)).toBe(0);
    expect(await main(["pr", "draft", "--pr", "7"], ctxFor(dir, fakeFetch(base([patch])).fn).ctx)).toBe(0);
    expect(await main(["pr", "autocomplete", "--pr", "7", "--cancel"], ctxFor(dir, fakeFetch(base([patch])).fn).ctx)).toBe(0);
    expect(patched).toEqual([{ isDraft: false }, { isDraft: true }, { autoCompleteSetBy: { id: "00000000-0000-0000-0000-000000000000" } }]);
    patched.length = 0;
    const d = ctxFor(dir, fakeFetch(base([patch])).fn);
    expect(await main(["pr", "publish", "--pr", "7", "--dry-run"], d.ctx)).toBe(0);
    expect(patched).toEqual([]);
    expect(d.lines.join(NL)).toContain("would PATCH");
  });

  it("lists, adds and removes reviewers and votes with your own id", async () => {
    const { dir } = makeRepo();
    const puts: any[] = [];
    const dels: string[] = [];
    const r = base([
      { match: /pullrequests\/7\/reviewers\?/, respond: () => ({ body: { value: [{ id: GUID, displayName: "Ann", vote: 10, isRequired: true }, { id: "b", displayName: "Bob", vote: -5 }] } }) },
      { method: "PUT", match: /pullrequests\/7\/reviewers\/[^?]+\?/, respond: (c) => (puts.push([c.url.replace(/.*reviewers\//, "").split("?")[0], c.body]), { body: {} }) },
      { method: "DELETE", match: /pullrequests\/7\/reviewers\/[^?]+\?/, respond: (c) => (dels.push(c.url.replace(/.*reviewers\//, "").split("?")[0]), { body: {} }) },
      { match: /_apis\/connectionData\?/, respond: () => ({ body: { authenticatedUser: { id: "me-guid" } } }) },
    ]);
    const l = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["pr", "reviewers", "list", "--pr", "7"], l.ctx)).toBe(0);
    expect(l.lines.join(NL)).toMatch(/Ann\s+approve\s+required/);
    expect(l.lines.join(NL)).toMatch(/Bob\s+wait/);
    expect(await main(["pr", "reviewers", "add", "--pr", "7", "--reviewers", GUID, "--required"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(puts[0]).toEqual([GUID, { vote: 0, isRequired: true }]);
    expect(await main(["pr", "reviewers", "remove", "--pr", "7", "--reviewers", GUID], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(dels).toEqual([GUID]);
    expect(await main(["pr", "vote", "--pr", "7", "--vote", "approve-with-suggestions"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(puts[1]).toEqual(["me-guid", { vote: 5 }]);
    const bad = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["pr", "vote", "--pr", "7", "--vote", "love"], bad.ctx)).toBe(1);
  });

  it("manages labels and statuses", async () => {
    const { dir } = makeRepo();
    const posted: any[] = [];
    const dels: string[] = [];
    const r = base([
      { match: /pullrequests\/7\/labels\?/, respond: () => ({ body: { value: [{ id: "1", name: "hotfix" }] } }) },
      { method: "POST", match: /pullrequests\/7\/labels\?/, respond: (c) => (posted.push(c.body), { body: {} }) },
      { method: "DELETE", match: /pullrequests\/7\/labels\/[^?]+\?/, respond: (c) => (dels.push(c.url.replace(/.*labels\//, "").split("?")[0]), { body: {} }) },
      { match: /pullrequests\/7\/statuses\?/, respond: () => ({ body: { value: [{ state: "failed", context: { name: "lint", genre: "ci" }, description: "2 errors" }] } }) },
      { method: "POST", match: /pullrequests\/7\/statuses\?/, respond: (c) => (posted.push(c.body), { body: {} }) },
    ]);
    const l = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["pr", "labels", "list", "--pr", "7"], l.ctx)).toBe(0);
    expect(l.lines.join(NL)).toBe("hotfix");
    expect(await main(["pr", "labels", "add", "--pr", "7", "--labels", "a,b"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(await main(["pr", "labels", "remove", "--pr", "7", "--labels", "a b"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(posted.slice(0, 2)).toEqual([{ name: "a" }, { name: "b" }]);
    expect(dels).toEqual(["a%20b"]);
    const s = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["pr", "status", "list", "--pr", "7"], s.ctx)).toBe(0);
    expect(s.lines.join(NL)).toContain("failed     ci/lint 2 errors");
    expect(await main(["pr", "status", "post", "--pr", "7", "--state", "succeeded", "--name", "lint", "--genre", "ci"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(posted[2]).toMatchObject({ state: "succeeded", context: { name: "lint", genre: "ci" } });
  });

  it("links and unlinks a work item and lists iterations", async () => {
    const { dir } = makeRepo();
    const patches: any[] = [];
    const art = "vstfs:///Git/PullRequestId/proj-guid%2Frepo-guid%2F7";
    const r = base([
      { match: /pullrequests\/7\/workitems\?/, respond: () => ({ body: { value: [{ id: "12" }] } }) },
      { match: /wit\/workitems\/12\?.*expand/i, respond: () => ({ body: { relations: [{ rel: "Hyperlink", url: "http://x" }, { rel: "ArtifactLink", url: art }] } }) },
      { match: /wit\/workitems\/12\?.*fields/, respond: () => ({ body: { fields: { "System.Title": "Export totals", "System.State": "Active" } } }) },
      { method: "PATCH", match: /wit\/workitems\/12\?/, respond: (c) => (patches.push(c.body), { body: {} }) },
      { match: /pullrequests\/7\/iterations\?/, respond: () => ({ body: { value: [{ id: 1, createdDate: "2026-11-10T10:00:00Z", sourceRefCommit: { commitId: "abcdef123456" }, description: "first push" }] } }) },
    ]);
    const l = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["pr", "workitems", "list", "--pr", "7"], l.ctx)).toBe(0);
    expect(l.lines.join(NL)).toContain("AB#12 Active Export totals");
    expect(await main(["pr", "workitems", "add", "--pr", "7", "--work-item", "AB#12"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(patches[0]).toEqual([{ op: "add", path: "/relations/-", value: { rel: "ArtifactLink", url: art, attributes: { name: "Pull Request" } } }]);
    expect(await main(["pr", "workitems", "remove", "--pr", "7", "--work-item", "12"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(patches[1]).toEqual([{ op: "remove", path: "/relations/1" }]);
    const it = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["pr", "iterations", "--pr", "7"], it.ctx)).toBe(0);
    expect(it.lines.join(NL)).toMatch(/1\s+2026-11-10\s+abcdef12\s+first push/);
  });

  it("without --pr it uses the active PR of the checked-out branch", async () => {
    const { dir } = makeRepo();
    const r = base([{ match: /pullrequests\?.*searchCriteria/, respond: () => ({ body: { value: [{ pullRequestId: 7, title: "t", status: "active", sourceRefName: "refs/heads/main", targetRefName: "refs/heads/x" }] } }) }, { match: /pullrequests\/7\/labels\?/, respond: () => ({ body: { value: [] } }) }]);
    const { ctx, lines } = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["pr", "labels", "list"], ctx)).toBe(0);
    expect(lines.join(NL)).toContain("PR !7 has no labels");
  });
});
