import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, type Route } from "./helpers.js";

const TYPES = [
  { id: "t-min", displayName: "Minimum number of reviewers" },
  { id: "t-build", displayName: "Build" },
  { id: "t-wi", displayName: "Work item linking" },
  { id: "t-cmt", displayName: "Comment requirements" },
  { id: "t-req", displayName: "Required reviewers" },
  { id: "t-merge", displayName: "Require a merge strategy" },
  { id: "t-status", displayName: "Status" },
];
const cfg = (id: number, type: string, settings: object, extra: object = {}) => ({
  id,
  isEnabled: true,
  isBlocking: true,
  type: { id: `t-${id}`, displayName: type },
  settings: { scope: [{ repositoryId: "repo-guid", refName: "refs/heads/main", matchKind: "Exact" }], ...settings },
  ...extra,
});

function routes(extra: Route[] = []): Route[] {
  return [
    { match: /_apis\/git\/repositories\/test-repo\?/, respond: () => ({ body: { id: "repo-guid" } }) },
    { match: /_apis\/policy\/types\?/, respond: () => ({ body: { value: TYPES } }) },
    ...extra,
  ];
}

describe("aihub policy", () => {
  it("lists policies in one readable line each and filters by type", async () => {
    const { dir } = makeRepo();
    const list = [
      cfg(1, "Minimum number of reviewers", { minimumApproverCount: 2, creatorVoteCounts: false, resetOnSourcePush: true }),
      cfg(2, "Build", { buildDefinitionId: 7, displayName: "ci", manualQueueOnly: false, validDuration: 720 }),
      cfg(3, "Require a merge strategy", { allowSquash: true }),
    ];
    const { fn, calls } = fakeFetch(routes([{ match: /_apis\/policy\/configurations\?/, respond: () => ({ body: { value: list } }) }]));
    const { ctx, lines } = ctxFor(dir, fn);
    expect(await main(["policy", "list"], ctx)).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("#1 Minimum number of reviewers (2 reviewer(s); creator vote does not count; votes reset on push) [on, blocking] main");
    expect(out).toContain("#2 Build (definition 7; ci; automatic; valid 720 min)");
    expect(out).toContain("#3 Require a merge strategy (squash)");
    expect(calls.find((c) => c.url.includes("policy/configurations"))!.url).toContain("repositoryId=repo-guid");
    lines.length = 0;
    expect(await main(["policy", "list", "--branch", "release/1", "--json"], ctx)).toBe(0);
    expect(JSON.parse(lines.join(String.fromCharCode(10)))).toEqual([]); // the three policies are scoped to main
    lines.length = 0;
    expect(await main(["policy", "list", "--type", "build", "--json"], ctx)).toBe(0);
    expect(JSON.parse(lines.join("\n")).map((p: any) => p.id)).toEqual([2]);
  });

  it("creates a min-reviewers policy with the type looked up by name, and a dry-run writes nothing", async () => {
    const { dir } = makeRepo();
    const posted: any[] = [];
    const r = routes([{ method: "POST", match: /_apis\/policy\/configurations\?/, respond: (c) => (posted.push(c.body), { body: cfg(9, "Minimum number of reviewers", c.body.settings) }) }]);
    const { fn } = fakeFetch(r);
    const { ctx, lines } = ctxFor(dir, fn);
    expect(await main(["policy", "create", "--type", "min-reviewers", "--branch", "main", "--count", "2", "--reset-on-push", "true"], ctx)).toBe(0);
    expect(posted[0]).toMatchObject({ isEnabled: true, isBlocking: true, type: { id: "t-min" }, settings: { minimumApproverCount: 2, resetOnSourcePush: true, scope: [{ repositoryId: "repo-guid", refName: "refs/heads/main", matchKind: "Exact" }] } });
    expect(lines.join("\n")).toContain("created: #9 Minimum number of reviewers");

    posted.length = 0;
    const dry = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["policy", "create", "--type", "min-reviewers", "--default-branch", "--dry-run"], dry.ctx)).toBe(0);
    expect(posted).toEqual([]);
    expect(dry.lines.join("\n")).toContain("dry-run: would POST");
  });

  it("resolves a build policy by pipeline name and refuses a build policy without one", async () => {
    const { dir } = makeRepo();
    const posted: any[] = [];
    const r = routes([
      { match: /_apis\/build\/definitions\?/, respond: () => ({ body: { value: [{ id: 42, name: "ci" }] } }) },
      { method: "POST", match: /_apis\/policy\/configurations\?/, respond: (c) => (posted.push(c.body), { body: cfg(5, "Build", c.body.settings) }) },
    ]);
    const { ctx } = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["policy", "create", "--type", "build", "--branch-prefix", "release", "--pipeline", "ci", "--path", "src/*,docs/*"], ctx)).toBe(0);
    expect(posted[0].settings).toMatchObject({ buildDefinitionId: 42, filenamePatterns: ["src/*", "docs/*"], scope: [{ refName: "refs/heads/release", matchKind: "Prefix" }] });
    const bad = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["policy", "create", "--type", "build", "--branch", "main"], bad.ctx)).toBe(1);
    expect(bad.errs.join("\n")).toContain("needs --definition");
  });

  it("updates one setting and keeps the rest, disables with --disable", async () => {
    const { dir } = makeRepo();
    const put: any[] = [];
    const cur = cfg(1, "Minimum number of reviewers", { minimumApproverCount: 1, creatorVoteCounts: true });
    const r = routes([
      { match: /_apis\/policy\/configurations\/1\?/, respond: () => ({ body: cur }) },
      { method: "PUT", match: /_apis\/policy\/configurations\/1\?/, respond: (c) => (put.push(c.body), { body: c.body }) },
    ]);
    const { ctx } = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["policy", "update", "--id", "1", "--count", "3", "--disable"], ctx)).toBe(0);
    expect(put[0]).toMatchObject({ isEnabled: false, settings: { minimumApproverCount: 3, creatorVoteCounts: true, scope: [{ refName: "refs/heads/main" }] } });
  });

  it("deletes only with --yes", async () => {
    const { dir } = makeRepo();
    let deleted = 0;
    const r = routes([{ method: "DELETE", match: /_apis\/policy\/configurations\/4\?/, respond: () => (deleted++, { body: {} }) }]);
    const a = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["policy", "delete", "--id", "4"], a.ctx)).toBe(1);
    expect(a.errs.join("\n")).toContain("needs --yes");
    expect(deleted).toBe(0);
    const b = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["policy", "delete", "--id", "4", "--yes"], b.ctx)).toBe(0);
    expect(deleted).toBe(1);
  });

  it("lists the types with the short name to use", async () => {
    const { dir } = makeRepo();
    const { ctx, lines } = ctxFor(dir, fakeFetch(routes()).fn);
    expect(await main(["policy", "types"], ctx)).toBe(0);
    expect(lines.join("\n")).toMatch(/min-reviewers\s+Minimum number of reviewers\s+t-min/);
  });
});
