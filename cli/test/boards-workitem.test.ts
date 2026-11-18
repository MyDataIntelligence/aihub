import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, type Route } from "./helpers.js";

const NL = String.fromCharCode(10);
const wi = (id: number, fields: object = {}, relations: object[] = []) => ({ id, fields: { "System.Id": id, "System.WorkItemType": "User Story", "System.State": "Active", "System.Title": `Story ${id}`, "System.AreaPath": "test-project", "System.IterationPath": "test-project\\Sprint 1", ...fields }, relations });

describe("aihub workitem (administration)", () => {
  it("shows a work item with links, pull requests and attachments, descriptions as plain text", async () => {
    const { dir } = makeRepo();
    const w = wi(12, { "System.Description": "<div>Export <b>totals</b></div><div>as CSV</div>", "System.Tags": "csv; export", "System.AssignedTo": { displayName: "Ann" } }, [
      { rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://dev.azure.com/ferron-org/_apis/wit/workItems/3" },
      { rel: "ArtifactLink", url: "vstfs:///Git/PullRequestId/p%2Fr%2F7" },
      { rel: "AttachedFile", url: "https://dev.azure.com/ferron-org/_apis/wit/attachments/x", attributes: { name: "shot.png" } },
    ]);
    const { ctx, lines } = ctxFor(dir, fakeFetch([{ match: /wit\/workitems\/12\?/, respond: () => ({ body: w }) }]).fn);
    expect(await main(["workitem", "get", "--id", "AB#12"], ctx)).toBe(0);
    const out = lines.join(NL);
    expect(out).toContain("AB#12 User Story [Active] Story 12");
    expect(out).toContain("assigned Ann; area test-project; iteration test-project\\Sprint 1; tags csv; export");
    expect(out).toContain("links parent AB#3");
    expect(out).toContain("pull requests !7");
    expect(out).toContain("attachments shot.png");
    expect(out).toContain("Export totals");
  });

  it("updates fields by short name, reads a value from a file, and dry-run changes nothing", async () => {
    const { dir } = makeRepo();
    const patches: any[] = [];
    const r: Route[] = [{ method: "PATCH", match: /wit\/workitems\/12\?/, respond: (c) => (patches.push(c.body), { body: {} }) }];
    const f = join(dir, "d.md");
    writeFileSync(f, "new description");
    expect(await main(["workitem", "update", "--id", "12", "--field", "title=New title", "--field", "priority=1", "--field", `description=@${f}`], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(patches[0]).toEqual([
      { op: "add", path: "/fields/System.Title", value: "New title" },
      { op: "add", path: "/fields/Microsoft.VSTS.Common.Priority", value: "1" },
      { op: "add", path: "/fields/System.Description", value: "new description" },
    ]);
    patches.length = 0;
    expect(await main(["workitem", "update", "--id", "12", "--field", "title=x", "--dry-run"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(patches).toEqual([]);
    const bad = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["workitem", "update", "--id", "12"], bad.ctx)).toBe(1);
    expect(bad.errs.join(NL)).toContain("at least one --field");
  });

  it("comments, lists comments and history", async () => {
    const { dir } = makeRepo();
    const posted: any[] = [];
    const r: Route[] = [
      { method: "POST", match: /wit\/workItems\/12\/comments\?/, respond: (c) => (posted.push([c.url, c.body]), { body: {} }) },
      { match: /wit\/workItems\/12\/comments\?/, respond: () => ({ body: { comments: [{ id: 1, text: "<div>looks good</div>", createdBy: { displayName: "Ann" }, createdDate: "2026-11-10T10:00:00Z" }] } }) },
      { match: /wit\/workItems\/12\/updates\?/, respond: () => ({ body: { value: [{ rev: 2, revisedBy: { displayName: "Bob" }, revisedDate: "2026-11-11T09:00:00Z", fields: { "System.State": { oldValue: "New", newValue: "Active" }, "System.Rev": { oldValue: 1, newValue: 2 } } }] } }) },
    ];
    expect(await main(["workitem", "comment", "--id", "12", "--text", "hello"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(posted[0][1]).toEqual({ text: "hello" });
    expect(posted[0][0]).toContain("api-version=7.1-preview.4");
    const l = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["workitem", "comments", "--id", "12"], l.ctx)).toBe(0);
    expect(l.lines.join(NL)).toContain("#1 2026-11-10 Ann: looks good");
    const h = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["workitem", "history", "--id", "12"], h.ctx)).toBe(0);
    expect(h.lines.join(NL)).toBe("r2 2026-11-11 Bob | State: New -> Active");
  });

  it("links and unlinks by type, and adds and removes tags without duplicates", async () => {
    const { dir } = makeRepo();
    const patches: any[] = [];
    const r: Route[] = [
      { match: /wit\/workitems\/12\?.*relations/, respond: () => ({ body: wi(12, {}, [{ rel: "System.LinkTypes.Related", url: "https://x/_apis/wit/workItems/5" }, { rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://x/_apis/wit/workItems/3" }]) }) },
      { match: /wit\/workitems\/12\?.*fields=System\.Tags/, respond: () => ({ body: wi(12, { "System.Tags": "a; B" }) }) },
      { method: "PATCH", match: /wit\/workitems\/12\?/, respond: (c) => (patches.push(c.body), { body: {} }) },
    ];
    expect(await main(["workitem", "link", "--id", "12", "--type", "parent", "--to", "AB#3"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(patches[0]).toEqual([{ op: "add", path: "/relations/-", value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://dev.azure.com/ferron-org/_apis/wit/workItems/3", attributes: { comment: "" } } }]);
    expect(await main(["workitem", "unlink", "--id", "12", "--type", "parent", "--to", "3"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(patches[1]).toEqual([{ op: "remove", path: "/relations/1" }]);
    const bad = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["workitem", "unlink", "--id", "12", "--type", "child", "--to", "3"], bad.ctx)).toBe(1);
    expect(await main(["workitem", "tag", "--id", "12", "--tags", "b,c"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(patches[2]).toEqual([{ op: "add", path: "/fields/System.Tags", value: "a; B; c" }]);
    expect(await main(["workitem", "untag", "--id", "12", "--tags", "A"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(patches[3]).toEqual([{ op: "add", path: "/fields/System.Tags", value: "B" }]);
  });

  it("attaches a file, lists and downloads attachments, deletes with --yes and restores", async () => {
    const { dir } = makeRepo();
    const patches: any[] = [];
    let del = 0;
    const att = "https://dev.azure.com/ferron-org/_apis/wit/attachments/abc?fileName=shot.png";
    const r: Route[] = [
      { method: "POST", match: /wit\/attachments\?/, respond: () => ({ body: { url: att } }) },
      { method: "PATCH", match: /wit\/workitems\/12\?/, respond: (c) => (patches.push(c.body), { body: {} }) },
      { match: /wit\/workitems\/12\?.*relations/, respond: () => ({ body: wi(12, {}, [{ rel: "AttachedFile", url: att, attributes: { name: "shot.png", resourceSize: 4096 } }]) }) },
      { match: /wit\/attachments\/abc/, respond: () => ({ text: "PNGDATA" }) },
      { method: "DELETE", match: /wit\/workitems\/12\?/, respond: () => (del++, { body: {} }) },
      { method: "PATCH", match: /wit\/recyclebin\/12\?/, respond: (c) => (patches.push(c.body), { body: {} }) },
    ];
    const img = join(dir, "shot.png");
    writeFileSync(img, "PNGDATA");
    expect(await main(["workitem", "attach", "--id", "12", "--file", img, "--comment", "screen"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(patches[0]).toEqual([{ op: "add", path: "/relations/-", value: { rel: "AttachedFile", url: att, attributes: { comment: "screen", name: "shot.png" } } }]);
    const l = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["workitem", "attachments", "--id", "12"], l.ctx)).toBe(0);
    expect(l.lines.join(NL)).toMatch(/shot\.png\s+4 KB/);
    const out = join(dir, "dl");
    expect(await main(["workitem", "attachments", "--id", "12", "--download", "shot.png", "--out", out], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(existsSync(join(out, "shot.png"))).toBe(true);
    expect(readFileSync(join(out, "shot.png"), "utf8")).toBe("PNGDATA");
    expect(await main(["workitem", "delete", "--id", "12"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(1);
    expect(del).toBe(0);
    expect(await main(["workitem", "delete", "--id", "12", "--yes"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(del).toBe(1);
    expect(await main(["workitem", "restore", "--id", "12"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(patches[1]).toEqual({ IsDeleted: false });
  });
});

describe("aihub boards", () => {
  it("runs WIQL (inline, saved, mine) and lists work items with their fields", async () => {
    const { dir } = makeRepo();
    const queries: string[] = [];
    const r: Route[] = [
      { method: "POST", match: /_apis\/wit\/wiql\?/, respond: (c) => (queries.push(c.body.query), { body: { workItems: [{ id: 2 }, { id: 1 }] } }) },
      { method: "POST", match: /_apis\/wit\/workitemsbatch\?/, respond: () => ({ body: { value: [{ fields: { "System.Id": 1, "System.WorkItemType": "Bug", "System.State": "New", "System.Title": "one" } }, { fields: { "System.Id": 2, "System.WorkItemType": "Task", "System.State": "Doing", "System.Title": "two", "System.AssignedTo": { displayName: "Ann" } } }] } }) },
      { match: /_apis\/wit\/queries\/Shared%20Queries\/Open\?|_apis\/wit\/queries\/Shared Queries\/Open\?/, respond: () => ({ body: { id: "q1", name: "Open", wiql: "SELECT [System.Id] FROM WorkItems WHERE [System.State] = 'Active'" } }) },
    ];
    const a = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["boards", "query", "run", "--wiql", "SELECT [System.Id] FROM WorkItems"], a.ctx)).toBe(0);
    expect(a.lines.join(NL)).toContain("2 work item(s)");
    expect(a.lines.join(NL).indexOf("AB#2")).toBeLessThan(a.lines.join(NL).indexOf("AB#1")); // WIQL order is kept
    expect(a.lines.join(NL)).toContain("(Ann)");
    expect(await main(["boards", "query", "run", "--saved", "Open"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(queries[1]).toContain("[System.State] = 'Active'");
    expect(await main(["boards", "query", "run", "--mine"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(queries[2]).toContain("@Me");
    const bad = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["boards", "query", "run", "--wiql", "DELETE everything"], bad.ctx)).toBe(1);
    expect(bad.errs.join(NL)).toContain("starts with SELECT");
  });

  it("lists sprints for the default team, items of the current sprint and capacity", async () => {
    const { dir } = makeRepo();
    const urls: string[] = [];
    const r: Route[] = [
      { match: /test-project\/test-project%20Team\/_apis\/work\/teamsettings\/iterations\/it1\/workitems\?/, respond: (c) => (urls.push(c.url), { body: { workItemRelations: [{ target: { id: 7 } }] } }) },
      { match: /test-project\/test-project%20Team\/_apis\/work\/teamsettings\/iterations\/it1\/capacities\?/, respond: () => ({ body: { totalCapacityPerDay: 12, teamMembers: [{ teamMember: { id: "m1", displayName: "Ann" }, activities: [{ capacityPerDay: 6, name: "Development" }], daysOff: [{ start: "x", end: "y" }] }] } }) },
      { match: /test-project\/test-project%20Team\/_apis\/work\/teamsettings\/iterations\?/, respond: () => ({ body: { value: [{ id: "it0", name: "Sprint 0", path: "p\\S0", attributes: { startDate: "2026-10-01T00:00:00Z", finishDate: "2026-10-14T00:00:00Z", timeFrame: "past" } }, { id: "it1", name: "Sprint 1", path: "p\\S1", attributes: { startDate: "2026-11-01T00:00:00Z", finishDate: "2026-11-14T00:00:00Z", timeFrame: "current" } }] } }) },
      { method: "POST", match: /_apis\/wit\/workitemsbatch\?/, respond: () => ({ body: { value: [{ fields: { "System.Id": 7, "System.WorkItemType": "Task", "System.State": "Doing", "System.Title": "in sprint" } }] } }) },
    ];
    const l = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["boards", "sprint", "list"], l.ctx)).toBe(0);
    expect(l.lines.join(NL)).toMatch(/Sprint 1\s+2026-11-01\s+2026-11-14\s+current/);
    const i = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["boards", "sprint", "items"], i.ctx)).toBe(0);
    expect(i.lines.join(NL)).toContain("Sprint 1: 1 work item(s)");
    expect(i.lines.join(NL)).toContain("AB#7 Task");
    const c = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["boards", "capacity", "show"], c.ctx)).toBe(0);
    expect(c.lines.join(NL)).toContain("Sprint 1: 12 h/day in total");
    expect(c.lines.join(NL)).toContain("Ann");
  });

  it("creates areas and iterations as classification nodes, shows boards and backlogs, and aliases item actions", async () => {
    const { dir } = makeRepo();
    const posted: any[] = [];
    const r: Route[] = [
      { method: "POST", match: /wit\/classificationnodes\/(areas|iterations)(\/[^?]*)?\?/, respond: (c) => (posted.push([c.url.replace(/.*classificationnodes/, "").split("?")[0], c.body]), { body: {} }) },
      { match: /wit\/classificationnodes\/areas\?/, respond: () => ({ body: { name: "test-project", children: [{ name: "Team A" }] } }) },
      { match: /_apis\/work\/boards\/b1\?/, respond: () => ({ body: { columns: [{ name: "New", stateMappings: { "User Story": "New" } }, { name: "Active", itemLimit: 3, stateMappings: { "User Story": "Active" } }], rows: [{ name: "" }] } }) },
      { match: /_apis\/work\/boards\?/, respond: () => ({ body: { value: [{ id: "b1", name: "Stories" }] } }) },
      { match: /_apis\/work\/backlogs\?/, respond: () => ({ body: { value: [{ id: "Microsoft.RequirementCategory", name: "Stories", workItemTypes: [{ name: "User Story" }] }] } }) },
      { method: "PATCH", match: /wit\/workitems\/12\?/, respond: (c) => (posted.push(["wi", c.body]), { body: {} }) },
      { match: /wit\/workitems\/12\?.*fields=System\.Tags/, respond: () => ({ body: wi(12, { "System.Tags": "" }) }) },
    ];
    expect(await main(["boards", "areas", "create", "--name", "Team B", "--parent", "Team A"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(posted[0]).toEqual(["/areas/Team%20A", { name: "Team B" }]);
    expect(await main(["boards", "iterations", "create", "--name", "Sprint 9", "--start", "2026-12-01", "--finish", "2026-12-14"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(posted[1]).toEqual(["/iterations", { name: "Sprint 9", attributes: { startDate: "2026-12-01", finishDate: "2026-12-14" } }]);
    const a = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["boards", "areas", "list"], a.ctx)).toBe(0);
    expect(a.lines.join(NL)).toBe(["test-project", "  Team A"].join(NL));
    const b = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["boards", "show", "--board", "Stories"], b.ctx)).toBe(0);
    expect(b.lines.join(NL)).toContain("Active (WIP 3) [Active]");
    const bl = ctxFor(dir, fakeFetch(r).fn);
    expect(await main(["boards", "backlog"], bl.ctx)).toBe(0);
    expect(bl.lines.join(NL)).toContain("Stories: User Story");
    expect(await main(["boards", "tag", "--id", "12", "--tags", "x"], ctxFor(dir, fakeFetch(r).fn).ctx)).toBe(0);
    expect(posted[2]).toEqual(["wi", [{ op: "add", path: "/fields/System.Tags", value: "x" }]]);
  });
});
