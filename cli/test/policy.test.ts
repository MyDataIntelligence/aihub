import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { kindOf, viewOf } from "../src/lib/policy.js";
import { ctxFor, fakeFetch, makeRepo, type Route } from "./helpers.js";

const ev = (id: string, type: string, status: string, extra: object = {}) => ({
  evaluationId: id,
  status,
  configuration: { id: 1, isBlocking: true, isEnabled: true, type: { displayName: type }, ...extra },
});

const pr = { pullRequestId: 5, title: "T", status: "active", isDraft: false, mergeStatus: "succeeded", sourceRefName: "refs/heads/f", targetRefName: "refs/heads/main" };

function routes(evals: object[], patched: string[] = [], over: object = {}): Route[] {
  return [
    { match: /_apis\/git\/repositories\/test-repo\?/, respond: () => ({ body: { id: "repo-guid", project: { id: "proj-guid" } } }) },
    {
      match: /_apis\/policy\/evaluations\?/,
      respond: (c) => {
        expect(c.url).toContain("artifactId=vstfs%3A%2F%2F%2FCodeReview%2FCodeReviewId%2Fproj-guid%2F5");
        expect(c.url).toContain("api-version=7.1-preview.1");
        return { body: { value: evals } };
      },
    },
    {
      method: "PATCH",
      match: /_apis\/policy\/evaluations\/[^?]+\?/,
      respond: (c) => (patched.push(c.url.replace(/.*evaluations\//, "").split("?")[0]), { body: {} }),
    },
    { match: /pullrequests\/5\/threads/, respond: () => ({ body: { value: [{ id: 1, status: "active", comments: [{ id: 1, author: { displayName: "A" }, content: "fix" }] }] } }) },
    { match: /pullrequests\/5\?/, respond: () => ({ body: { ...pr, ...over } }) },
  ];
}

describe("policy views", () => {
  it("classifies policy types and hides disabled ones", () => {
    expect(kindOf("Minimum number of reviewers")).toBe("reviewers");
    expect(kindOf("Work item linking")).toBe("workitems");
    expect(viewOf({ ...ev("x", "Build", "rejected"), configuration: { isEnabled: false, type: { displayName: "Build" } } })).toBeUndefined();
    expect(viewOf(ev("x", "Build", "queued", { isBlocking: false }))).toMatchObject({ blocking: false, blocks: false });
  });
});

describe("aihub pr checks", () => {
  it("lists the policies and what blocks completion, with the way out", async () => {
    const { dir } = makeRepo();
    const evals = [
      ev("e1", "Build", "rejected", { settings: { displayName: "ci" } }),
      ev("e2", "Minimum number of reviewers", "queued"),
      ev("e3", "Comment requirements", "rejected"),
      ev("e4", "Work item linking", "approved"),
      ev("e5", "Status", "rejected", { isBlocking: false }),
    ];
    const { ctx, lines, errs } = ctxFor(dir, fakeFetch(routes(evals)).fn);
    expect(await main(["pr", "checks", "--pr", "5"], ctx)).toBe(0);
    expect(errs).toEqual([]);
    const out = lines.join("\n");
    expect(out).toContain("BLOCKS Build (ci): rejected");
    expect(out).toContain("BLOCKS Minimum number of reviewers: queued");
    expect(out).toContain("ok     Work item linking: approved");
    expect(out).toContain("info   Status: rejected (optional)");
    expect(out).toContain("Blocks completion (3):");
    expect(out).toContain("aihub pr requeue --pr 5 --policy build");
    expect(out).toContain("aihub comments get --pr 5");
    expect(out).not.toContain("Work item linking is");
  });

  it("reports a draft with conflicts and a clean PR", async () => {
    const { dir } = makeRepo();
    const bad = ctxFor(dir, fakeFetch(routes([], [], { isDraft: true, mergeStatus: "conflicts" })).fn);
    await main(["pr", "checks", "--pr", "5", "--json"], bad.ctx);
    const j = JSON.parse(bad.lines[0]);
    expect(j.canComplete).toBe(false);
    expect(j.blockers.join(" ")).toContain("draft");
    expect(j.blockers.join(" ")).toContain("merge conflicts");
    const ok = ctxFor(dir, fakeFetch(routes([ev("e1", "Build", "approved")], [], {})).fn);
    await main(["pr", "checks", "--pr", "5"], ok.ctx);
    expect(ok.lines.join("\n")).toContain("Nothing blocks completion.");
  });
});

describe("aihub pr requeue", () => {
  it("requeues the failed policies, or the one named", async () => {
    const { dir } = makeRepo();
    const evals = [ev("e1", "Build", "rejected"), ev("e2", "Comment requirements", "rejected"), ev("e3", "Build", "running"), ev("e4", "Build", "approved")];
    const patched: string[] = [];
    const a = ctxFor(dir, fakeFetch(routes(evals, patched)).fn);
    expect(await main(["pr", "requeue", "--pr", "5", "--policy", "build"], a.ctx)).toBe(0);
    expect(patched).toEqual(["e1", "e4"]);
    expect(a.lines[0]).toContain("requeued Build, Build");

    patched.length = 0;
    const b = ctxFor(dir, fakeFetch(routes(evals, patched)).fn);
    await main(["pr", "requeue", "--pr", "5"], b.ctx);
    expect(patched).toEqual(["e1", "e2"]);

    const c = ctxFor(dir, fakeFetch(routes([ev("e1", "Build", "approved")], patched)).fn);
    expect(await main(["pr", "requeue", "--pr", "5"], c.ctx)).toBe(1);
    expect(c.errs[0]).toContain("no failed policy");
  });
});
