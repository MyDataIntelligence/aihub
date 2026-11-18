import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { addTestRow, duration, threadUrl, type Evidence } from "../src/lib/prGold.js";
import { ctxFor, fakeFetch, makeRepo, tmp, write, type Route } from "./helpers.js";

const PR_BASE = "/ferron-org/test-project/_apis/git/repositories/test-repo/pullrequests/7";
const PR_URL = "https://dev.azure.com/ferron-org/test-project/_git/test-repo/pullrequest/7";

const EV: Evidence = { name: "ci #20261118.4", result: "pass", link: "https://dev.azure.com/ferron-org/test-project/_build/results?buildId=55", durationMs: 192_000, detail: "12/12 tests" };

function world(description: string, team = "language: en\n", extra: Route[] = []) {
  const { dir } = makeRepo();
  write(dir, ".agents/skills/_shared/references/team.yaml", team);
  const patches: any[] = [];
  const posts: any[] = [];
  const routes: Route[] = [
    ...extra,
    { method: "PATCH", match: new RegExp(PR_BASE + "\\?"), respond: (c) => (patches.push(c.body), { body: {} }) },
    { method: "POST", match: new RegExp(PR_BASE + "/threads\\?"), respond: (c) => (posts.push(c.body), { body: { id: 31 } }) },
    { match: new RegExp(PR_BASE + "\\?"), respond: () => ({ body: { pullRequestId: 7, status: "active", description, sourceRefName: "refs/heads/f", targetRefName: "refs/heads/main" } }) },
  ];
  const { ctx, lines, errs } = ctxFor(dir, fakeFetch(routes).fn);
  return { ctx, lines, errs, patches, posts, dir };
}

describe("duration", () => {
  it("compact", () => {
    expect(duration(5000)).toBe("5s");
    expect(duration(192_000)).toBe("3m 12s");
    expect(duration(3_900_000)).toBe("1h 5m");
    expect(duration(undefined)).toBe("-");
  });
});

describe("aihub pr comment", () => {
  it("posts a CLOSED thread with the title in bold and links it from the section", async () => {
    const w = world("## Summary\n\nWhy.\n\n## Resultaat\n\nGelukt.\n");
    expect(await main(["pr", "comment", "--pr", "7", "--title", "Looptijd per stap", "--text", "Stap A 3s, stap B 9s", "--closed", "--link-section", "Resultaat"], w.ctx)).toBe(0);
    expect(w.posts[0]).toEqual({ comments: [{ parentCommentId: 0, content: "**Looptijd per stap**\n\nStap A 3s, stap B 9s", commentType: 1 }], status: "closed" });
    const d = w.patches[0].description as string;
    expect(d).toContain(`## Resultaat\n\nGelukt.\n\nDetails: [Looptijd per stap](${PR_URL}?_a=overview&discussionId=31)`);
    expect(d).toContain("## Summary\n\nWhy.");
    expect(w.lines.join("\n")).toContain(`PR !7: closed thread 31 posted: ${threadUrl(PR_URL, 31)}`);
    expect(w.lines.join("\n")).toContain("linked from the 'Resultaat' section");
  });

  it("without --closed the thread stays active; without --link-section the description is untouched; --body-file works", async () => {
    const w = world("## Summary\n\nWhy.\n");
    const f = join(tmp("gold-"), "d.md");
    writeFileSync(f, "Lange uitleg met ë.\n", "utf8");
    expect(await main(["pr", "comment", "--pr", "7", "--title", "Detail", "--body-file", f, "--json"], w.ctx)).toBe(0);
    expect(w.posts[0].status).toBe("active");
    expect(w.posts[0].comments[0].content).toBe("**Detail**\n\nLange uitleg met ë.");
    expect(w.patches).toEqual([]);
    expect(JSON.parse(w.lines.join("\n"))).toMatchObject({ pr: 7, threadId: 31, status: "active", url: threadUrl(PR_URL, 31) });
  });

  it("needs a title and a text", async () => {
    const w = world("x");
    expect(await main(["pr", "comment", "--pr", "7", "--text", "x"], w.ctx)).toBe(1);
    expect(w.errs.join("\n")).toContain("--title");
    expect(await main(["pr", "comment", "--pr", "7", "--title", "t"], w.ctx)).toBe(1);
    expect(w.errs.join("\n")).toContain("--text");
  });
});

describe("addTestRow", () => {
  it("replaces the template's placeholder row and keeps the rest of the table and the section", () => {
    const d = "## Summary\n\nWhy.\n\n## Tests\n\n| Test | Result |\n|---|---|\n| <test that was really run> | <pass or fail> |\n\nNot run: integration tests.\n";
    const r = addTestRow(d, EV, "en");
    expect(r.heading).toBe("Tests");
    expect(r.description).toContain(`| Test | Result |\n|---|---|\n| [ci #20261118.4](${EV.link}) | pass (12/12 tests) |`);
    expect(r.description).not.toContain("<test that was really run>");
    expect(r.description).toContain("Not run: integration tests.");
  });

  it("adds below real rows, fills link and duration columns, refreshes the same run instead of duplicating it", () => {
    const d = "## Functionele tests\n\n| Test | Resultaat | Link | Duur |\n|---|---|---|---|\n| handmatig | geslaagd | - | - |\n";
    const a = addTestRow(d, EV, "nl");
    expect(a.heading).toBe("Functionele tests");
    expect(a.description).toContain("| handmatig | geslaagd | - | - |");
    expect(a.description).toContain(`| ci #20261118.4 | geslaagd (12/12 tests) | [run](${EV.link}) | 3m 12s |`);
    const b = addTestRow(a.description, { ...EV, result: "fail", detail: undefined }, "nl");
    expect(b.replaced).toBe(true);
    expect(b.description.match(/ci #20261118\.4/g)).toHaveLength(1);
    expect(b.description).toContain("| ci #20261118.4 | mislukt | ");
  });

  it("no table yet: creates one and drops the honest 'not run yet' line; no tests section: adds one", () => {
    const a = addTestRow("## Summary\n\nWhy.\n\n## Tests\n\nNot run yet.\n", EV, "en");
    expect(a.description).toContain(`## Tests\n\n| Test | Result | Duration |\n|---|---|---|\n| [ci #20261118.4](${EV.link}) | pass (12/12 tests) | 3m 12s |`);
    expect(a.description).not.toContain("Not run yet.");
    const nl = addTestRow("## Samenvatting\n\nWaarom.\n\n## Tests\n\nNog niet uitgevoerd.\n", { ...EV, result: "partial" }, "nl");
    expect(nl.description).toContain("| Test | Resultaat | Duur |");
    expect(nl.description).toContain("deels geslaagd (12/12 tests)");
    expect(nl.description).not.toContain("Nog niet uitgevoerd");
    const none = addTestRow("## Summary\n\nWhy.\n", EV, "en");
    expect(none.description).toMatch(/## Tests\n\n\| Test \| Result \| Duration \|/);
  });

  it("a pipe in a name does not break the table", () => {
    const r = addTestRow("## Tests\n\nNot run yet.\n", { ...EV, name: "a|b" }, "en");
    expect(r.description).toContain("[a\\|b](");
  });
});

describe("aihub pr tests add", () => {
  const build = (over: object = {}) => ({
    id: 55,
    buildNumber: "20261118.4",
    status: "completed",
    result: "succeeded",
    startTime: "2026-11-18T10:00:00Z",
    finishTime: "2026-11-18T10:03:12Z",
    definition: { name: "ci" },
    _links: { web: { href: "https://dev.azure.com/ferron-org/test-project/_build/results?buildId=55" } },
    ...over,
  });
  const buildRoutes = (b: object, runs: object[] = [{ totalTests: 12, passedTests: 12 }]): Route[] => [
    { match: /_apis\/build\/builds\/55\?/, respond: () => ({ body: b }) },
    { match: /_apis\/test\/runs\?/, respond: () => ({ body: { value: runs } }) },
  ];
  const D = "## Summary\n\nWhy.\n\n## Tests\n\nNot run yet.\n";

  it("--from-run: the real result, link, duration and test counts become one row", async () => {
    const w = world(D, "language: en\n", buildRoutes(build()));
    expect(await main(["pr", "tests", "add", "--pr", "7", "--from-run", "55"], w.ctx)).toBe(0);
    expect(w.patches[0].description).toContain(`| [ci #20261118.4](${EV.link}) | pass (12/12 tests) | 3m 12s |`);
    expect(w.lines.join("\n")).toContain("test row added in 'Tests': ci #20261118.4: pass (12/12 tests), 3m 12s");
  });

  it("a failed run is recorded as fail; a still running run is refused; --name renames; --from-robot labels it", async () => {
    const f = world(D, "language: en\n", buildRoutes(build({ result: "failed" }), []));
    await main(["pr", "tests", "add", "--pr", "7", "--from-run", "55", "--name", "orders suite"], f.ctx);
    expect(f.patches[0].description).toContain("| [orders suite](");
    expect(f.patches[0].description).toContain("| fail | ");
    const r = world(D, "language: en\n", buildRoutes(build({ status: "inProgress", result: undefined })));
    expect(await main(["pr", "tests", "add", "--pr", "7", "--from-run", "55"], r.ctx)).toBe(1);
    expect(r.errs.join("\n")).toContain("still inProgress");
    expect(r.patches).toEqual([]);
    const robot = world(D, "language: nl\n", buildRoutes(build()));
    await main(["pr", "tests", "add", "--pr", "7", "--from-robot", "55"], robot.ctx);
    expect(robot.patches[0].description).toContain("[Robot ci #20261118.4](");
    expect(robot.patches[0].description).toContain("geslaagd");
  });

  it("--from-fabric-job: workspace/item/job from the Fabric API (Completed -> pass, Failed -> fail with the error code)", async () => {
    const fabric = (status: string, extra: object = {}): Route[] => [
      { match: /api\.fabric\.microsoft\.com\/v1\/workspaces$/, respond: () => ({ body: { value: [{ id: "ws-1", displayName: "aihub-test-dev-x" }] } }) },
      { match: /api\.fabric\.microsoft\.com\/v1\/workspaces\/ws-1\/items$/, respond: () => ({ body: { value: [{ id: "it-1", displayName: "nb_ok", type: "Notebook" }] } }) },
      { match: /jobs\/instances\/job-123456789$/, respond: () => ({ body: { id: "job-123456789", status, startTimeUtc: "2026-11-18T10:00:00", endTimeUtc: "2026-11-18T10:00:12", ...extra } }) },
    ];
    const ok = world(D, "language: en\n", fabric("Completed"));
    ok.ctx.env.AIHUB_FABRIC_TOKEN = "t";
    expect(await main(["pr", "tests", "add", "--pr", "7", "--from-fabric-job", "aihub-test-dev-x/nb_ok/job-123456789"], ok.ctx)).toBe(0);
    expect(ok.patches[0].description).toContain("Fabric Notebook nb_ok");
    expect(ok.patches[0].description).toContain("pass (aihub-test-dev-x, job job-1234) | 12s |");
    const bad = world(D, "language: en\n", fabric("Failed", { failureReason: { errorCode: "SparkJobFailed" } }));
    bad.ctx.env.AIHUB_FABRIC_TOKEN = "t";
    await main(["pr", "tests", "add", "--pr", "7", "--from-fabric-job", "aihub-test-dev-x/nb_ok/job-123456789"], bad.ctx);
    expect(bad.patches[0].description).toContain("fail (aihub-test-dev-x, job job-1234, SparkJobFailed)");
    const running = world(D, "language: en\n", fabric("InProgress"));
    running.ctx.env.AIHUB_FABRIC_TOKEN = "t";
    expect(await main(["pr", "tests", "add", "--pr", "7", "--from-fabric-job", "aihub-test-dev-x/nb_ok/job-123456789"], running.ctx)).toBe(1);
    expect(running.errs.join("\n")).toContain("still InProgress");
  });

  it("exactly one source is required", async () => {
    const w = world(D);
    expect(await main(["pr", "tests", "add", "--pr", "7"], w.ctx)).toBe(1);
    expect(w.errs.join("\n")).toContain("exactly one of");
    expect(await main(["pr", "tests", "add", "--pr", "7", "--from-run", "1", "--from-robot", "2"], w.ctx)).toBe(1);
    expect(await main(["pr", "tests", "nope"], w.ctx)).toBe(1);
  });
});
