import { join } from "node:path";
import { writeLookIn } from "../src/lib/machineScan.js";
import { saveSettings, storiesOf } from "../src/lib/stories/core.js";
import { ctxFor, fakeFetch, tmp, type Call, type Route } from "./helpers.js";

/** The synthetic project of the story browser tests (test-project, team "Team A"): work items, states, fields, board. */
export const ORG = "https://dev.azure.com/ferron-test";
export const P = `${ORG}/test-project`;
export const NOW = Date.parse("2026-11-27T09:00:00Z");
export const ME = { id: "me-id", providerDisplayName: "Test User", properties: { Account: { $value: "test.user@example.test" } } };
export const meIdentity = { displayName: "Test User", uniqueName: "test.user@example.test", id: "me-id" };
export const other = { displayName: "Other Dev", uniqueName: "other.dev@example.test", id: "o-id" };

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
export function world() {
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
    401: {
      rev: 3,
      fields: {
        "System.TeamProject": "test-project-agile",
        "System.WorkItemType": "User Story",
        "System.Title": "bench-a1b2c3 Story in the other project",
        "System.State": "New",
        "System.AreaPath": "test-project-agile",
        "System.IterationPath": "test-project-agile\\Iteration 1",
        "System.ChangedDate": "2026-11-28T10:00:00Z",
        "System.Description": "<p>As a planner, I want a second project.</p>",
      },
    },
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
        "WEF_X_Kanban.Column": "New",
        "WEF_X_Kanban.Column.Done": true,
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
    // the organisation-level read of an item's own project (ids are unique in the organisation)
    {
      match: /^https:\/\/dev\.azure\.com\/ferron-test\/_apis\/wit\/workitems\/(\d+)\?/,
      respond: (c) => {
        const id = Number(/workitems\/(\d+)\?/.exec(c.url)![1]);
        return items[id] ? { body: { id, fields: { "System.TeamProject": items[id].fields["System.TeamProject"] ?? "test-project" } } } : { status: 404, body: { message: "not found" } };
      },
    },
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
          fields: { columnField: { referenceName: "WEF_X_Kanban.Column" }, doneField: { referenceName: "WEF_X_Kanban.Column.Done" } },
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

export function setup() {
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

