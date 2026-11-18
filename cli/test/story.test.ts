import { describe, expect, it } from "vitest";
import { commands, main } from "../src/router.js";
import { htmlToMd, isGap, mdToHtml } from "../src/lib/story.js";
import { ctxFor, fakeFetch, makeRepo, write } from "./helpers.js";

const TEAM = `workItems:
  storyType: User Story
  emptySection: "Niet van toepassing"
  areaPath: test-project\\Team
  tags: [aihub]
`;

function setup() {
  const { dir } = makeRepo();
  write(dir, ".agents/skills/_shared/references/team.yaml", TEAM);
  return dir;
}

describe("story html conversion", () => {
  it("round trips headings and lists", () => {
    const md = "Intro <b>\n\n## Notes\n\n- a & b\n- c";
    expect(htmlToMd(mdToHtml(md))).toBe("Intro <b>\n\n## Notes\n\n- a & b\n- c");
    expect(isGap("<observable result 1>", "n.v.t.")).toBe(true);
    expect(isGap("- [ ] <observable result 1>", "n.v.t.")).toBe(true);
    expect(isGap("Niet van toepassing", "Niet van toepassing")).toBe(true);
    expect(isGap("- [ ] CSV has a header", "n.v.t.")).toBe(false);
  });
});

describe("story create", () => {
  it("maps template sections to ADO fields, fills missing ones with emptySection, adds parent", async () => {
    const dir = setup();
    write(dir, "body.md", "## Description\nAls gebruiker wil ik CSV.\n\n## Acceptance criteria\n- [ ] Header aanwezig\n");
    const f = fakeFetch([{ method: "POST", match: /workitems\/\$User%20Story\?/, respond: () => ({ body: { id: 501 } }) }]);
    const { ctx, lines } = ctxFor(dir, f.fn);
    const code = await main(["story", "create", "--title", "CSV-export", "--body-file", `${dir}/body.md`, "--parent", "90"], ctx, commands);
    expect(code).toBe(0);
    expect(lines[0]).toBe("Story 501 created: https://dev.azure.com/ferron-org/test-project/_workitems/edit/501 (Niet van toepassing: Technical notes, Out of scope)");
    const call = f.calls[0];
    expect(String(call.headers["Content-Type"])).toContain("application/json-patch+json");
    const ops = call.body as { op: string; path: string; value: any }[];
    const val = (p: string) => ops.find((o) => o.path === p)?.value;
    expect(val("/fields/System.Title")).toBe("CSV-export");
    expect(val("/fields/Microsoft.VSTS.Common.AcceptanceCriteria")).toContain("<li>[ ] Header aanwezig</li>");
    expect(val("/fields/System.Description")).toContain("Als gebruiker wil ik CSV.");
    expect(val("/fields/System.Description")).toContain("<h2>Technical notes</h2>");
    expect(val("/fields/System.AreaPath")).toBe("test-project\\Team");
    expect(val("/fields/System.Tags")).toBe("aihub");
    expect(ops.find((o) => o.path === "/relations/-")?.value.url).toMatch(/_apis\/wit\/workItems\/90$/);
  });
});

const WI = {
  id: 55,
  fields: {
    "System.WorkItemType": "User Story",
    "System.State": "Active",
    "System.Title": "Zoeken",
    "System.Description": "<p>Als gebruiker zoek ik.</p><h2>Technical notes</h2><p>Gebruik index.</p>",
    "Microsoft.VSTS.Common.AcceptanceCriteria": "",
  },
  relations: [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://dev.azure.com/ferron-org/_apis/wit/workItems/12" }],
};

describe("story show and refine", () => {
  it("shows the story as template sections", async () => {
    const dir = setup();
    const { ctx, lines } = ctxFor(dir, fakeFetch([{ match: /wit\/workitems\/55\?/, respond: () => ({ body: WI }) }]).fn);
    expect(await main(["story", "show", "--id", "55"], ctx, commands)).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("Story 55 [User Story, Active] Zoeken");
    expect(out).toContain("parent: 12");
    expect(out).toContain("## Description\n\nAls gebruiker zoek ik.");
    expect(out).toContain("## Acceptance criteria\n\n(empty)");
    expect(out).toContain("## Technical notes\n\nGebruik index.");
  });

  it("refine without a body reports gaps and writes nothing; positional id works", async () => {
    const dir = setup();
    const f = fakeFetch([{ match: /wit\/workitems\/55\?/, respond: () => ({ body: WI }) }]);
    const { ctx, lines } = ctxFor(dir, f.fn);
    expect(await main(["story", "refine", "55"], ctx, commands)).toBe(0);
    expect(lines[0]).toContain("2 gap(s): Acceptance criteria, Out of scope");
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("refine with a body updates only the given sections and keeps the rest", async () => {
    const dir = setup();
    write(dir, "refined.md", "## Acceptance criteria\n- [ ] Zoekresultaat binnen 1s\n");
    const f = fakeFetch([
      { match: /wit\/workitems\/55\?/, respond: () => ({ body: WI }) },
      { method: "PATCH", match: /wit\/workitems\/55\?/, respond: () => ({ body: { id: 55 } }) },
    ]);
    const { ctx, lines } = ctxFor(dir, f.fn);
    expect(await main(["story", "refine", "--id", "55", "--body-file", `${dir}/refined.md`], ctx, commands)).toBe(0);
    expect(lines[0]).toContain("Story 55 refined");
    const patch = f.calls.find((c) => c.method === "PATCH")!;
    const ops = patch.body as { path: string; value: string }[];
    expect(ops.find((o) => o.path === "/fields/Microsoft.VSTS.Common.AcceptanceCriteria")?.value).toContain("Zoekresultaat binnen 1s");
    expect(ops.find((o) => o.path === "/fields/System.History")?.value).toContain("Acceptance criteria");
    const desc = ops.find((o) => o.path === "/fields/System.Description")?.value ?? "";
    expect(desc).toContain("Gebruik index.");
    expect(desc).toContain("Als gebruiker zoek ik.");
  });
});

describe("aihub story template", () => {
  it("prints the team story template of the repo (headings and hints) so a body can use them", async () => {
    const { dir } = makeRepo();
    write(dir, ".agents/skills/_shared/references/team.yaml", "workItems:\n  storyTemplate: .agents/skills/_shared/assets/story-template.md\n");
    write(dir, ".agents/skills/_shared/assets/story-template.md", "## Context\n\n## User story\nAs a <role> I want <goal> so that <reason>.\n");
    const { ctx, lines } = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(["story", "template"], ctx)).toBe(0);
    expect(lines.join("\n")).toContain("## User story");
    expect(lines.join("\n")).toContain("As a <role>");
  });
});
