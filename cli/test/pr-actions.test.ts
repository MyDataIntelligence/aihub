import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isActionHeading, isVagueActions, VAGUE_ACTIONS_EXIT } from "../src/lib/prActions.js";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, sh, tmp, write, type Route } from "./helpers.js";

const VAGUE =
  "Compare the existing job YAML files with the updated templates and migrate them to the new configuration contract. This includes mapping legacy fields to the new names and ensuring any custom query selects the new column.";
const CONCRETE = [
  "- `jobs/orders/*.yaml` (2 files: orders_ingest.yaml, orders_export.yaml): rename `target_table` -> `destination.table`.",
  "- `jobs/orders_ingest.yaml`: add the required field `destination.mode` (example: `append`).",
  "- Check: run `make validate-jobs`; it prints 2 ok.",
].join("\n");

describe("which headings count as action sections", () => {
  it.each(["Required user actions", "User actions", "Action required", "Manual steps", "Migration", "Breaking changes", "Acties voor gebruikers", "Handmatige stappen", "Te doen na merge", "Acties", "Migratie (optioneel)"])(
    "%s",
    (h) => expect(isActionHeading(h)).toBe(true),
  );
  it.each(["Risks and impact", "Risico's en impact", "Summary", "Samenvatting", "Changes", "Wijzigingen", "Testing", "Testen", "Linked stories", "Gekoppelde stories", "Related", "Gerelateerd"])("%s is not one", (h) =>
    expect(isActionHeading(h)).toBe(false),
  );
  it("team.yaml names a heading the patterns do not know", () => {
    expect(isActionHeading("Rollout", [])).toBe(false);
    expect(isActionHeading("Rollout", ["rollout"])).toBe(true);
  });
});

describe("what counts as vague", () => {
  it("vague prose is vague", () => expect(isVagueActions(VAGUE)).toBe(true));
  it("Dutch vague prose is vague", () => expect(isVagueActions("Vergelijk de bestaande jobs met de nieuwe sjablonen en pas aan waar nodig.")).toBe(true));
  it("a concrete list passes", () => expect(isVagueActions(CONCRETE)).toBe(false));
  it("concrete references pass even with 'ensure' in them", () => expect(isVagueActions("Ensure `destination.table` is set in `jobs/orders_ingest.yaml`.")).toBe(false));
  it("an old -> new pair passes", () => expect(isVagueActions("Rename target_table -> destination.table in every job.")).toBe(false));
  it.each(["n.v.t.", "n.v.t", "None", "none.", "n/a", "-", "Niet van toepassing", "", "<!-- only a comment -->"])("%j means nothing to do", (t) => expect(isVagueActions(t)).toBe(false));
  it("the team's own empty text passes", () => expect(isVagueActions("Geen acties nodig", "Geen acties nodig")).toBe(false));
  it("a long blob of prose without list or reference is vague", () => expect(isVagueActions("After the merge the people who use this feature have to go through their setup once and bring it in line with how things work now.")).toBe(true));
  it("a short plain sentence is left alone", () => expect(isVagueActions("Restart the worker.")).toBe(false));
});

const TEMPLATE = `## Summary
<!-- Why -->

## Required user actions
<!-- What must readers do themselves after the merge? Name the files, fields old -> new and how to check. Write "None" if nothing. -->

## Risks and impact
<!-- What could break? Write "n/a" if nothing. -->
`;
const TEMPLATE_WITHOUT = "## Summary\n\n## Risks and impact\n";
const PR_BASE = "/ferron-org/test-project/_apis/git/repositories/test-repo/pullrequests";

function setup(template: string, team = "repositories:\n  - name: test-repo\n    defaultTarget: main\n") {
  const { dir, bare } = makeRepo();
  write(dir, ".azuredevops/pull_request_template.md", template);
  write(dir, ".agents/skills/_shared/references/team.yaml", team);
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "chore: templates"]);
  sh(dir, ["push", "origin", "main"]);
  sh(dir, ["checkout", "-b", "feature/77-jobs"]);
  write(dir, "jobs/orders_ingest.yaml", "destination:\n  table: orders\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "feat: new job contract"]);
  return { dir, bare };
}

const routes = (): Route[] => [
  { match: /_apis\/wit\/workitems\/77\?.*fields=/, respond: () => ({ body: { fields: { "System.Title": "Job contract" } } }) },
  { match: /_apis\/wit\/workitems\/77\?.*expand=relations|%24expand=relations/, respond: () => ({ body: { relations: [] } }) },
  { match: new RegExp(PR_BASE + "\\?.*searchCriteria"), respond: () => ({ body: { value: [] } }) },
  { method: "POST", match: new RegExp(PR_BASE + "\\?"), respond: () => ({ body: { pullRequestId: 9 } }) },
];

function body(text: string) {
  const f = join(tmp(), "body.md");
  writeFileSync(f, text, "utf8");
  return f;
}

describe("aihub pr create with an action section", () => {
  it("refuses vague text: nothing is pushed or sent, short message with the way out", async () => {
    const { dir, bare } = setup(TEMPLATE);
    const { fn, calls } = fakeFetch(routes());
    const { ctx, errs } = ctxFor(dir, fn);
    const f = body(`## Summary\nNew job contract.\n\n## Required user actions\n${VAGUE}\n`);
    expect(await main(["pr", "create", "--body-file", f], ctx)).toBe(VAGUE_ACTIONS_EXIT);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(sh(bare, ["branch", "--list", "feature/77-jobs"])).toBe("");
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('"Required user actions"');
    expect(errs[0]).toContain("old -> new");
    expect(errs[0]).toContain("--as-is");
    expect(errs[0]).toContain("Template says:");
    expect(Buffer.byteLength(errs[0])).toBeLessThan(420);
  });

  it("also refuses with --dry-run", async () => {
    const { dir } = setup(TEMPLATE);
    const { fn } = fakeFetch(routes());
    const { ctx } = ctxFor(dir, fn);
    const f = body(`## Required user actions\n${VAGUE}\n`);
    expect(await main(["pr", "create", "--dry-run", "--body-file", f], ctx)).toBe(VAGUE_ACTIONS_EXIT);
  });

  it("accepts a concrete list", async () => {
    const { dir } = setup(TEMPLATE);
    const { fn, calls } = fakeFetch(routes());
    const { ctx, errs } = ctxFor(dir, fn);
    const f = body(`## Summary\nNew job contract.\n\n## Required user actions\n${CONCRETE}\n`);
    expect(await main(["pr", "create", "--body-file", f], ctx)).toBe(0);
    expect(errs).toEqual([]);
    expect(calls.find((c) => c.method === "POST")!.body.description).toContain("`target_table` -> `destination.table`");
  });

  it("accepts the template's empty text and 'None'", async () => {
    for (const text of ["None", ""]) {
      const { dir } = setup(TEMPLATE);
      const { fn, calls } = fakeFetch(routes());
      const { ctx } = ctxFor(dir, fn);
      const f = body(`## Summary\nSmall fix.\n\n## Required user actions\n${text}\n`);
      expect(await main(["pr", "create", "--body-file", f], ctx)).toBe(0);
      expect(calls.some((c) => c.method === "POST")).toBe(true);
    }
  });

  it("--as-is lets vague text through", async () => {
    const { dir } = setup(TEMPLATE);
    const { fn, calls } = fakeFetch(routes());
    const { ctx, errs } = ctxFor(dir, fn);
    const f = body(`## Required user actions\n${VAGUE}\n`);
    expect(await main(["pr", "create", "--as-is", "--body-file", f], ctx)).toBe(0);
    expect(errs).toEqual([]);
    expect(calls.find((c) => c.method === "POST")!.body.description).toContain("Compare the existing job YAML files");
  });

  it("team.yaml actionSections makes an unknown heading count", async () => {
    const tpl = "## Summary\n\n## Rollout\n<!-- steps for readers -->\n";
    const { dir } = setup(tpl, "repositories:\n  - name: test-repo\n    defaultTarget: main\npullRequest:\n  actionSections: [Rollout]\n");
    const { fn, calls } = fakeFetch(routes());
    const { ctx } = ctxFor(dir, fn);
    const f = body(`## Rollout\n${VAGUE}\n`);
    expect(await main(["pr", "create", "--body-file", f], ctx)).toBe(VAGUE_ACTIONS_EXIT);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("without team.yaml the same heading is not an action section", async () => {
    const tpl = "## Summary\n\n## Rollout\n";
    const { dir } = setup(tpl);
    const { fn } = fakeFetch(routes());
    const { ctx } = ctxFor(dir, fn);
    expect(await main(["pr", "create", "--body-file", body(`## Rollout\n${VAGUE}\n`)], ctx)).toBe(0);
  });

  it("a template without an action section behaves as before, even with vague words elsewhere", async () => {
    const { dir } = setup(TEMPLATE_WITHOUT);
    const { fn, calls } = fakeFetch(routes());
    const { ctx } = ctxFor(dir, fn);
    expect(await main(["pr", "create", "--body-file", body(`## Summary\n${VAGUE}\n\n## Risks and impact\nEnsure nothing breaks.\n`)], ctx)).toBe(0);
    expect(calls.some((c) => c.method === "POST")).toBe(true);
  });
});

describe("aihub pr update with an action section", () => {
  const existing = {
    pullRequestId: 42,
    title: "t",
    status: "active",
    description: `## Summary\n\nx\n\n## Required user actions\n\n${VAGUE}\n`,
    sourceRefName: "refs/heads/feature/77-jobs",
    targetRefName: "refs/heads/main",
  };
  const upd = () => [
    { match: new RegExp(PR_BASE + "/42\\?"), respond: () => ({ body: existing }) },
    { method: "PATCH", match: new RegExp(PR_BASE + "/42\\?"), respond: () => ({ body: {} }) },
  ];

  it("refuses a vague replacement of the section, sends nothing", async () => {
    const { dir } = setup(TEMPLATE);
    const { fn, calls } = fakeFetch(upd());
    const { ctx, errs } = ctxFor(dir, fn);
    expect(await main(["pr", "update", "--pr", "42", "--section", "Required user actions", "--replace-text", VAGUE], ctx)).toBe(VAGUE_ACTIONS_EXIT);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(errs[0]).toContain("PR not updated");
  });

  it("accepts a concrete replacement", async () => {
    const { dir } = setup(TEMPLATE);
    const { fn, calls } = fakeFetch(upd());
    const { ctx } = ctxFor(dir, fn);
    expect(await main(["pr", "update", "--pr", "42", "--section", "Required user actions", "--replace-text", CONCRETE], ctx)).toBe(0);
    expect(calls.find((c) => c.method === "PATCH")!.body.description).toContain("`destination.mode`");
  });

  it("--as-is lets it through", async () => {
    const { dir } = setup(TEMPLATE);
    const { fn, calls } = fakeFetch(upd());
    const { ctx } = ctxFor(dir, fn);
    expect(await main(["pr", "update", "--pr", "42", "--as-is", "--section", "Required user actions", "--replace-text", VAGUE], ctx)).toBe(0);
    expect(calls.some((c) => c.method === "PATCH")).toBe(true);
  });

  it("an edit of another section is not blocked by an old vague action section", async () => {
    const { dir } = setup(TEMPLATE);
    const { fn, calls } = fakeFetch(upd());
    const { ctx } = ctxFor(dir, fn);
    expect(await main(["pr", "update", "--pr", "42", "--section", "Summary", "--append-text", "More."], ctx)).toBe(0);
    expect(calls.some((c) => c.method === "PATCH")).toBe(true);
  });
});
