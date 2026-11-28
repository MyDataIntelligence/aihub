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
import { storyComment, storyEdit, storyForm, storyMove, storyNew, storyTask } from "../src/lib/stories/write.js";
import { ctxFor, fakeFetch, tmp } from "./helpers.js";
import { P, setup } from "./storiesWorld.js";


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

  it("rows carry their board column of the team (columns share a state) and the list says how many match", async () => {
    const t = setup();
    const r = await storyList(t.s(), { view: "sprint", top: 1 });
    expect(r.total).toBe(2);
    expect(r.items.map((x) => x.id)).toEqual([101]);
    expect([r.items[0].boardColumn, r.items[0].boardColumnDone]).toEqual(["Review", false]);
    const all = await storyList(t.s(), { view: "backlog" });
    expect(all.items.find((x) => x.id === 301)).toMatchObject({ state: "New", boardColumn: "New", boardColumnDone: true });
    const show = await storyShow(t.s(), 101);
    expect(show.boardColumn).toBe("Review");
  });

  it("a saved area that is the project root counts as no choice: the team's areas are used", async () => {
    const t = setup();
    saveSettings(t.ctx.env, "ferron-test", { project: "test-project", team: "Team A", areaPath: "test-project" });
    expect(await listWiql(t.s(), { view: "backlog" }, ["User Story"])).toContain("([System.AreaPath] UNDER 'test-project\\Team A')");
    saveSettings(t.ctx.env, "ferron-test", { project: "test-project", team: "Team A", areaPath: "test-project\\Team A\\Orders" });
    expect(await listWiql(t.s(), { view: "backlog" }, ["User Story"])).toContain("[System.AreaPath] UNDER 'test-project\\Team A\\Orders'");
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
    expect(r.columns.map((c) => c.count)).toEqual([1, 0, 1, 0]);
    expect(r.columns[2].items[0]).toMatchObject({ id: 101, boardColumn: "Review", boardColumnDone: false });
    expect(r.columns[0].items[0]).toMatchObject({ id: 301, boardColumn: "New", boardColumnDone: true });
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

describe("an item in another project than the saved one", () => {
  it("show, prompt render and criteria use the item's own project for the link, the project and the iteration", async () => {
    const t = setup(); // saved: test-project
    t.lines.length = 0;
    expect(await main(["stories", "show", "--id", "401"], t.ctx)).toBe(0);
    const show = JSON.parse(t.lines[0]);
    expect(show.url).toBe("https://dev.azure.com/ferron-test/test-project-agile/_workitems/edit/401");
    expect(show.iterationPath).toBe("test-project-agile\\Iteration 1");
    t.lines.length = 0;
    expect(await main(["prompt", "render", "story-run", "--id", "401", "--json"], t.ctx)).toBe(0);
    const r = JSON.parse(t.lines[0]);
    expect(r.text).toContain("in test-project-agile");
    expect(r.text).toContain("https://dev.azure.com/ferron-test/test-project-agile/_workitems/edit/401");
    expect(r.text).not.toContain("/test-project/_workitems/edit/401");
    // and the other way round: the saved project is the agile one, the item lives in test-project
    saveSettings(t.ctx.env, "ferron-test", { project: "test-project-agile" });
    t.lines.length = 0;
    expect(await main(["prompt", "render", "story-run", "--id", "101", "--json"], t.ctx)).toBe(0);
    expect(JSON.parse(t.lines[0]).text).toContain("https://dev.azure.com/ferron-test/test-project/_workitems/edit/101");
    // a write goes to the item's project too
    t.lines.length = 0;
    expect(await main(["stories", "move", "--id", "401", "--to", "Active", "--rev", "3"], t.ctx)).toBe(0);
    expect(t.written.at(-1)!.url).toContain("/test-project-agile/_apis/wit/workitems/401?");
  });
});


describe("the form of a type", () => {
  it("says whether the process of the project has that type (a Basic process has no Bug), so New Bug from This File can hide itself", async () => {
    const t = setup();
    expect((await storyForm(t.s(), { type: "Bug" })).typeExists).toBe(true);
    const basic = setup();
    basic.routes.unshift({ match: /\/_apis\/wit\/workitemtypes\?/, respond: () => ({ body: { value: [{ name: "Epic" }, { name: "Issue" }, { name: "Task" }] } }) });
    expect((await storyForm(basic.s(), { type: "Bug" })).typeExists).toBe(false);
  });
});
