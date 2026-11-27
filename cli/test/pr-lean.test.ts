import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { noisyLines } from "../src/lib/prNoise.js";
import { commands, main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, sh, tmp, write, type Route } from "./helpers.js";

// a team template with one own required section: the CLI must keep to exactly these headings
const TEMPLATE = `## Summary

## Release metadata

## Tests

## Related
`;
const PR_BASE = "/ferron-org/test-project/_apis/git/repositories/test-repo/pullrequests";

function setup() {
  const { dir } = makeRepo();
  write(dir, ".azuredevops/pull_request_template.md", TEMPLATE);
  write(dir, ".agents/skills/_shared/references/team.yaml", "repositories:\n  - name: test-repo\n    defaultTarget: main\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "chore: templates"]);
  sh(dir, ["push", "origin", "main"]);
  sh(dir, ["checkout", "-b", "feature/export"]);
  write(dir, "export.py", "print('x')\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "feat: export"]);
  return dir;
}

const routes = (posted: any[]): Route[] => [
  { match: new RegExp(PR_BASE + "\\?.*searchCriteria"), respond: () => ({ body: { value: [] } }) },
  { method: "POST", match: new RegExp(PR_BASE + "\\?"), respond: (c) => (posted.push(c.body), { body: { pullRequestId: 7 } }) },
];

const body = (text: string) => {
  const f = join(tmp(), "body.md");
  writeFileSync(f, text, "utf8");
  return f;
};

const NOISE = "## Summary\nAdds the export.\n\n## Release metadata\nVersion 2.\n\n## Description\nMore.\n\n## Verification\n- 253 focused tests passed\n\n## Rollout and dependencies\nNone.\n";

describe("pr create keeps to the team template", () => {
  it("leaves out headings the template does not have and says so; the template's own section stays", async () => {
    const dir = setup();
    const posted: any[] = [];
    const { ctx, errs, lines } = ctxFor(dir, fakeFetch(routes(posted)).fn);
    const clean = "## Summary\nAdds the export.\n\n## Release metadata\nVersion 2.\n\n## Description\nMore.\n\n## Rollout and dependencies\nNone.\n";
    expect(await main(["pr", "create", "--body-file", body(clean)], ctx, commands)).toBe(0);
    const d: string = posted[0].description;
    expect(d).toContain("## Release metadata\n\nVersion 2.");
    expect(d).not.toContain("## Description");
    expect(d).not.toContain("## Rollout and dependencies");
    expect(errs.join("\n")).toContain('section "Description" is not in the team template; left out');
    expect(errs.join("\n")).toContain('section "Rollout and dependencies" is not in the team template; left out');
    expect(lines[0]).toContain("left out (not in the team template): Description, Rollout and dependencies");
  });

  it("--as-is keeps the extra sections and skips the noise check", async () => {
    const dir = setup();
    const posted: any[] = [];
    const { ctx, errs } = ctxFor(dir, fakeFetch(routes(posted)).fn);
    expect(await main(["pr", "create", "--as-is", "--body-file", body(NOISE)], ctx, commands)).toBe(0);
    expect(posted[0].description).toContain("## Verification");
    expect(errs).toEqual([]);
  });

  it("refuses unit-test counts and environment problems before anything is sent", async () => {
    const dir = setup();
    const posted: any[] = [];
    const f = fakeFetch(routes(posted));
    const { ctx, errs } = ctxFor(dir, f.fn);
    expect(await main(["pr", "create", "--body-file", body("## Summary\nAdds the export.\n\n## Tests\n253 focused tests passed; the pre-push run exposed Git-environment isolation problems.\n")], ctx, commands)).toBe(4);
    expect(errs.join("\n")).toContain("process noise");
    expect(errs.join("\n")).toContain("--as-is");
    expect(posted).toEqual([]);
  });

  it("without a Tests body the honest 'Not run yet.' line is used", async () => {
    const dir = setup();
    const posted: any[] = [];
    const { ctx } = ctxFor(dir, fakeFetch(routes(posted)).fn);
    expect(await main(["pr", "create", "--summary-text", "Adds the export."], ctx, commands)).toBe(0);
    expect(posted[0].description).toContain("## Tests\n\nNot run yet.");
  });
});

describe("noise lint", () => {
  it("catches counts, PATH and environment messages, started runs without outcome, coordination", () => {
    for (const l of [
      "253 focused tests passed",
      "All unit tests passed",
      "12/12 tests",
      "aihub dbt impact could not run because dbt was not on PATH",
      "the pre-push run exposed Git-environment isolation problems",
      "an integration run was started; the result is not yet known",
      "coordinated with the sub-agents",
    ])
      expect(noisyLines(`## Tests\n${l}\n`), l).toHaveLength(1);
  });

  it("lets functional results, the not-run line and the commit list through", () => {
    expect(noisyLines("## Tests\n| Export of an empty invoice | passed (pipeline run 123) |\nNot run yet.\n\n## Commits\n- fix: 5 tests passed in the old suite (abc)\n")).toEqual([]);
    expect(noisyLines("## Summary\nThe export no longer crashes on empty invoices; users re-run their jobs.\n")).toEqual([]);
  });
});

describe("pr update keeps to the headings of the PR and the template", () => {
  const existing = {
    pullRequestId: 42,
    title: "t",
    status: "active",
    description: "## Summary\n\nFirst.\n\n## Tests\n\nNot run yet.\n",
    sourceRefName: "refs/heads/feature/x",
    targetRefName: "refs/heads/main",
  };
  const upd = (patched: any[]): Route[] => [
    { match: new RegExp(PR_BASE + "/42\\?"), respond: () => ({ body: existing }) },
    { method: "PATCH", match: new RegExp(PR_BASE + "/42\\?"), respond: (c) => (patched.push(c.body), { body: {} }) },
  ];
  const repo = () => {
    const dir = tmp();
    sh(dir, ["init", "-b", "main"]);
    sh(dir, ["config", "remote.origin.url", "https://dev.azure.com/ferron-org/test-project/_git/test-repo"]);
    return dir;
  };

  it("a body-file section that is not in the PR is left out with a warning; the others are merged", async () => {
    const dir = repo();
    const patched: any[] = [];
    const { ctx, errs } = ctxFor(dir, fakeFetch(upd(patched)).fn);
    expect(await main(["pr", "update", "--pr", "42", "--body-file", body("## Tests\nExport of an empty invoice: passed.\n\n## Verification\nExtra.\n")], ctx, commands)).toBe(0);
    expect(patched[0].description).toContain("Export of an empty invoice: passed.");
    expect(patched[0].description).not.toContain("Verification");
    expect(errs.join("\n")).toContain('section "Verification" is not in the team template; left out');
  });

  it("a body with only unknown sections updates nothing; --section with an unknown heading is refused", async () => {
    const dir = repo();
    const patched: any[] = [];
    const a = ctxFor(dir, fakeFetch(upd(patched)).fn);
    expect(await main(["pr", "update", "--pr", "42", "--body-file", body("## Rollout\nx\n")], a.ctx, commands)).toBe(1);
    expect(a.errs.join("\n")).toContain("nothing updated");
    const b = ctxFor(dir, fakeFetch(upd(patched)).fn);
    expect(await main(["pr", "update", "--pr", "42", "--section", "Rollout", "--append-text", "x"], b.ctx, commands)).toBe(1);
    expect(b.errs.join("\n")).toContain('section "Rollout" is not in the team template or in this PR');
    expect(patched).toEqual([]);
  });

  it("refuses unit-test counts in an update", async () => {
    const dir = repo();
    const patched: any[] = [];
    const { ctx, errs } = ctxFor(dir, fakeFetch(upd(patched)).fn);
    expect(await main(["pr", "update", "--pr", "42", "--section", "Tests", "--append-text", "253 unit tests passed"], ctx, commands)).toBe(4);
    expect(errs.join("\n")).toContain("process noise");
    expect(patched).toEqual([]);
  });
});
