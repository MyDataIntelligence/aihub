import { describe, expect, it } from "vitest";
import { DEFAULT_LAYOUT, layoutFor } from "../src/lib/fieldLayout.js";
import { devopsTemplateText } from "../src/lib/workItemTemplate.js";
import { commands, main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, tmp, write, type Route } from "./helpers.js";

const REPRO = "Microsoft.VSTS.TCM.ReproSteps";
const BUG_FIELDS = [{ referenceName: "System.Title" }, { referenceName: REPRO }, { referenceName: "Microsoft.VSTS.TCM.SystemInfo" }];
const TASK_FIELDS = [{ referenceName: "System.Description" }, { referenceName: "Microsoft.VSTS.Common.Activity" }];
const typeFields = (type: string, fields: unknown[]): Route => ({ match: new RegExp(`wit/workitemtypes/${type}/fields`), respond: () => ({ body: { value: fields } }) });
const item = (id: number, type: string, fields: Record<string, string>): Route => ({
  match: new RegExp(`wit/workitems/${id}\\?`),
  respond: () => ({ body: { id, fields: { "System.WorkItemType": type, "System.State": "Active", "System.Title": `${type} item`, ...fields } } }),
});
const patchRoute = (id: number, sent: any[][]): Route => ({ method: "PATCH", match: new RegExp(`wit/workitems/${id}\\?`), respond: (c) => (sent.push(c.body), { body: { id } }) });
const val = (ops: any[], f: string) => ops.find((o) => o.path === `/fields/${f}`)?.value as string | undefined;

function repo(team = "") {
  const { dir } = makeRepo();
  if (team) write(dir, ".agents/skills/_shared/references/team.yaml", team);
  return dir;
}

describe("one rule for the main text field of a type", () => {
  it("a type without Description but with ReproSteps keeps its text in ReproSteps", () => {
    expect(layoutFor("Bug", BUG_FIELDS.map((f) => f.referenceName)).primary).toBe(REPRO);
    expect(layoutFor("Task", TASK_FIELDS.map((f) => f.referenceName))).toEqual({ primary: "System.Description", acceptance: "System.Description" });
    expect(layoutFor("Bug", ["System.Description", REPRO]).primary).toBe("System.Description");
  });
  it("without the type fields a Bug is assumed to use ReproSteps and everything else Description", () => {
    expect(layoutFor("bug", undefined).primary).toBe(REPRO);
    expect(layoutFor("Task", undefined)).toEqual(DEFAULT_LAYOUT);
  });
});

describe("refine a Bug", () => {
  it("reads the gaps from ReproSteps when Description is empty, and writes the update to ReproSteps", async () => {
    const dir = repo();
    const repro = "<p>Export crashes.</p><h2>Steps to reproduce</h2><p>open invoice</p><h2>Expected result</h2><p>An empty CSV.</p>";
    const routes = [typeFields("Bug", BUG_FIELDS), item(70, "Bug", { [REPRO]: repro })];
    const gaps = ctxFor(dir, fakeFetch(routes).fn);
    expect(await main(["story", "refine", "70"], gaps.ctx, commands)).toBe(0);
    expect(gaps.lines[0]).toContain("Bug 70 'Bug item': 1 gap(s): Actual result");

    write(dir, "refined.md", "## Actual result\nThe export stops with an error.\n");
    const sent: any[][] = [];
    const f = fakeFetch([...routes, patchRoute(70, sent)]);
    const { ctx, lines } = ctxFor(dir, f.fn);
    expect(await main(["story", "refine", "70", "--body-file", `${dir}/refined.md`], ctx, commands)).toBe(0);
    expect(lines[0]).toContain("Bug 70 refined");
    const ops = sent[0];
    const text = val(ops, REPRO)!;
    expect(text).toContain("The export stops with an error.");
    expect(text).toContain("open invoice");
    expect(text).toContain("Export crashes.");
    expect(val(ops, "System.Description")).toBeUndefined();
  });

  it("keeps ReproSteps text without ## headings as the opening text", async () => {
    const dir = repo();
    write(dir, "refined.md", "## Expected result\nAn empty CSV.\n");
    // a team template without a Description heading would otherwise drop the text
    write(dir, ".agents/skills/_shared/assets/bug-template.md", "## Steps\n<steps>\n\n## Expected result\n<x>\n");
    const sent: any[][] = [];
    const f = fakeFetch([typeFields("Bug", BUG_FIELDS), item(71, "Bug", { [REPRO]: "<div>It just crashes sometimes.</div>" }), patchRoute(71, sent)]);
    const { ctx } = ctxFor(dir, f.fn);
    expect(await main(["story", "refine", "71", "--body-file", `${dir}/refined.md`], ctx, commands)).toBe(0);
    const text = val(sent[0], REPRO)!;
    expect(text).toContain("It just crashes sometimes.");
    expect(text).toContain("An empty CSV.");
  });

  it("show prints the ReproSteps text and names the type", async () => {
    const dir = repo();
    const { ctx, lines } = ctxFor(dir, fakeFetch([typeFields("Bug", BUG_FIELDS), item(72, "Bug", { [REPRO]: "<p>Export crashes.</p>" })]).fn);
    expect(await main(["story", "show", "72"], ctx, commands)).toBe(0);
    expect(lines.join("\n")).toContain("Bug 72 [Bug, Active]");
    expect(lines.join("\n")).toContain("## Description\n\nExport crashes.");
  });

  it("falls back to the type name when the type fields cannot be read", async () => {
    const dir = repo();
    const sent: any[][] = [];
    write(dir, "refined.md", "## Actual result\nBoom.\n");
    const f = fakeFetch([item(73, "Bug", { [REPRO]: "<p>Export crashes.</p>" }), patchRoute(73, sent)]); // no route for the fields: 404
    const { ctx } = ctxFor(dir, f.fn);
    expect(await main(["story", "refine", "73", "--body-file", `${dir}/refined.md`], ctx, commands)).toBe(0);
    expect(val(sent[0], REPRO)).toContain("Boom.");
    expect(val(sent[0], "System.Description")).toBeUndefined();
  });

  it("team.yaml sectionFields still wins over the main field", async () => {
    const dir = repo("workItems:\n  sectionFields:\n    Actual result: Microsoft.VSTS.TCM.SystemInfo\n");
    const sent: any[][] = [];
    write(dir, "refined.md", "## Actual result\nBoom.\n");
    const f = fakeFetch([typeFields("Bug", BUG_FIELDS), item(74, "Bug", { [REPRO]: "<p>Export crashes.</p>" }), patchRoute(74, sent)]);
    const { ctx } = ctxFor(dir, f.fn);
    expect(await main(["story", "refine", "74", "--body-file", `${dir}/refined.md`], ctx, commands)).toBe(0);
    expect(val(sent[0], "Microsoft.VSTS.TCM.SystemInfo")).toContain("Boom.");
  });
});

describe("refine a Task and a Story", () => {
  it("a Task uses the Task template and Description", async () => {
    const dir = repo();
    const sent: any[][] = [];
    write(dir, "refined.md", "## Done when\n- [ ] report is right\n");
    const f = fakeFetch([typeFields("Task", TASK_FIELDS), item(80, "Task", { "System.Description": "<p>Update the report.</p>" }), patchRoute(80, sent)]);
    const { ctx, lines } = ctxFor(dir, f.fn);
    expect(await main(["story", "refine", "80", "--body-file", `${dir}/refined.md`], ctx, commands)).toBe(0);
    expect(lines[0]).toContain("Task 80 refined");
    expect(val(sent[0], "System.Description")).toContain("report is right");
    expect(val(sent[0], "System.Description")).toContain("Update the report.");
    expect(val(sent[0], REPRO)).toBeUndefined();
  });

  it("a Story is unchanged: story template, Description and Acceptance criteria fields, 'Story' in the line", async () => {
    const dir = repo();
    const sent: any[][] = [];
    write(dir, "refined.md", "## Acceptance criteria\n- [ ] fast\n");
    const f = fakeFetch([
      typeFields("User%20Story", [{ referenceName: "System.Description" }, { referenceName: "Microsoft.VSTS.Common.AcceptanceCriteria" }]),
      item(81, "User Story", { "System.Description": "<p>As a user I search.</p>" }),
      patchRoute(81, sent),
    ]);
    const { ctx, lines } = ctxFor(dir, f.fn);
    expect(await main(["story", "refine", "81", "--body-file", `${dir}/refined.md`], ctx, commands)).toBe(0);
    expect(lines[0]).toContain("Story 81 refined");
    expect(val(sent[0], "Microsoft.VSTS.Common.AcceptanceCriteria")).toContain("fast");
    expect(val(sent[0], REPRO)).toBeUndefined();
  });
});

describe("Azure DevOps template of a Bug", () => {
  it("devopsTemplateText reads ReproSteps for a Bug layout", () => {
    const layout = layoutFor("Bug", ["System.Title", REPRO]);
    expect(devopsTemplateText({ [REPRO]: "<h3>Stappen</h3><p>x</p>" }, layout)).toContain("## Stappen");
    expect(devopsTemplateText({ [REPRO]: "<h3>Stappen</h3><p>x</p>" })).toBeUndefined();
  });

  it("a Bug template in ReproSteps is used instead of the built-in one", async () => {
    const dir = repo();
    const home = tmp("aihub-home-");
    const base = "/test-project/test-project%20Team/_apis/wit/templates";
    const routes: Route[] = [
      typeFields("Bug", BUG_FIELDS),
      { match: new RegExp(`${base}\\?`), respond: () => ({ body: { value: [{ id: "t1", name: "Bug sjabloon" }] } }) },
      { match: new RegExp(`${base}/t1\\?`), respond: () => ({ body: { fields: { [REPRO]: "<h2>Stappen</h2><p>?</p><h2>Verwacht</h2><p>?</p>" } } }) },
      item(75, "Bug", { [REPRO]: "<h2>Stappen</h2><p>klik</p>" }),
    ];
    const { ctx, lines } = ctxFor(dir, fakeFetch(routes).fn);
    ctx.env = { ...ctx.env, AIHUB_HOME: home };
    expect(await main(["story", "refine", "75"], ctx, commands)).toBe(0);
    expect(lines[0]).toContain("Bug 75");
    expect(lines[0]).toContain("1 gap(s): Verwacht");
    expect(lines[0]).toContain('template: Azure DevOps "Bug sjabloon"');
  });
});
