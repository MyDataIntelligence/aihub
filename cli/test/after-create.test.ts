import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, sh, write, type Route } from "./helpers.js";

const REPO = "/ferron-org/test-project/_apis/git/repositories/test-repo";
const PR9 = `${REPO}/pullrequests/9`;

function setup(afterCreate: string) {
  const { dir } = makeRepo();
  sh(dir, ["config", "user.name", "T"]);
  sh(dir, ["config", "user.email", "t@e.com"]);
  write(dir, ".azuredevops/pull_request_template.md", "## Summary\n\n## Changes\n\n## Tests\n");
  write(dir, ".agents/skills/_shared/references/team.yaml", `language: en\nrepositories:\n  - name: test-repo\n    defaultTarget: main\npullRequest:\n${afterCreate}`);
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "chore: templates"]);
  sh(dir, ["push", "origin", "main"]);
  sh(dir, ["checkout", "-b", "feature/1234-x"]);
  write(dir, "a.py", "x=1\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "feat: a"]);
  return dir;
}

interface Seen {
  stateOps: any[][];
  completePatch: any[];
}

function routes(o: { policy: boolean; stateFails?: boolean; existing?: boolean }, seen: Seen): Route[] {
  const pr9 = { pullRequestId: 9, title: "t", status: "active", isDraft: false, sourceRefName: "refs/heads/feature/1234-x", targetRefName: "refs/heads/main", lastMergeSourceCommit: { commitId: "c" }, createdBy: { id: "me" } };
  return [
    { match: /_apis\/wit\/workitems\/1234\?.*fields=/, respond: () => ({ body: { fields: { "System.Title": "X bouwen", "System.WorkItemType": "User Story" } } }) },
    { match: /_apis\/wit\/workitems\/1234\?.*expand=relations|%24expand=relations/, respond: () => ({ body: { relations: [] } }) },
    { method: "PATCH", match: /_apis\/wit\/workitems\/1234\?/, respond: (c) => (seen.stateOps.push(c.body), o.stateFails ? { status: 400, body: { message: "The field 'State' contains the value 'Review' that is not in the list of supported values" } } : { body: { id: 1234 } }) },
    { match: /_apis\/wit\/workitems\/1234\?/, respond: () => ({ body: { id: 1234, fields: { "System.State": "Doing" } } }) },
    { match: /_apis\/wit\/workitemtypes\/[^/]+\/states\?/, respond: () => ({ body: { value: [{ name: "Doing" }, { name: "Done" }] } }) },
    { match: new RegExp(REPO + "/pullrequests\\?.*searchCriteria"), respond: () => ({ body: { value: o.existing ? [pr9] : [] } }) },
    { method: "POST", match: new RegExp(REPO + "/pullrequests\\?"), respond: () => ({ body: pr9 }) },
    { method: "PATCH", match: new RegExp(PR9 + "\\?"), respond: (c) => (seen.completePatch.push(c.body), { body: pr9 }) },
    { match: new RegExp(PR9 + "\\?"), respond: () => ({ body: pr9 }) },
    { match: new RegExp(REPO + "\\?"), respond: () => ({ body: { id: "repo-1", project: { id: "proj-1" } } }) },
    { match: /^https:\/\/dev\.azure\.com\/[^/]+\/_apis\/connectionData\?/, respond: () => ({ body: { authenticatedUser: { id: "me-guid" } } }) },
    {
      match: /_apis\/policy\/configurations\?/,
      respond: () => ({ body: { value: o.policy ? [{ isEnabled: true, isBlocking: true, settings: { scope: [{ repositoryId: "repo-1", refName: "refs/heads/main", matchKind: "Exact" }] } }] : [{ isEnabled: true, isBlocking: false, settings: { scope: [{ repositoryId: "repo-1", refName: "refs/heads/main" }] } }] } }),
    },
  ];
}

async function create(afterCreate: string, o: Parameters<typeof routes>[0]) {
  const dir = setup(afterCreate);
  const seen: Seen = { stateOps: [], completePatch: [] };
  const { ctx, lines, errs } = ctxFor(dir, fakeFetch(routes(o, seen)).fn);
  const code = await main(["pr", "create", "--summary-text", "Waarom."], ctx);
  return { code, out: lines.join("\n"), errs: errs.join("\n"), seen };
}

describe("team.yaml pullRequest.afterCreate", () => {
  it("sets the story state and auto-complete (never bypassing policies) right after a NEW pull request", async () => {
    const r = await create("  afterCreate:\n    storyState: Review\n    autoComplete: true\n", { policy: true });
    expect(r.code).toBe(0);
    expect(r.out).toContain("PR !9 created");
    expect(r.out).toContain("after create: story AB#1234 -> Review; auto-complete set, it merges when: the policies pass");
    expect(r.seen.stateOps[0]).toEqual([{ op: "add", path: "/fields/System.State", value: "Review" }]);
    expect(r.seen.completePatch[0]).toEqual({ autoCompleteSetBy: { id: "me-guid" }, completionOptions: { deleteSourceBranch: false, bypassPolicy: false } });
  });

  it("without a blocking policy on the target branch auto-complete is NOT requested (it would merge at once)", async () => {
    const r = await create("  afterCreate:\n    storyState: Review\n    autoComplete: true\n", { policy: false });
    expect(r.out).toContain("story AB#1234 -> Review");
    expect(r.out).toContain("auto-complete not requested: 'main' has no blocking policy, it would merge at once");
    expect(r.seen.completePatch).toEqual([]);
  });

  it("a story state that the process does not have is reported, the PR stays and the exit code is 0", async () => {
    const r = await create("  afterCreate:\n    storyState: Review\n", { policy: true, stateFails: true });
    expect(r.code).toBe(0);
    expect(r.out).toContain("PR !9 created");
    expect(r.out).toContain("story state not set: state 'Review' does not exist for work item 1234 (this project uses: Doing, Done)");
  });

  it("nothing without afterCreate, and nothing when an existing PR is only updated", async () => {
    const a = await create("  emptySection: '-'\n", { policy: true });
    expect(a.out).not.toContain("after create");
    expect(a.seen.stateOps).toEqual([]);
    const b = await create("  afterCreate:\n    storyState: Review\n    autoComplete: true\n", { policy: true, existing: true });
    expect(b.out).toContain("PR !9 updated");
    expect(b.out).not.toContain("after create");
    expect(b.seen.stateOps).toEqual([]);
  });
});
