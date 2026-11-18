import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { keywordsOf, scoreFile } from "../src/lib/storyContext.js";
import { ctxFor, fakeFetch, makeRepo, sh, write, type Route } from "./helpers.js";

describe("keywordsOf", () => {
  it("weighs the title, splits identifiers and drops stop words", () => {
    const k = keywordsOf("CSV export for invoices", "The user wants exportInvoices to produce a csv_file with the invoice total.");
    expect(k).toContain("export");
    expect(k).toContain("invoices");
    expect(k).toContain("invoice");
    expect(k).not.toContain("user");
    expect(k).not.toContain("with");
    expect(k[0]).toBe("export");
  });
});

describe("scoreFile", () => {
  it("ranks path matches over content matches, and history over both", () => {
    const kw = ["export", "invoice"];
    const path = scoreFile({ path: "src/export/invoice_csv.py", text: "", touchedBy: [] }, kw);
    const content = scoreFile({ path: "src/util.py", text: "def export_invoice(): pass", touchedBy: [] }, kw);
    const hist = scoreFile({ path: "src/other.py", text: "", touchedBy: ["PR !12"] }, kw);
    expect(path.score).toBe(10);
    expect(content.score).toBe(4);
    expect(hist.score).toBe(8);
    expect(path.reason).toBe("path matches export, invoice");
    expect(hist.reason).toBe("touched by PR !12");
  });
});

const wiBody = {
  id: 7,
  fields: {
    "System.WorkItemType": "User Story",
    "System.State": "Active",
    "System.Title": "CSV export for invoices",
    "System.Description": "<p>As an accountant I want an invoice export.</p><h2>Acceptance criteria</h2><ul><li>[ ] CSV has a total column</li></ul>",
    "Microsoft.VSTS.Common.AcceptanceCriteria": "<ul><li>[ ] CSV has a total column</li></ul>",
  },
  relations: [
    { rel: "ArtifactLink", url: "vstfs:///Git/PullRequestId/proj%2Frepo%2F12" },
    { rel: "ArtifactLink", url: "vstfs:///Git/Ref/proj%2Frepo%2FGBfeature%2F7-csv" },
  ],
};

describe("aihub story context", () => {
  it("prints the story, linked items and at most 15 relevant files without bodies", async () => {
    const { dir } = makeRepo();
    write(dir, "src/export/invoice_csv.py", "def build_csv(total): return total\n");
    write(dir, "src/billing/totals.py", "def invoice_total(): pass\n");
    write(dir, "src/unrelated/weather.py", "sunny = True\n");
    write(dir, "src/legacy/old.py", "x = 1\n");
    write(dir, "node_modules/pkg/export.js", "export const invoice = 1;\n");
    for (let i = 0; i < 20; i++) write(dir, `src/export/extra_${i}.py`, "x = 1\n");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "feat: files"]);
    const routes: Route[] = [
      { match: /pullrequests\/12\/iterations\/1\/changes/, respond: () => ({ body: { changeEntries: [{ item: { path: "/src/legacy/old.py" } }, { item: { path: "/src", isFolder: true } }] } }) },
      { match: /pullrequests\/12\/iterations\?/, respond: () => ({ body: { value: [{ id: 1 }] } }) },
      { match: /pullrequests\/12\?/, respond: () => ({ body: { pullRequestId: 12, title: "First CSV try", status: "completed", sourceRefName: "refs/heads/feature/7-csv", targetRefName: "refs/heads/main" } }) },
      { match: /_apis\/wit\/workitems\/7\?/, respond: () => ({ body: wiBody }) },
    ];
    const { ctx, lines, errs } = ctxFor(dir, fakeFetch(routes).fn);
    expect(await main(["story", "context", "--id", "7"], ctx)).toBe(0);
    expect(errs).toEqual([]);
    const out = lines.join("\n");
    expect(out).toContain("Story 7 [User Story, Active] CSV export for invoices");
    expect(out).toContain("CSV has a total column");
    expect(out).toContain("- !12 [completed] First CSV try");
    expect(out).toContain("- feature/7-csv");
    const files = out.split("Most relevant files")[1].split("\n").filter((l) => /^\s*\d+\. /.test(l));
    expect(files.length).toBeLessThanOrEqual(15);
    expect(files[0]).toContain("src/export/invoice_csv.py");
    expect(files[0]).toContain("path matches");
    expect(out).toContain("src/legacy/old.py  (touched by PR !12)");
    expect(out).toContain("src/billing/totals.py");
    expect(out).not.toContain("weather");
    expect(out).not.toContain("node_modules");
    expect(out).not.toContain("def build_csv");

    lines.length = 0;
    expect(await main(["story", "context", "--id", "7", "--top", "2", "--json"], ctx)).toBe(0);
    const j = JSON.parse(lines[0]);
    expect(j.files).toHaveLength(2);
    expect(j.prs).toEqual([{ id: 12, title: "First CSV try", status: "completed" }]);
    expect(j.keywords).toContain("export");
  });

  it("adds the files of a story branch that exists locally", async () => {
    const { dir } = makeRepo();
    sh(dir, ["checkout", "-b", "feature/7-csv"]);
    write(dir, "src/pipeline/render.py", "x = 1\n");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "feat: render"]);
    sh(dir, ["push", "origin", "feature/7-csv"]);
    const routes: Route[] = [{ match: /_apis\/wit\/workitems\/7\?/, respond: () => ({ body: { ...wiBody, relations: [] } }) }];
    const { ctx, lines } = ctxFor(dir, fakeFetch(routes).fn);
    await main(["story", "context", "--id", "7"], ctx);
    expect(lines.join("\n")).toContain("src/pipeline/render.py  (touched by branch feature/7-csv)");
  });
});
