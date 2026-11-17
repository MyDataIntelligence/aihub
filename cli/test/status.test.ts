import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { nextStep, type StepInput } from "../src/lib/status.js";
import { ctxFor, fakeFetch, makeRepo, sh, write, type Route } from "./helpers.js";

const base: StepInput = {
  branch: "feature/7-x",
  story: { id: 7, title: "X", state: "Active" },
  pr: null,
  checks: "none",
  openThreads: 0,
  dirty: false,
  unpushed: 0,
  protectedBranch: false,
  prCompleted: false,
};
const withPr = { pr: { id: 5, draft: false } };

describe("nextStep follows the story-run flow", () => {
  it.each<[string, Partial<StepInput>, RegExp]>([
    ["no story", { story: null }, /no story id in the branch name/],
    ["protected branch", { protectedBranch: true }, /no feature branch/],
    ["dirty tree", { dirty: true }, /commit the open changes/],
    ["unpushed, no PR", { unpushed: 2 }, /create the PR/],
    ["no PR", {}, /implement the story/],
    ["running", { ...withPr, checks: "running" }, /wait for the pipeline/],
    ["red", { ...withPr, checks: "red" }, /fix the failing pipeline/],
    ["threads", { ...withPr, checks: "green", openThreads: 2 }, /process 2 open review thread/],
    ["green", { ...withPr, checks: "green" }, /green and no open threads/],
    ["completed", { prCompleted: true }, /story-finish/],
  ])("%s", (_n, over, re) => {
    expect(nextStep({ ...base, ...over }).next).toMatch(re);
  });
});

describe("aihub status", () => {
  it("summarises story, PR, pipeline and open threads for a resumed session", async () => {
    const { dir } = makeRepo();
    sh(dir, ["checkout", "-b", "feature/7-csv"]);
    const pr = { pullRequestId: 5, title: "7 CSV", status: "active", isDraft: false, sourceRefName: "refs/heads/feature/7-csv", targetRefName: "refs/heads/main" };
    const routes: Route[] = [
      { match: /_apis\/wit\/workitems\/7\?/, respond: () => ({ body: { id: 7, fields: { "System.Title": "CSV export", "System.State": "Active", "System.WorkItemType": "User Story" } } }) },
      { match: /pullrequests\?.*searchCriteria/, respond: () => ({ body: { value: [pr] } }) },
      { match: /pullrequests\/5\/threads/, respond: () => ({ body: { value: [{ id: 1, status: "active", comments: [{ id: 1, author: { displayName: "Anna" }, content: "why?" }] }] } }) },
      { match: /pullrequests\/5\?/, respond: () => ({ body: pr }) },
      { match: /build\/builds\?/, respond: () => ({ body: { value: [{ id: 9, status: "completed", result: "succeeded", definition: { id: 1, name: "ci" } }] } }) },
    ];
    const { ctx, lines, errs } = ctxFor(dir, fakeFetch(routes).fn);
    expect(await main(["status"], ctx)).toBe(0);
    expect(errs).toEqual([]);
    const out = lines.join("\n");
    expect(out).toContain("Story: 7 CSV export [Active]");
    expect(out).toContain("PR: !5 7 CSV [active]");
    expect(out).toContain("Pipeline: ci succeeded");
    expect(out).toContain("Open threads: 1");
    expect(out).toContain("Next step: process 1 open review thread(s)");

    write(dir, "wip.txt", "x");
    lines.length = 0;
    await main(["status", "--json"], ctx);
    const j = JSON.parse(lines[0]);
    expect(j).toMatchObject({ branch: "feature/7-csv", checks: "green", openThreads: 1, dirty: true });
    expect(j.next).toMatch(/commit the open changes/);
  });

  it("still answers when Azure DevOps is unreachable", async () => {
    const { dir } = makeRepo();
    sh(dir, ["checkout", "-b", "feature/7-csv"]);
    const { ctx, lines } = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(["status"], ctx)).toBe(0);
    expect(lines.join("\n")).toContain("could not read story");
    expect(lines.join("\n")).toContain("Next step:");
  });
});
