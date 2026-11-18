import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { listEvents } from "../src/lib/open.js";
import { ctxFor, fakeFetch, makeRepo, sh, tmp, write, type Route } from "./helpers.js";

const REPO_A = { id: "repo-a", name: "test-repo", project: { id: "proj-1" } };
const REPO_B = { id: "repo-b", name: "other-repo", project: { id: "proj-1" } };
const prs = [
  {
    pullRequestId: 7,
    title: "7 CSV export",
    status: "active",
    isDraft: false,
    createdBy: { displayName: "Anna", id: "anna" },
    creationDate: "2026-11-18T10:00:00Z",
    sourceRefName: "refs/heads/feature/7-csv",
    targetRefName: "refs/heads/main",
    repository: REPO_A,
    reviewers: [
      { displayName: "Bob", id: "bob", vote: 10, isRequired: true },
      { displayName: "Carl", id: "carl", vote: 0 },
      { displayName: "Dora", id: "dora", vote: -10 },
    ],
  },
  {
    pullRequestId: 9,
    title: "9 Other",
    status: "active",
    createdBy: { displayName: "Eva", id: "eva" },
    creationDate: "2026-11-17T10:00:00Z",
    sourceRefName: "refs/heads/feature/9-x",
    targetRefName: "refs/heads/main",
    repository: REPO_B,
    reviewers: [],
  },
];

function world(extra: Route[] = []) {
  const urls: string[] = [];
  const routes: Route[] = [
    ...extra,
    { match: /^https:\/\/dev\.azure\.com\/[^/]+\/_apis\/connectionData\?/, respond: () => ({ body: { authenticatedUser: { id: "me-guid", customDisplayName: "Me" } } }) },
    { match: /\/_apis\/git\/pullrequests\?/, respond: (c) => (urls.push(c.url), { body: { value: prs } }) },
  ];
  return { routes, urls };
}

async function run(dir: string, routes: Route[], argv: string[]) {
  const { ctx, lines, errs } = ctxFor(dir, fakeFetch(routes).fn);
  const code = await main(argv, ctx);
  return { code, out: lines.join("\n"), errs };
}

function repoWithTeam(team = "") {
  const { dir } = makeRepo();
  if (team) write(dir, ".agents/skills/_shared/references/team.yaml", team);
  return dir;
}

describe("aihub pr list", () => {
  it("lists active PRs of the project with reviewers and votes, JSON shape included", async () => {
    const w = world();
    const r = await run(repoWithTeam(), w.routes, ["pr", "list", "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.map((p: any) => p.id)).toEqual([7, 9]); // newest first
    expect(j[0]).toEqual({
      id: 7,
      title: "7 CSV export",
      repo: "test-repo",
      source: "feature/7-csv",
      target: "main",
      status: "active",
      draft: false,
      author: "Anna",
      reviewers: [
        { name: "Bob", vote: 10, voteName: "approved", required: true },
        { name: "Carl", vote: 0, voteName: "no vote", required: false },
        { name: "Dora", vote: -10, voteName: "rejected", required: false },
      ],
      url: "https://dev.azure.com/ferron-org/test-project/_git/test-repo/pullrequest/7",
      created: "2026-11-18T10:00:00Z",
    });
    expect(w.urls[0]).toContain("searchCriteria.status=active");
  });

  it("compact text with votes; --status, --branch, --mine and --reviewer become search criteria", async () => {
    const w = world();
    const dir = repoWithTeam();
    const r = await run(dir, w.routes, ["pr", "list", "--status", "all", "--branch", "feature/7-csv", "--mine", "--reviewer"]);
    expect(r.out).toContain("!7 [active] 7 CSV export (test-repo: feature/7-csv -> main) by Anna  votes: Bob: approved, Dora: rejected");
    expect(r.out).toContain("!9 [active] 9 Other (other-repo:");
    const u = w.urls[0];
    expect(u).toContain("searchCriteria.status=all");
    expect(u).toContain("searchCriteria.sourceRefName=refs%2Fheads%2Ffeature%2F7-csv");
    expect(u).toContain("searchCriteria.creatorId=me-guid");
    expect(u).toContain("searchCriteria.reviewerId=me-guid");
  });

  it("only the repositories of team.yaml, or the one named with --repo", async () => {
    const dir = repoWithTeam("repositories:\n  - name: test-repo\n    defaultTarget: main\n");
    const a = await run(dir, world().routes, ["pr", "list", "--json"]);
    expect(JSON.parse(a.out).map((p: any) => p.repo)).toEqual(["test-repo"]);
    const b = await run(dir, world().routes, ["pr", "list", "--json", "--repo", "other-repo"]);
    expect(JSON.parse(b.out).map((p: any) => p.repo)).toEqual(["other-repo"]);
  });

  it("an unknown status is refused; no result prints a line", async () => {
    const dir = repoWithTeam();
    expect((await run(dir, world().routes, ["pr", "list", "--status", "weird"])).code).toBe(1);
    const empty = await run(dir, [{ match: /\/_apis\/git\/pullrequests\?/, respond: () => ({ body: { value: [] } }) }], ["pr", "list"]);
    expect(empty.out).toBe("no active pull requests found");
  });
});

describe("aihub pr show", () => {
  const show = (): Route[] => [
    { match: /\/git\/repositories\/test-repo\/pullrequests\/7\?/, respond: () => ({ body: { ...prs[0], description: "## Summary\n\nWhy this.\n\n## Changes\n- a" } }) },
    {
      match: /\/git\/repositories\/test-repo\/pullrequests\/7\/threads/,
      respond: () => ({
        body: {
          value: [
            { id: 1, status: "active", comments: [{ id: 1, author: { displayName: "Bob" }, content: "q" }] },
            { id: 2, status: "fixed", comments: [{ id: 1, author: { displayName: "Bob" }, content: "ok" }] },
          ],
        },
      }),
    },
    { match: /\/git\/repositories\/test-repo\?/, respond: () => ({ body: { id: "repo-a", project: { id: "proj-1" } } }) },
    {
      match: /\/policy\/evaluations\?/,
      respond: () => ({
        body: {
          value: [
            { evaluationId: "e1", status: "approved", configuration: { isEnabled: true, isBlocking: true, type: { displayName: "Build" }, settings: { displayName: "ci" } } },
            { evaluationId: "e2", status: "rejected", configuration: { isEnabled: true, isBlocking: true, type: { displayName: "Minimum number of reviewers" } } },
          ],
        },
      }),
    },
  ];

  it("--json: title, description head, branches, reviewers with votes, policies, threads, url", async () => {
    const r = await run(repoWithTeam(), show(), ["pr", "show", "--pr", "7", "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j).toMatchObject({ id: 7, title: "7 CSV export", repo: "test-repo", source: "feature/7-csv", target: "main", status: "active", author: "Anna" });
    expect(j.description).toContain("Why this.");
    expect(j.reviewers[0]).toEqual({ name: "Bob", vote: 10, voteName: "approved", required: true });
    expect(j.policies).toEqual({ total: 2, approved: 1, blocking: ["Minimum number of reviewers: rejected"] });
    expect(j.threads).toEqual({ total: 2, open: 1 });
    expect(j.url).toBe("https://dev.azure.com/ferron-org/test-project/_git/test-repo/pullrequest/7");
  });

  it("text view and a clear error without --pr", async () => {
    const dir = repoWithTeam();
    const r = await run(dir, show(), ["pr", "show", "--pr", "7"]);
    expect(r.out).toContain("!7 7 CSV export (active) by Anna");
    expect(r.out).toContain("Reviewers: Bob (required): approved, Carl: no vote, Dora: rejected");
    expect(r.out).toContain("Policies: 1/2 ok; blocking: Minimum number of reviewers: rejected");
    expect(r.out).toContain("Threads: 2 (1 open)");
    const e = await run(dir, [], ["pr", "show"]);
    expect(e.code).toBe(1);
    expect(e.errs.join("\n")).toContain("needs --pr");
  });
});

describe("aihub status --json carries the reviewers", () => {
  it("pr.reviewers is [{name, vote, voteName, required}]", async () => {
    const { dir } = makeRepo();
    sh(dir, ["checkout", "-b", "feature/7-csv"]);
    const pr = { ...prs[0], sourceRefName: "refs/heads/feature/7-csv" };
    const routes: Route[] = [
      { match: /_apis\/wit\/workitems\/7\?/, respond: () => ({ body: { id: 7, fields: { "System.Title": "CSV", "System.State": "Active", "System.WorkItemType": "User Story" } } }) },
      { match: /pullrequests\?.*searchCriteria/, respond: () => ({ body: { value: [pr] } }) },
      { match: /pullrequests\/7\/threads/, respond: () => ({ body: { value: [] } }) },
      { match: /pullrequests\/7\?/, respond: () => ({ body: pr }) },
      { match: /build\/builds\?/, respond: () => ({ body: { value: [] } }) },
    ];
    const { ctx, lines } = ctxFor(dir, fakeFetch(routes).fn);
    await main(["status", "--json"], ctx);
    const j = JSON.parse(lines.join("\n"));
    expect(j.pr.reviewers).toEqual([
      { name: "Bob", vote: 10, voteName: "approved", required: true },
      { name: "Carl", vote: 0, voteName: "no vote", required: false },
      { name: "Dora", vote: -10, voteName: "rejected", required: false },
    ]);
  });
});

describe("aihub watch events", () => {
  function store(env: NodeJS.ProcessEnv, rows: { id: string; at: number; message: string }[]) {
    const d = join(env.AIHUB_HOME!, "events");
    mkdirSync(d, { recursive: true });
    for (const r of rows) writeFileSync(join(d, `${r.id}.json`), JSON.stringify({ ...r, repo: "/r", client: "opencode" }));
    writeFileSync(join(d, "broken.json"), "{ half");
  }
  const NOW = Date.parse("2026-11-18T12:00:00Z");

  it("newest first, --limit, --since, --json with the aihub:// url; a half written file is skipped", async () => {
    const { dir } = makeRepo();
    const { ctx, lines } = ctxFor(dir, fakeFetch([]).fn);
    ctx.now = () => NOW;
    store(ctx.env, [
      { id: "mine-a", at: NOW - 30 * 60_000, message: "Anna commented on PR !7" },
      { id: "mine-b", at: NOW - 10 * 60_000, message: "Build failed on your PR !8" },
      { id: "old-c", at: NOW - 5 * 3_600_000, message: "PR !3 is now completed" },
    ]);
    await main(["watch", "events", "--json"], ctx);
    const all = JSON.parse(lines.at(-1)!);
    expect(all.map((e: any) => e.id)).toEqual(["mine-b", "mine-a", "old-c"]);
    expect(all[0]).toEqual({ id: "mine-b", at: "2026-11-18T11:50:00.000Z", epoch: NOW - 600_000, message: "Build failed on your PR !8", repo: "/r", client: "opencode", url: "aihub://open?event=mine-b" });
    await main(["watch", "events", "--json", "--limit", "1"], ctx);
    expect(JSON.parse(lines.at(-1)!).map((e: any) => e.id)).toEqual(["mine-b"]);
    await main(["watch", "events", "--json", "--since", "1h"], ctx);
    expect(JSON.parse(lines.at(-1)!).map((e: any) => e.id)).toEqual(["mine-b", "mine-a"]);
    await main(["watch", "events"], ctx);
    expect(lines.at(-1)).toContain("2026-11-18 11:30  Anna commented on PR !7  (mine-a)");
  });

  it("no events, a bare --since number and a bad --limit", async () => {
    const { dir } = makeRepo();
    const a = ctxFor(dir, fakeFetch([]).fn);
    await main(["watch", "events"], a.ctx);
    expect(a.lines.at(-1)).toBe("no watch events recorded");
    expect(await main(["watch", "events", "--since", "2"], a.ctx)).toBe(1);
    expect(a.errs.join("\n")).toContain("--since '2' needs a unit");
    expect(await main(["watch", "events", "--limit", "0"], a.ctx)).toBe(1);
    expect(listEvents({ AIHUB_HOME: tmp("empty-") })).toEqual([]);
  });
});
