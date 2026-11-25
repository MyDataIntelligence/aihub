import { describe, expect, it } from "vitest";
import { showFile, listRefFiles } from "../src/lib/git.js";
import { resolveTemplate, templateSourceText } from "../src/lib/templates.js";
import { devopsTemplateText } from "../src/lib/workItemTemplate.js";
import { commands, main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, sh, tmp, write, type Route } from "./helpers.js";

const NL_STORY = "## Context\n<waarom>\n\n## Gebruikersverhaal\nAls <rol> wil ik <doel>.\n\n## Acceptatiecriteria\n- [ ] <resultaat>\n";
const TEAM_TPL = "## Achtergrond\n<waarom>\n\n## Wens\n<wat>\n";

// the team's work item templates in Azure DevOps (team-scoped URL)
const TEMPLATES_LIST = /\/test-project\/test-project%20Team\/_apis\/wit\/templates\?/;
const TEMPLATE_ONE = /\/test-project\/test-project%20Team\/_apis\/wit\/templates\/tpl-1\?/;
const devops = (list: { id: string; name: string }[], fields: Record<string, string> = {}): Route[] => [
  { match: TEMPLATES_LIST, respond: () => ({ body: { value: list } }) },
  { match: TEMPLATE_ONE, respond: () => ({ body: { id: "tpl-1", fields } }) },
];

async function run(dir: string, argv: string[], routes: Route[] = [], home?: string) {
  const f = fakeFetch(routes);
  const { ctx, lines, errs } = ctxFor(dir, f.fn);
  if (home) ctx.env = { ...ctx.env, AIHUB_HOME: home };
  const code = await main(argv, ctx, commands);
  return { code, out: lines.join("\n"), errs: errs.join("\n"), calls: f.calls };
}

describe("story template: fixed order and a visible source", () => {
  it("(b) finds .agents/skills/_shared/assets/story-template.md without team.yaml and asks Azure DevOps nothing", async () => {
    const { dir } = makeRepo();
    write(dir, ".agents/skills/_shared/assets/story-template.md", NL_STORY);
    const r = await run(dir, ["story", "template"]);
    expect(r.code).toBe(0);
    expect(r.out.split("\n")[0]).toBe("template: .agents/skills/_shared/assets/story-template.md");
    expect(r.out).toContain("## Gebruikersverhaal");
    expect(r.calls).toHaveLength(0);
  });

  it("(a) the team.yaml path wins over the standard files, and .agents wins over skills/", async () => {
    const { dir } = makeRepo();
    write(dir, ".agents/skills/_shared/assets/story-template.md", NL_STORY);
    write(dir, "skills/_shared/assets/story-template.md", "## Other\n");
    expect((await run(dir, ["story", "template"])).out.split("\n")[0]).toBe("template: .agents/skills/_shared/assets/story-template.md");
    write(dir, "docs/team-story.md", TEAM_TPL);
    write(dir, ".agents/skills/_shared/references/team.yaml", "workItems:\n  storyTemplate: docs/team-story.md\n");
    const r = await run(dir, ["story", "template"]);
    expect(r.out.split("\n")[0]).toBe("template: docs/team-story.md");
    expect(r.out).toContain("## Wens");
  });

  it("(c) without a file it takes the team's Azure DevOps template for the story type, once, then from the cache", async () => {
    const { dir } = makeRepo();
    const home = tmp("aihub-home-");
    const fields = { "System.Description": "<h2>Context</h2><p>Waarom?</p><h2>Gebruikersverhaal</h2><p>Als ...</p>", "Microsoft.VSTS.Common.AcceptanceCriteria": "<ul><li>Meetbaar</li></ul>" };
    const routes = devops([{ id: "tpl-1", name: "User Story sjabloon" }], fields);
    const first = await run(dir, ["story", "template"], routes, home);
    expect(first.out.split("\n")[0]).toBe('template: Azure DevOps "User Story sjabloon"');
    expect(first.out).toContain("## Context");
    expect(first.out).toContain("## Gebruikersverhaal");
    expect(first.out).toContain("## Acceptance criteria");
    expect(first.calls.map((c) => c.url).some((u) => /workitemtypename=User(\+|%20)Story/.test(u))).toBe(true);
    const again = await run(dir, ["story", "template"], routes, home);
    expect(again.out.split("\n")[0]).toBe('template: Azure DevOps "User Story sjabloon"');
    expect(again.calls).toHaveLength(0);
  });

  it("(c) several Azure DevOps templates and none named after the type: none is chosen and the line says why", async () => {
    const { dir } = makeRepo();
    const r = await run(dir, ["story", "template"], devops([{ id: "a", name: "Spike" }, { id: "b", name: "Onderzoek" }]));
    expect(r.out.split("\n")[0]).toContain("template: built-in (Azure DevOps has 2 templates for User Story and none is clearly the one: Spike, Onderzoek");
    expect(r.out).toContain("## Description");
  });

  it("(d) no access to the templates is skipped silently: built-in, with the hint where to add one", async () => {
    const { dir } = makeRepo();
    const r = await run(dir, ["story", "template", "--json"], [{ match: TEMPLATES_LIST, respond: () => ({ status: 403, body: { message: "no access" } }) }]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.kind).toBe("built-in");
    expect(j.template).toBe("built-in (no team template found; add .agents/skills/_shared/assets/story-template.md to use your own)");
  });

  it("story create and refine name the template in their result line", async () => {
    const { dir } = makeRepo();
    write(dir, ".agents/skills/_shared/assets/story-template.md", NL_STORY);
    write(dir, "body.md", "## Context\nOrders exporteren.\n\n## Gebruikersverhaal\nAls planner wil ik CSV.\n\n## Acceptatiecriteria\n- [ ] Kop aanwezig\n");
    const created = await run(dir, ["story", "create", "--title", "CSV", "--body-file", `${dir}/body.md`], [{ method: "POST", match: /workitems\/\$User%20Story\?/, respond: () => ({ body: { id: 77 } }) }]);
    expect(created.out).toMatch(/^Story 77 created: .*; template: \.agents\/skills\/_shared\/assets\/story-template\.md$/);
    const wi = { id: 77, fields: { "System.WorkItemType": "User Story", "System.State": "New", "System.Title": "CSV", "System.Description": "<h2>Context</h2><p>x</p>" } };
    const refined = await run(dir, ["story", "refine", "77"], [{ match: /wit\/workitems\/77\?/, respond: () => ({ body: wi }) }]);
    expect(refined.out).toContain("template: .agents/skills/_shared/assets/story-template.md");
  });

  it("a Bug template under .agents/skills/_shared/assets is found too, and named", async () => {
    const { dir } = makeRepo();
    write(dir, ".agents/skills/_shared/assets/bug-template.md", "## Wat gaat er mis\n\n## Stappen\n");
    write(dir, "bug.md", "## Wat gaat er mis\nExport crasht.\n\n## Stappen\n1. Klik export\n");
    const r = await run(dir, ["workitem", "create", "--type", "Bug", "--title", "Crash", "--body-file", `${dir}/bug.md`], [{ method: "POST", match: /workitems\/\$Bug\?/, respond: () => ({ body: { id: 88 } }) }]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("; template: .agents/skills/_shared/assets/bug-template.md");
  });

  it("devopsTemplateText keeps headings and returns nothing for a description without them", () => {
    expect(devopsTemplateText({ "System.Description": "<p>Vrije tekst</p>" })).toBeUndefined();
    expect(devopsTemplateText({ "System.Description": "<h3>Doel</h3><p>x</p>" })).toContain("## Doel");
  });
});

describe("pull request template: the Azure DevOps order", () => {
  it("the branch-specific template of the target wins; another branch's template does not count", () => {
    const { dir } = makeRepo();
    write(dir, ".azuredevops/pull_request_template.md", "## Default\n");
    write(dir, ".azuredevops/pull_request_template/branches/release.md", "## Release only\n");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "templates"]);
    sh(dir, ["push", "origin", "main"]);
    const src = { readRef: (b: string, p: string) => showFile(dir, b, p), localRoot: dir };
    expect(resolveTemplate("main", src)?.content).toContain("Default");
    sh(dir, ["push", "origin", "main:release"]);
    sh(dir, ["fetch", "origin"]);
    expect(resolveTemplate("release", src)).toMatchObject({ path: ".azuredevops/pull_request_template/branches/release.md", from: "ref" });
  });

  it("finds a case variant of the file name on origin/<target> and in the working tree", () => {
    const { dir } = makeRepo();
    write(dir, ".azuredevops/PULL_REQUEST_TEMPLATE.md", "## Upper case\n");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "template"]);
    sh(dir, ["push", "origin", "main"]);
    const t = resolveTemplate("main", { readRef: (b, p) => showFile(dir, b, p), listRef: (b) => listRefFiles(dir, b), localRoot: dir });
    expect(t).toMatchObject({ path: ".azuredevops/PULL_REQUEST_TEMPLATE.md", from: "ref" });
    const local = makeRepo().dir;
    write(local, "Docs/Pull_Request_Template.md", "## Local variant\n");
    // a case-insensitive file system (Windows) finds it under the candidate spelling, Linux under its own
    const l = resolveTemplate("main", { localRoot: local });
    expect(l?.from).toBe("local");
    expect(l?.path.toLowerCase()).toBe("docs/pull_request_template.md");
    expect(l?.content).toContain("Local variant");
  });

  it("the template on origin/<target> wins over the local copy, also for a case variant", () => {
    const { dir } = makeRepo();
    write(dir, "pull_request_template.md", "## From origin\n");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "template"]);
    sh(dir, ["push", "origin", "main"]);
    write(dir, "pull_request_template.md", "## Local edit\n");
    write(dir, ".azuredevops/Pull_Request_Template.md", "## Local only, in a higher folder\n");
    const t = resolveTemplate("main", { readRef: (b, p) => showFile(dir, b, p), listRef: (b) => listRefFiles(dir, b), localRoot: dir });
    expect(t).toMatchObject({ path: "pull_request_template.md", from: "ref" });
    expect(t?.content).toContain("From origin");
  });

  it("pr create names the template it used, or that there is none", () => {
    expect(templateSourceText({ path: ".azuredevops/pull_request_template.md", content: "", from: "ref" }, "main")).toBe("template: .azuredevops/pull_request_template.md (origin/main)");
    expect(templateSourceText(undefined, "main")).toContain("template: none");
  });
});
