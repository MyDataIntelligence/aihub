import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { writeLookIn } from "../src/lib/machineScan.js";
import { readSettings, saveSettings, storiesOf } from "../src/lib/stories/core.js";
import { artifactLinks, listWiql, storyBoard, storyList, storyShow } from "../src/lib/stories/read.js";
import { refineApply, refineAsk, refineRead } from "../src/lib/stories/refine.js";
import { fixBranchName, storyDraft, storyLink } from "../src/lib/stories/start.js";
import { partOf } from "../src/lib/stories/template.js";
import { storyComment, storyEdit, storyMove, storyNew, storyTask } from "../src/lib/stories/write.js";
import { ctxFor, fakeFetch, tmp, type Call, type Route } from "./helpers.js";

const ORG = "https://dev.azure.com/ferron-test";
const P = `${ORG}/test-project`;
const NOW = Date.parse("2026-11-27T09:00:00Z");
const ME = { id: "me-id", providerDisplayName: "Test User", properties: { Account: { $value: "test.user@example.test" } } };
const meIdentity = { displayName: "Test User", uniqueName: "test.user@example.test", id: "me-id" };
const other = { displayName: "Other Dev", uniqueName: "other.dev@example.test", id: "o-id" };

const STATES: Record<string, { name: string; category: string }[]> = {
  "user story": [
    { name: "New", category: "Proposed" },
    { name: "Active", category: "InProgress" },
    { name: "Resolved", category: "Resolved" },
    { name: "Closed", category: "Completed" },
    { name: "Removed", category: "Removed" },
  ],
  bug: [
    { name: "New", category: "Proposed" },
    { name: "Active", category: "InProgress" },
    { name: "Closed", category: "Completed" },
  ],
  task: [
    { name: "New", category: "Proposed" },
    { name: "Active", category: "InProgress" },
    { name: "Closed", category: "Completed" },
  ],
};

const FIELDS: Record<string, string[]> = {
  "user story": ["System.Title", "System.Description", "Microsoft.VSTS.Common.AcceptanceCriteria", "Microsoft.VSTS.Common.Priority"],
  bug: ["System.Title", "System.Description", "Microsoft.VSTS.TCM.ReproSteps", "Microsoft.VSTS.TCM.SystemInfo", "Microsoft.VSTS.Common.AcceptanceCriteria", "Microsoft.VSTS.Common.Severity", "Microsoft.VSTS.Common.Priority"],
  task: ["System.Title", "System.Description"],
};

/** The synthetic project: work items by id, changed by the PATCH routes. */
function world() {
  const items: Record<number, { rev: number; fields: Record<string, any>; relations?: { rel: string; url: string }[] }> = {
    101: {
      rev: 4,
      fields: {
        "System.WorkItemType": "User Story",
        "System.Title": "bench-a1b2c3 Export the orders report",
        "System.State": "Active",
        "System.AssignedTo": meIdentity,
        "System.AreaPath": "test-project\\Team A",
        "System.IterationPath": "test-project\\Sprint 3",
        "Microsoft.VSTS.Common.Priority": 2,
        "Microsoft.VSTS.Scheduling.StoryPoints": 5,
        "System.Tags": "export; reports",
        "System.Parent": 100,
        "WEF_X_Kanban.Column": "Review",
        "System.ChangedDate": "2026-11-26T10:00:00Z",
        "System.Description": "<p>As a planner, I want an export, so that I can share it.</p><h2>Technical notes</h2><p>Use the existing writer.</p>",
        "Microsoft.VSTS.Common.AcceptanceCriteria": "<ul><li>[ ] The file has a header</li></ul>",
      },
      relations: [
        { rel: "System.LinkTypes.Hierarchy-Reverse", url: `${ORG}/_apis/wit/workItems/100` },
        { rel: "System.LinkTypes.Hierarchy-Forward", url: `${ORG}/_apis/wit/workItems/201` },
        { rel: "System.LinkTypes.Hierarchy-Forward", url: `${ORG}/_apis/wit/workItems/202` },
        { rel: "System.LinkTypes.Related", url: `${ORG}/_apis/wit/workItems/103` },
        { rel: "ArtifactLink", url: "vstfs:///Git/Ref/p1%2Fr1%2FGBfeature%2F101-export" },
        { rel: "ArtifactLink", url: "vstfs:///Git/PullRequestId/p1%2Fr1%2F55" },
        { rel: "ArtifactLink", url: "vstfs:///Build/Build/900" },
      ],
    },
    100: { rev: 1, fields: { "System.WorkItemType": "Feature", "System.Title": "Reports", "System.State": "Active" } },
    103: { rev: 1, fields: { "System.WorkItemType": "Bug", "System.Title": "bench-a1b2c3 Header is missing", "System.State": "New" } },
    201: { rev: 2, fields: { "System.WorkItemType": "Task", "System.Title": "Write the export", "System.State": "Closed", "System.AssignedTo": meIdentity } },
    202: { rev: 3, fields: { "System.WorkItemType": "Task", "System.Title": "Test the export", "System.State": "New" } },
    301: {
      rev: 2,
      fields: {
        "System.WorkItemType": "Bug",
        "System.Title": "bench-a1b2c3 Totals are wrong",
        "System.State": "New",
        "System.AssignedTo": other,
        "System.AreaPath": "test-project\\Team A",
        "System.IterationPath": "test-project\\Sprint 3",
        "Microsoft.VSTS.Common.Severity": "2 - High",
        "System.ChangedDate": "2026-11-25T10:00:00Z",
        "Microsoft.VSTS.TCM.ReproSteps": "<p>The totals row adds VAT twice.</p><h2>Steps to reproduce</h2><ul><li>Open the report</li></ul>",
        "Microsoft.VSTS.TCM.SystemInfo": "<p>Browser: synthetic</p>",
      },
    },
  };
  let nextId = 500;
  const written: Call[] = [];
  const routes: Route[] = [
    { match: /\/_apis\/connectionData/, respond: () => ({ body: { authenticatedUser: ME } }) },
    { match: /\/_apis\/wit\/workitemtypes\/([^/]+)\/states/, respond: (c) => ({ body: { value: STATES[decodeURIComponent(/workitemtypes\/([^/]+)\/states/.exec(c.url)![1]).toLowerCase()] ?? [] } }) },
    {
      match: /\/_apis\/wit\/workitemtypes\/([^/]+)\/fields/,
      respond: (c) => {
        const t = decodeURIComponent(/workitemtypes\/([^/]+)\/fields/.exec(c.url)![1]).toLowerCase();
        return { body: { value: (FIELDS[t] ?? []).map((f) => ({ referenceName: f, ...(f.endsWith("Severity") ? { allowedValues: ["1 - Critical", "2 - High", "3 - Medium", "4 - Low"] } : {}) })) } };
      },
    },
    { match: /\/_apis\/wit\/workitemtypes\?/, respond: () => ({ body: { value: [{ name: "User Story" }, { name: "Bug" }, { name: "Task" }, { name: "Feature" }] } }) },
    { match: /Team%20A\/_apis\/work\/teamsettings\/teamfieldvalues/, respond: () => ({ body: { defaultValue: "test-project\\Team A", values: [{ value: "test-project\\Team A", includeChildren: true }] } }) },
    {
      match: /Team%20A\/_apis\/work\/teamsettings\/iterations/,
      respond: () => ({
        body: {
          value: [
            { id: "i2", name: "Sprint 2", path: "test-project\\Sprint 2", attributes: { timeFrame: "past" } },
            { id: "i3", name: "Sprint 3", path: "test-project\\Sprint 3", attributes: { startDate: "2026-11-23T00:00:00Z", finishDate: "2026-12-04T00:00:00Z", timeFrame: "current" } },
          ],
        },
      }),
    },
    { match: /Team%20A\/_apis\/work\/boards\?/, respond: () => ({ body: { value: [{ id: "b1", name: "Stories" }] } }) },
    {
      match: /Team%20A\/_apis\/work\/boards\/Stories\?/,
      respond: () => ({
        body: {
          columns: [
            { name: "New", columnType: "incoming", stateMappings: { "User Story": "New", Bug: "New" } },
            { name: "Active", columnType: "inProgress", itemLimit: 5, stateMappings: { "User Story": "Active", Bug: "Active" } },
            { name: "Review", columnType: "inProgress", stateMappings: { "User Story": "Active", Bug: "Active" } },
            { name: "Closed", columnType: "outgoing", stateMappings: { "User Story": "Closed", Bug: "Closed" } },
          ],
          fields: { columnField: { referenceName: "WEF_X_Kanban.Column" } },
        },
      }),
    },
    { method: "POST", match: /\/_apis\/wit\/wiql/, respond: (c) => ({ body: { workItems: (/\[System\.Id\] = (\d+)/.exec(c.body.query) ? [Number(/\[System\.Id\] = (\d+)/.exec(c.body.query)![1])] : [101, 301]).map((id) => ({ id })) } }) },
    {
      method: "POST",
      match: /\/_apis\/wit\/workitemsbatch/,
      respond: (c) => ({ body: { value: (c.body.ids as number[]).filter((i) => items[i]).map((i) => ({ id: i, fields: { "System.Id": i, "System.Rev": items[i].rev, ...items[i].fields } })) } }),
    },
    { match: /\/_apis\/wit\/workitems\/(\d+)\/updates/, respond: () => ({ body: { value: [{ rev: 4, revisedBy: { displayName: "Test User" }, fields: {} }, { rev: 5, revisedBy: { displayName: "Other Dev" }, fields: { "System.Title": { newValue: "x" }, "System.ChangedDate": { newValue: "2026-11-27T08:59:00Z" } } }] } }) },
    {
      match: /\/_apis\/wit\/workItems\/(\d+)\/comments\?/,
      respond: () => ({ body: { comments: [{ id: 7, text: "<p>Looks good</p>", createdBy: other, createdDate: "2026-11-26T11:00:00Z" }, { id: 8, text: "<p>gone</p>", isDeleted: true }] } }),
    },
    {
      method: "POST",
      match: /\/_apis\/wit\/workItems\/(\d+)\/comments\?/,
      respond: (c) => {
        written.push(c);
        return { body: { id: 9, text: c.body.text, createdDate: "2026-11-27T09:00:00Z" } };
      },
    },
    {
      match: /\/_apis\/wit\/workitems\/(\d+)\?/,
      respond: (c) => {
        const id = Number(/workitems\/(\d+)\?/.exec(c.url)![1]);
        const w = items[id];
        return w ? { body: { id, rev: w.rev, fields: { "System.Rev": w.rev, ...w.fields }, relations: w.relations ?? [] } } : { status: 404, body: { message: "not found" } };
      },
    },
    {
      method: "PATCH",
      match: /\/_apis\/wit\/workitems\/(\d+)\?/,
      respond: (c) => {
        written.push(c);
        const id = Number(/workitems\/(\d+)\?/.exec(c.url)![1]);
        const w = items[id];
        const test = (c.body as { op: string; path: string; value: unknown }[]).find((o) => o.op === "test" && o.path === "/rev");
        if (test && test.value !== w.rev) return { status: 412, body: { message: "TF26071: This work item has been changed by someone else since you opened it." } };
        for (const o of c.body as { op: string; path: string; value: any }[]) if (o.op === "add" && o.path.startsWith("/fields/")) w.fields[o.path.slice(8)] = o.value;
        w.rev += 1;
        return { body: { id, rev: w.rev, fields: w.fields } };
      },
    },
    {
      method: "POST",
      match: /\/_apis\/wit\/workitems\/\$([^?]+)\?/,
      respond: (c) => {
        written.push(c);
        const id = nextId++;
        const f: Record<string, any> = { "System.WorkItemType": decodeURIComponent(/\$([^?]+)\?/.exec(c.url)![1]), "System.State": "New" };
        for (const o of c.body as { op: string; path: string; value: any }[]) if (o.path.startsWith("/fields/")) f[o.path.slice(8)] = o.value;
        items[id] = { rev: 1, fields: f };
        return { body: { id, rev: 1, fields: f } };
      },
    },
    { match: /\/_apis\/git\/repositories\?/, respond: () => ({ body: { value: [{ id: "r1", name: "repo-a" }] } }) },
    { match: /\/_apis\/git\/repositories\/repo-a\?/, respond: () => ({ body: { id: "r1", project: { id: "p1" } } }) },
    { match: /\/_apis\/git\/repositories\/repo-a\/pullrequests\?/, respond: () => ({ body: { value: [{ pullRequestId: 56, title: "x", status: "active", sourceRefName: "refs/heads/feature/101-export", targetRefName: "refs/heads/main" }] } }) },
    { match: /\/_apis\/git\/pullrequests\/55\?/, respond: () => ({ body: { pullRequestId: 55, title: "Export the orders report", status: "active", isDraft: true, repository: { name: "repo-a" } } }) },
    { match: /\/_apis\/build\/builds\?/, respond: () => ({ body: { value: [{ id: 900, buildNumber: "20261126.1", status: "completed", result: "succeeded", definition: { name: "repo-a-ci" }, repository: { name: "repo-a" } }] } }) },
  ];
  return { items, routes, written };
}

function setup() {
  const w = world();
  const f = fakeFetch(w.routes);
  const { ctx, lines, errs } = ctxFor(tmp(), f.fn);
  ctx.env.AIHUB_ADO_ORG = "ferron-test";
  ctx.now = () => NOW;
  const empty = tmp("aihub-lookin-");
  writeLookIn(ctx.env, [empty]); // the scan of this PC stays inside an empty synthetic folder
  saveSettings(ctx.env, "ferron-test", { project: "test-project", team: "Team A" });
  return { ...w, ctx, lines, errs, calls: f.calls, empty, s: (refresh = false) => storiesOf(ctx, { refresh }) };
}

describe("story browser settings", () => {
  it("keeps the choice per organisation; without a project the answer is needsSetting", async () => {
    const { ctx, lines } = ctxFor(tmp(), fakeFetch([]).fn);
    ctx.env.AIHUB_ADO_ORG = "ferron-test";
    expect(() => storiesOf(ctx, {})).toThrow(/which project/);
    expect(await main(["stories", "list", "--view", "mine"], ctx)).toBe(1);
    expect(JSON.parse(lines[0]).error.kind).toBe("needsSetting");
    saveSettings(ctx.env, "Ferron-Test", { project: "test-project", team: " Team A ", areaPath: "" });
    expect(readSettings(ctx.env, "ferron-test")).toEqual({ project: "test-project", team: "Team A" });
    const s = storiesOf(ctx, {});
    expect(s.tc.remote.project).toBe("test-project");
    // another project on the command line does not take the saved team
    expect(storiesOf(ctx, { project: "test-project-agile" }).team).toBe("test-project-agile Team");
  });

  it("aihub stories settings --save writes and answers the choice with the types of the process", async () => {
    const t = setup();
    t.lines.length = 0;
    expect(await main(["stories", "settings", "--save", "--project", "test-project", "--team", "Team A", "--iteration", "test-project\\Sprint 3"], t.ctx)).toBe(0);
    expect(JSON.parse(t.lines[0])).toEqual({ org: "ferron-test", project: "test-project", team: "Team A", iterationPath: "test-project\\Sprint 3", types: ["User Story", "Bug"] });
  });
});

describe("story browser lists", () => {
  it("My work: assigned to me, not closed, in the project", async () => {
    const t = setup();
    const s = t.s();
    const q = await listWiql(s, { view: "mine" }, ["User Story", "Bug"]);
    expect(q).toContain("[System.AssignedTo] = @Me");
    expect(q).toContain("[System.WorkItemType] IN ('User Story', 'Bug')");
    expect(q).toContain("[System.State] NOT IN ('Closed', 'Removed')");
    expect(q).toContain("[System.TeamProject] = 'test-project'");
  });

  it("Current sprint: the team's current iteration and areas; Backlog: by stack rank; search on text or number", async () => {
    const t = setup();
    const s = t.s();
    const sprint = await listWiql(s, { view: "sprint" }, ["User Story"], "test-project\\Sprint 3");
    expect(sprint).toContain("[System.IterationPath] = 'test-project\\Sprint 3'");
    expect(sprint).toContain("([System.AreaPath] UNDER 'test-project\\Team A')");
    const backlog = await listWiql(s, { view: "backlog", search: "o'clock" }, ["User Story"]);
    expect(backlog).toContain("ORDER BY [Microsoft.VSTS.Common.StackRank] ASC");
    expect(backlog).toContain("[System.Title] CONTAINS 'o''clock'");
    expect(await listWiql(s, { view: "backlog", search: "#301" }, ["User Story"])).toMatch(/\[System\.Id\] = 301$/);
  });

  it("rows carry state category, who (isMe), tags, parent and the local links; the second read is cached until a write", async () => {
    const t = setup();
    // a set of story 101 and a clone with a branch of it, synthetic folders on this PC
    const setDir = join(t.empty, "101-export");
    mkdirSync(join(setDir, "repo-a", ".git"), { recursive: true });
    writeFileSync(join(setDir, "repo-a", ".git", "HEAD"), "ref: refs/heads/feature/101-export\n");
    writeFileSync(join(setDir, ".aihub-set.json"), JSON.stringify({ story: 101, branch: "feature/101-export", repos: [{ name: "repo-a", source: "x", path: join(setDir, "repo-a") }] }));
    const r = await storyList(t.s(), { view: "sprint" });
    expect(r.iterationPath).toBe("test-project\\Sprint 3");
    expect(r.types).toEqual(["User Story", "Bug"]);
    expect(r.cached).toBe(false);
    const [story, bug] = r.items;
    expect(story).toMatchObject({ id: 101, rev: 4, type: "User Story", state: "Active", stateCategory: "InProgress", priority: 2, storyPoints: 5, tags: ["export", "reports"], parent: 100, url: `${P}/_workitems/edit/101` });
    expect(story.assignedTo).toEqual({ name: "Test User", email: "test.user@example.test", isMe: true });
    expect(story.local.set?.folder).toBe(setDir);
    expect(story.local.branches[0]).toMatchObject({ repo: "repo-a", branch: "feature/101-export" });
    expect(bug).toMatchObject({ id: 301, severity: "2 - High", stateCategory: "Proposed" });
    expect(bug.assignedTo?.isMe).toBe(false);
    const n = t.calls.length;
    expect((await storyList(t.s(), { view: "sprint" })).cached).toBe(true);
    expect(t.calls.length).toBe(n);
    await storyComment(t.s(), { id: 101, markdown: "ok" });
    expect((await storyList(t.s(), { view: "sprint" })).cached).toBe(false);
  });

  it("a wrong view is badInput", async () => {
    const t = setup();
    t.lines.length = 0;
    expect(await main(["stories", "list", "--view", "all"], t.ctx)).toBe(1);
    expect(JSON.parse(t.lines[0]).error.kind).toBe("badInput");
  });
});

describe("story browser board", () => {
  it("columns per state of the team's board, items in the column of their state", async () => {
    const t = setup();
    const r = await storyBoard(t.s(), {});
    expect(r.board).toBe("Stories");
    expect(r.columns.map((c) => [c.name, c.states, c.isDone, c.items.map((x) => x.id)])).toEqual([
      ["New", ["New"], false, [301]],
      ["Active", ["Active"], false, []],
      ["Review", ["Active"], false, [101]],
      ["Closed", ["Closed"], true, []],
    ]);
    expect(r.columnField).toBe("WEF_X_Kanban.Column");
    expect(r.columns[1].wipLimit).toBe(5);
    const wiql = t.calls.find((c) => c.method === "POST" && /wiql/.test(c.url))!.body.query as string;
    expect(wiql).toContain("@Today - 14");
  });

  it("a move carries the revision; an old revision is a conflict, nothing is written", async () => {
    const t = setup();
    const ok = await storyMove(t.s(), { id: 301, to: "Active", rev: 2 });
    expect(ok).toMatchObject({ status: "saved", id: 301, rev: 3, state: "Active" });
    expect(t.written[0].body[0]).toEqual({ op: "test", path: "/rev", value: 2 });
    const again = await storyMove(t.s(), { id: 301, to: "Closed", rev: 2 });
    expect(again.status).toBe("conflict");
    expect(t.items[301].fields["System.State"]).toBe("Active");
  });

  it("a move to a column that shares its state sets the state and the board column", async () => {
    const t = setup();
    const r = await storyMove(t.s(), { id: 301, column: "review", rev: 2 });
    expect(r).toMatchObject({ status: "saved", state: "Active", column: "review" });
    expect(t.written[0].body.slice(1)).toEqual([
      { op: "add", path: "/fields/System.State", value: "Active" },
      { op: "add", path: "/fields/WEF_X_Kanban.Column", value: "Review" },
    ]);
    await expect(storyMove(t.s(), { id: 301, column: "Nope", rev: 3 })).rejects.toThrow(/no column 'Nope'/);
  });
});

describe("story browser item", () => {
  it("a story: template sections with their field, tasks with done, parent, related, development and comments", async () => {
    const t = setup();
    const r = await storyShow(t.s(), 101);
    expect(r.sections.map((x) => [x.heading, x.field])).toEqual([
      ["Description", "System.Description"],
      ["Acceptance criteria", "Microsoft.VSTS.Common.AcceptanceCriteria"],
      ["Technical notes", "System.Description"],
      ["Out of scope", "System.Description"],
    ]);
    expect(r.sections[0].markdown).toBe("As a planner, I want an export, so that I can share it.");
    expect(r.sections[1].markdown).toBe("- [ ] The file has a header");
    expect(r.sections[2].markdown).toBe("Use the existing writer.");
    expect(r.tasks).toEqual([
      { id: 201, rev: 2, title: "Write the export", state: "Closed", done: true, assignedTo: { name: "Test User", email: "test.user@example.test", isMe: true } },
      { id: 202, rev: 3, title: "Test the export", state: "New", done: false, assignedTo: null },
    ]);
    expect(r.parentItem).toMatchObject({ id: 100, type: "Feature", title: "Reports" });
    expect(r.related.map((x) => x.id)).toEqual([103]);
    expect(r.children).toEqual([]);
    expect(r.development.branches).toEqual([{ repo: "repo-a", branch: "feature/101-export", url: `${P}/_git/repo-a?version=GBfeature%2F101-export` }]);
    expect(r.development.prs).toEqual([{ repo: "repo-a", id: 55, title: "Export the orders report", status: "active", isDraft: true, url: `${P}/_git/repo-a/pullrequest/55` }]);
    expect(r.development.builds[0]).toMatchObject({ id: 900, repo: "repo-a", pipeline: "repo-a-ci", result: "succeeded" });
    expect(r.comments).toEqual([{ id: 7, author: { name: "Other Dev", email: "other.dev@example.test", isMe: false }, date: "2026-11-26T11:00:00Z", markdown: "Looks good", html: "<p>Looks good</p>" }]);
    expect(r.allowedStates.map((x) => x.name)).toContain("Resolved");
    expect(r.systemInfo).toBeUndefined();
    expect(r.storyPoints).toBe(5);
  });

  it("a Bug: text in ReproSteps, System Info and the Severity values", async () => {
    const t = setup();
    const r = await storyShow(t.s(), 301);
    expect(r.sections.map((x) => [x.heading, x.field])).toEqual([
      ["Description", "Microsoft.VSTS.TCM.ReproSteps"],
      ["Steps to reproduce", "Microsoft.VSTS.TCM.ReproSteps"],
      ["Expected result", "Microsoft.VSTS.TCM.ReproSteps"],
      ["Actual result", "Microsoft.VSTS.TCM.ReproSteps"],
    ]);
    expect(r.sections[0].markdown).toBe("The totals row adds VAT twice.");
    expect(r.sections[1].markdown).toBe("- Open the report");
    expect(r.systemInfo).toEqual({ markdown: "Browser: synthetic", html: "<p>Browser: synthetic</p>" });
    expect(r.severityValues).toEqual(["1 - Critical", "2 - High", "3 - Medium", "4 - Low"]);
  });

  it("reads the branch, PR and build links of a work item", () => {
    expect(artifactLinks([{ rel: "ArtifactLink", url: "vstfs:///Git/Ref/p%2FR1%2FGBbugfix%2F3-x" }, { rel: "ArtifactLink", url: "vstfs:///Build/Build/4" }, { rel: "Related", url: "x" }])).toEqual({ branches: [{ repoId: "r1", branch: "bugfix/3-x" }], prs: [], builds: [4] });
  });
});

describe("story browser edits", () => {
  it("edit writes only the changed fields, with the revision test; the other sections of the description stay", async () => {
    const t = setup();
    const r = await storyEdit(t.s(), { id: 101, rev: 4, title: "bench-a1b2c3 Export the orders report", priority: 1, sections: "## Description\n\nAs a planner, I want a CSV export, so that I can share it.\n" });
    expect(r).toMatchObject({ status: "saved", id: 101, rev: 5, changed: ["Microsoft.VSTS.Common.Priority", "System.Description"] });
    const ops = t.written[0].body as { op: string; path: string; value: any }[];
    expect(ops[0]).toEqual({ op: "test", path: "/rev", value: 4 });
    expect(ops.map((o) => o.path)).toEqual(["/rev", "/fields/Microsoft.VSTS.Common.Priority", "/fields/System.Description"]);
    const desc = ops[2].value as string;
    expect(desc).toContain("CSV export");
    expect(desc).toContain("<h2>Technical notes</h2><p>Use the existing writer.</p>");
  });

  it("someone saved in between: status conflict with the current version and their changes; nothing written", async () => {
    const t = setup();
    t.items[101].rev = 6;
    const r = await storyEdit(t.s(), { id: 101, rev: 4, title: "mine" });
    expect(r.status).toBe("conflict");
    if (r.status !== "conflict") return;
    expect(r).toMatchObject({ id: 101, yourRev: 4, rev: 6 });
    expect(r.current.title).toBe("bench-a1b2c3 Export the orders report");
    expect(r.theirChanges).toEqual([{ rev: 5, by: "Other Dev", date: "2026-11-27T08:59:00Z", fields: ["System.Title"] }]);
    expect(t.written).toEqual([]);
  });

  it("the revision test fails on the server (a save at the same moment): also a conflict", async () => {
    const t = setup();
    const s = t.s();
    const orig = t.items[101];
    // the read sees rev 4, the server has 5 by the time the patch arrives
    let first = true;
    const route = t.routes.find((r) => r.method === "PATCH")!;
    const respond = route.respond;
    route.respond = (c) => {
      if (first) {
        first = false;
        orig.rev = 5;
      }
      return respond(c);
    };
    const r = await storyEdit(s, { id: 101, rev: 4, priority: 1 });
    expect(r.status).toBe("conflict");
  });

  it("ticking a task sets the Completed state of Task; unticking the Proposed one", async () => {
    const t = setup();
    expect(await storyTask(t.s(), { id: 202, done: true })).toMatchObject({ status: "saved", state: "Closed" });
    expect(t.items[202].fields["System.State"]).toBe("Closed");
    expect(await storyTask(t.s(), { id: 201, done: false, rev: 2 })).toMatchObject({ status: "saved", state: "New" });
    expect(await storyTask(t.s(), { id: 201, done: false, rev: 1 })).toMatchObject({ status: "saved", changed: [] });
  });

  it("a comment is posted as HTML", async () => {
    const t = setup();
    const r = await storyComment(t.s(), { id: 101, markdown: "Checked:\n- header" });
    expect(t.written[0].body).toEqual({ text: "<p>Checked:</p><ul><li>header</li></ul>" });
    expect(r.comment.id).toBe(9);
    await expect(storyComment(t.s(), { id: 101, markdown: " " })).rejects.toThrow(/empty/);
  });
});

describe("story browser refine", () => {
  it("asks the agent for a proposal file, shows it per part and writes only the chosen parts", async () => {
    const t = setup();
    const ask = await refineAsk(t.s(), 101);
    expect(ask.gaps).toEqual(["Out of scope"]);
    expect(ask.prompt).toContain(ask.proposalFile);
    expect(ask.prompt).toContain("do not change the work item");
    writeFileSync(ask.proposalFile, "## Description\n\nAs a planner, I want a CSV export.\n\n## Acceptance criteria\n\n- [ ] The file has a header\n- [ ] Dates are ISO\n\n## Tasks\n\n- Write the export\n- Document the export\n");
    const p = await refineRead(t.s(), 101);
    expect(p.parts.map((x) => [x.part, x.changed])).toEqual([
      ["description", true],
      ["criteria", true],
      ["tasks", true],
    ]);
    expect(p.tasks.new).toEqual(["Document the export"]);
    expect(t.written).toEqual([]); // reading a proposal writes nothing
    const r = await refineApply(t.s(), { id: 101, rev: 4, parts: ["criteria", "tasks"] });
    expect(r).toMatchObject({ status: "saved", applied: ["criteria", "tasks"], tasksCreated: [500] });
    const patch = t.written[0].body as { path: string; value: string }[];
    expect(patch.map((o) => o.path)).toEqual(["/rev", "/fields/Microsoft.VSTS.Common.AcceptanceCriteria"]);
    expect(t.items[101].fields["System.Description"]).toContain("I want an export"); // not chosen: untouched
    const task = t.written[1];
    expect(task.url).toContain("/_apis/wit/workitems/$Task?");
    expect(task.body).toContainEqual({ op: "add", path: "/fields/System.AreaPath", value: "test-project\\Team A" });
  });

  it("without a proposal: notFound; parts map to description, criteria, tasks", async () => {
    const t = setup();
    await expect(refineRead(t.s(), 202)).rejects.toThrow(/no proposal yet/);
    expect([partOf("Acceptatiecriteria"), partOf("Omschrijving"), partOf("Taken"), partOf("Risks")]).toEqual(["criteria", "description", "tasks", "Risks"]);
  });
});

describe("story browser new and link", () => {
  it("a new Bug: ReproSteps from the template sections, System Info, severity, current sprint, parent, assigned to me", async () => {
    const t = setup();
    const r = await storyNew(t.s(), { type: "bug", title: "bench-a1b2c3 Totals", sections: "## Description\n\nWrong totals.\n\n## Steps to reproduce\n\n1. Open\n", systemInfo: "Synthetic browser", severity: "3 - Medium", parent: 101, iterationPath: "current", assign: "me" });
    expect(r).toMatchObject({ id: 500, type: "Bug", url: `${P}/_workitems/edit/500` });
    const ops = t.written[0].body as { path: string; value: any }[];
    const v = (p: string) => ops.find((o) => o.path === p)?.value;
    expect(v("/fields/Microsoft.VSTS.TCM.ReproSteps")).toContain("Wrong totals.");
    expect(v("/fields/Microsoft.VSTS.TCM.ReproSteps")).toContain("<h2>Steps to reproduce</h2>");
    expect(v("/fields/System.Description")).toBeUndefined();
    expect(v("/fields/Microsoft.VSTS.TCM.SystemInfo")).toBe("<p>Synthetic browser</p>");
    expect(v("/fields/Microsoft.VSTS.Common.Severity")).toBe("3 - Medium");
    expect(v("/fields/System.IterationPath")).toBe("test-project\\Sprint 3");
    expect(v("/fields/System.AreaPath")).toBe("test-project\\Team A");
    expect(v("/fields/System.AssignedTo")).toBe("test.user@example.test");
    expect(ops.find((o) => o.path === "/relations/-")?.value.rel).toBe("System.LinkTypes.Hierarchy-Reverse");
  });

  it("a new story: 'story' is the process's story type", async () => {
    const t = setup();
    expect((await storyNew(t.s(), { type: "story", title: "bench-a1b2c3 New" })).type).toBe("User Story");
    expect(t.written[0].url).toContain("/$User%20Story?");
  });

  it("links the branches of a set and their active PR to the story", async () => {
    const t = setup();
    const set = tmp("aihub-set-");
    writeFileSync(join(set, ".aihub-set.json"), JSON.stringify({ story: 101, branch: "feature/101-export", repos: [{ name: "repo-a", source: "x", path: join(set, "repo-a") }] }));
    const r = await storyLink(t.s(), { id: 202, set });
    expect(r.linked).toEqual([{ repo: "repo-a", branch: "feature/101-export", added: true }]);
    expect(r.prs).toEqual([{ repo: "repo-a", id: 56, added: true }]);
    expect(t.written.map((c) => c.body[0].value.url)).toEqual(["vstfs:///Git/Ref/p1%2Fr1%2FGBfeature%2F101-export", "vstfs:///Git/PullRequestId/p1%2Fr1%2F56"]);
  });

  it("a fix branch is bugfix/<id>-<slug>, unless team.yaml names a pattern; a draft file reads as sections", () => {
    const t = setup();
    const s = t.s();
    expect(fixBranchName(s, 301, "Totals are wrong!")).toBe("bugfix/301-totals-are-wrong");
    s.teamCfg = { branches: { bugfix: "fix/{storyId}" } as never };
    expect(fixBranchName(s, 301, "x")).toBe("fix/301");
    const f = join(tmp(), "draft.md");
    writeFileSync(f, "## Description\n\nA\n\n## Acceptance criteria\n\n- [ ] B\n");
    expect(storyDraft(f).sections).toEqual([
      { heading: "Description", markdown: "A" },
      { heading: "Acceptance criteria", markdown: "- [ ] B" },
    ]);
  });

  it("the CLI answers JSON for every sub and the usage for an unknown one", async () => {
    const t = setup();
    t.lines.length = 0;
    expect(await main(["stories", "show", "--id", "301"], t.ctx)).toBe(0);
    expect(JSON.parse(t.lines[0]).type).toBe("Bug");
    t.lines.length = 0;
    expect(await main(["stories", "task", "--id", "202"], t.ctx)).toBe(1);
    expect(JSON.parse(t.lines[0]).error).toEqual({ kind: "badInput", message: "pass --done or --undone" });
    expect(await main(["stories", "nope"], t.ctx)).toBe(1);
  });
});
