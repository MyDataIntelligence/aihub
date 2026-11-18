import { describe, expect, it } from "vitest";
import { renderHandoff, renderStandup, sinceFrom, type Activity } from "../src/lib/standup.js";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, sh, write, type Route } from "./helpers.js";

const ME = { id: "me-guid", name: "Test User" };
const NOW = Date.parse("2026-11-18T09:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const REPO = { id: "repo-1", name: "test-repo" };
const pr = (id: number, extra: object = {}) => ({ pullRequestId: id, title: `Title ${id}`, status: "active", createdBy: { id: ME.id }, repository: REPO, sourceRefName: `refs/heads/feature/${id}-x`, reviewers: [], ...extra });

function routes(): Route[] {
  return [
    { match: /_apis\/connectionData\?/, respond: () => ({ body: { authenticatedUser: { id: ME.id, customDisplayName: ME.name } } }) },
    { match: /\/repositories\/test-repo\/commits\?/, respond: () => ({ body: { value: [{}, {}, {}] } }) },
    {
      match: /\/repositories\/repo-1\/commits\?/,
      respond: (c) => ({ body: { value: c.url.includes("feature%2F7-x") || c.url.includes("feature/7-x") ? [{}] : [] } }),
    },
    {
      match: /\/git\/pullrequests\?/,
      respond: (c) => {
        if (c.url.includes("reviewerId")) return { body: { value: [pr(20, { createdBy: { id: "anna" }, title: "Anna's PR" })] } };
        if (c.url.includes("status=active")) return { body: { value: [pr(7, { creationDate: hoursAgo(100), reviewers: [{ displayName: "Anna", vote: 10 }], isDraft: false })] } };
        return { body: { value: [pr(12, { creationDate: hoursAgo(5) }), pr(9, { status: "completed", closedDate: hoursAgo(3), creationDate: hoursAgo(90) }), pr(7, { creationDate: hoursAgo(100) })] } };
      },
    },
    {
      match: /pullRequests\/20\/threads/i,
      respond: () => ({ body: { value: [{ id: 1, comments: [{ author: { id: ME.id }, publishedDate: hoursAgo(2) }, { author: { id: ME.id }, publishedDate: hoursAgo(1) }, { author: { id: "anna" }, publishedDate: hoursAgo(1) }, { author: { id: ME.id }, publishedDate: hoursAgo(80) }] }] } }),
    },
    { match: /pullRequests\/7\/threads/i, respond: () => ({ body: { value: [{ id: 1, status: "active", comments: [{ commentType: "text" }] }, { id: 2, status: "closed", comments: [{ commentType: "text" }] }] } }) },
    {
      match: /build\/builds\?/,
      respond: (c) => (c.url.includes("resultFilter=failed") ? { body: { value: [{ id: 33, sourceBranch: "refs/heads/feature/7-x", definition: { name: "ci" } }, { id: 30, sourceBranch: "refs/heads/feature/7-x" }] } } : c.url.includes("refs%2Fpull") ? { body: { value: [{ status: "completed", result: "failed" }] } } : { body: { value: [{ result: "succeeded" }, { result: "succeeded" }, { result: "failed" }, { status: "inProgress" }] } }),
    },
    { method: "POST", match: /\/wit\/wiql\?/, respond: () => ({ body: { workItems: [{ id: 44 }] } }) },
    { match: /\/wit\/workItems\/44\/updates/, respond: () => ({ body: { value: [{ revisedDate: hoursAgo(10), fields: { "System.State": { oldValue: "New", newValue: "Active" } } }, { revisedDate: hoursAgo(300), fields: { "System.State": { oldValue: "x", newValue: "New" } } }] } }) },
    { match: /\/wit\/workitems\/44\?/i, respond: () => ({ body: { id: 44, fields: { "System.Title": "Zoekfunctie", "System.State": "Active" } } }) },
  ];
}

function setup(team = "") {
  const { dir } = makeRepo();
  if (team) write(dir, ".agents/skills/_shared/references/team.yaml", team);
  const f = fakeFetch(routes());
  const c = ctxFor(dir, f.fn);
  c.ctx.now = () => NOW;
  return { dir, ...c, calls: f.calls };
}

describe("aihub standup", () => {
  it("3-5 lines from commits, PRs, reviews, builds and story changes; every call is a read", async () => {
    const s = setup();
    expect(await main(["standup", "--since", "72h"], s.ctx)).toBe(0);
    expect(s.errs).toEqual([]);
    const lines = s.lines.join("\n").split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(lines[0]).toBe("Commits: 3 (1 repository: test-repo 3)");
    expect(lines[1]).toBe("PRs: 1 created (!12 Title 12); 1 merged (!9 Title 9); 1 updated (!7 Title 7)");
    expect(lines[2]).toBe("Reviews: on !20 (2 comments)");
    expect(lines[3]).toBe("Runs: 4 builds (2 succeeded, 1 failed, 1 other)");
    expect(lines[4]).toBe("Stories: AB#44 Zoekfunctie New -> Active");
    expect(s.calls.filter((c) => c.method !== "GET" && !/wiql/.test(c.url))).toEqual([]);
  });

  it("speaks the team language (nl) and has a --json form", async () => {
    const s = setup("language: nl\n");
    expect(await main(["standup", "--since", "72h"], s.ctx)).toBe(0);
    expect(s.lines.join("\n")).toContain("PR's: 1 aangemaakt (!12 Title 12); 1 gemerged");
    s.lines.length = 0;
    expect(await main(["standup", "--since", "72h", "--json"], s.ctx)).toBe(0);
    const j = JSON.parse(s.lines[0]);
    expect(j.prs.created[0].id).toBe(12);
    expect(j.builds).toEqual({ total: 4, succeeded: 2, failed: 1, other: 1 });
  });

  it("says so when nothing happened", () => {
    const empty: Activity = { me: "x", since: "2026-11-17T00:00:00.000Z", commits: [], prs: { created: [], merged: [], updated: [] }, reviews: [], builds: { total: 0, succeeded: 0, failed: 0, other: 0 }, stories: [] };
    expect(renderStandup(empty, "en")).toEqual(["Nothing recorded since 2026-11-17 00:00."]);
  });

  it("--since: yesterday skips the weekend on a Monday, durations need a unit", () => {
    const monday = new Date(2026, 10, 16, 9, 0, 0).getTime(); // Monday 16 Nov 2026
    const back = new Date(sinceFrom("yesterday", monday));
    expect([back.getDate(), back.getHours()]).toEqual([13, 0]);
    const wed = new Date(2026, 10, 18, 9, 0, 0).getTime();
    expect(new Date(sinceFrom(undefined, wed)).getDate()).toBe(17);
    expect(new Date(sinceFrom("today", wed)).getDate()).toBe(18);
    expect(sinceFrom("2h", wed)).toBe(wed - 2 * 3_600_000);
    expect(() => sinceFrom("5", wed)).toThrow();
  });
});

describe("aihub handoff", () => {
  it("my open work as markdown: PRs with votes, threads and build, stories, unpushed branches, failing runs", async () => {
    const s = setup();
    sh(s.dir, ["checkout", "-b", "feature/44-search"]);
    write(s.dir, "a.txt", "x");
    sh(s.dir, ["add", "."]);
    sh(s.dir, ["commit", "-m", "wip"]);
    expect(await main(["handoff", "--to", "Anna"], s.ctx)).toBe(0);
    expect(s.errs).toEqual([]);
    const out = s.lines.join("\n");
    expect(out).toContain("# Handoff Test User to Anna (2026-11-18)");
    expect(out).toContain("- !7 Title 7 (test-repo): ready; Anna approved; 1 open threads; build failed");
    expect(out).toContain("- AB#44 Zoekfunctie: Active");
    expect(out).toContain("- feature/44-search: not pushed");
    expect(out).toContain("- build 33 (ci) on feature/7-x");
    expect(out.match(/feature\/7-x/g)).toHaveLength(1); // one failing run per branch
    expect(s.calls.filter((c) => c.method !== "GET" && !/wiql/.test(c.url))).toEqual([]);
  });

  it("--clipboard copies the note (injected clipboard), --json adds the markdown", async () => {
    const s = setup();
    let copied = "";
    const { handoff } = await import("../src/lib/standup.js");
    const out = await handoff(s.ctx, { clipboard: true }, (t) => ((copied = t), true));
    expect(copied).toContain("## Open PRs");
    expect(out).toContain("(copied to the clipboard)");
    const j = JSON.parse(await handoff(s.ctx, { json: true }));
    expect(j.markdown).toContain("# Handoff Test User");
    expect(j.prs[0].pr.id).toBe(7);
  });

  it("nl text and an empty hand-over", () => {
    const h = { me: "Ik", date: "2026-11-18", prs: [], stories: [], branches: [], watches: [{ id: "mine", what: "mine" }], failing: [] };
    expect(renderHandoff(h, "nl")).toContain("alles van mij (PR's, vermeldingen, reviews)");
    expect(renderHandoff({ ...h, watches: [] }, "nl")).toContain("Niets open.");
    expect(renderHandoff({ ...h, watches: [] }, "en", "Bo")).toBe("# Handoff Ik to Bo (2026-11-18)\n\nNothing open.\n");
  });
});
