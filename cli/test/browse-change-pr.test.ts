import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { browseOf } from "../src/lib/browse/core.js";
import { changePush, changeStart, changeSummary, changeWrite } from "../src/lib/browse/change.js";
import { verifyTests } from "../src/lib/browse/push.js";
import { mdToHtml } from "../src/lib/story.js";
import { ctxFor, fakeFetch, tmp, type Route } from "./helpers.js";

const C1 = "1".repeat(40);
const C3 = "3".repeat(40);
const TEAM_NL = 'version: 1\nlanguage: nl\npullRequest:\n  title: "{storyId}: {storyTitle}"\n  emptySection: n.v.t.\n';
const TEMPLATE = "## Samenvatting\n<wat en waarom>\n\n## Wijzigingen\n\n## Tests\n\n## Story\n";
const CRIT = "1. Een lege export heeft alleen de kopregel.\n   Hoe getest: Unit-test: test_lege_export\n   Bewijs: groen in de pipeline";

function world(o: { team?: string; criteria?: boolean } = {}) {
  const files: Record<string, string> = {
    "/src/load.py": "orders = read()\nwrite(orders)\n",
    "/.agents/skills/_shared/references/team.yaml": o.team ?? TEAM_NL,
    "/.azuredevops/pull_request_template.md": TEMPLATE,
  };
  const prs: any[] = [];
  const routes: Route[] = [
    { match: /\/_apis\/connectionData/, respond: () => ({ body: { authenticatedUser: { id: "me" } } }) },
    { match: /^https:\/\/dev\.azure\.com\/ferron-test\/_apis\/projects\?/, respond: () => ({ body: { value: [{ id: "p1", name: "test-project" }] } }) },
    { match: /^https:\/\/dev\.azure\.com\/ferron-test\/_apis\/git\/repositories\?/, respond: () => ({ body: { value: [{ id: "r1", name: "repo-a", defaultBranch: "refs/heads/main", project: { id: "p1", name: "test-project" } }] } }) },
    { match: /repo-a\?api-version/, respond: () => ({ body: { defaultBranch: "refs/heads/main" } }) },
    { match: /refs\?filter=heads%2Fmain/, respond: () => ({ body: { value: [{ name: "refs/heads/main", objectId: C1 }] } }) },
    { match: /refs\?filter=heads%2Ffeature/, respond: () => ({ body: { value: [] } }) },
    { match: /blobs\//, respond: () => ({ status: 404, body: { message: "not found" } }) },
    {
      match: /repo-a\/items\?path=/,
      respond: (c) => {
        const path = decodeURIComponent(/path=([^&]+)/.exec(c.url)![1]);
        const content = files[path];
        if (content === undefined) return { status: 404, body: { message: `TF401174: The item '${path}' could not be found` } };
        return { body: { objectId: `o${path}`, gitObjectType: "blob", commitId: C1, path, ...(c.url.includes("includeContent=true") ? { content } : {}) } };
      },
    },
    { match: /wit\/workitems\/4711/, respond: () => ({ body: { id: 4711, fields: { "System.Title": "Orderexport", "System.WorkItemType": "User Story", ...(o.criteria ? { "Microsoft.VSTS.Common.AcceptanceCriteria": mdToHtml(CRIT) } : {}) } } }) },
    { method: "POST", match: /repo-a\/pushes/, respond: () => ({ status: 201, body: { commits: [{ commitId: C3 }] } }) },
    { method: "POST", match: /repo-a\/pullrequests/, respond: (c) => (prs.push(c.body), { status: 201, body: { pullRequestId: 77, title: c.body.title } }) },
  ];
  const f = fakeFetch(routes);
  const { ctx } = ctxFor(tmp(), f.fn);
  ctx.env.AIHUB_ADO_ORG = "ferron-test";
  ctx.env.AIHUB_COMMON_ROOTS = "none";
  return { ctx, prs, b: () => browseOf(ctx, {}) };
}

describe("Create Pull Request from a change: the description by the one rule of pr create", () => {
  it("title from team.yaml, the agent's summary without process noise, the changed files, the checks of verify, the story; Dutch", async () => {
    const w = world();
    const s = await changeStart(w.b(), { project: "test-project", repo: "repo-a", story: 4711, paths: ["/src/load.py"], prompt: "Filter actieve klanten" });
    await changeWrite(w.b(), s.id, "/src/load.py", { content: "orders = [o for o in read() if o.active]\nwrite(orders)\n" });
    await changeWrite(w.b(), s.id, "/tests/test_load.py", { content: "def test_x():\n    assert True\n" });
    changeSummary(w.ctx.env, s.id, "Alleen orders van actieve klanten worden geladen.\n12 unit tests passed\n");
    writeFileSync(
      join(s.dir, "verify.json"),
      JSON.stringify({ checks: [{ name: "guidelines", kind: "lint", status: "passed", errors: [] }, { name: "tests", kind: "test", status: "failed", command: "python -m pytest tests/test_load.py", errors: [{ path: "/tests/test_load.py", line: 2, message: "AssertionError" }] }] }),
    );
    const r = await changePush(w.b(), s.id, { pr: true });
    expect(r).toMatchObject({ status: "pushed", pr: { id: 77, title: "4711: Orderexport", draft: false } });
    const body = w.prs[0];
    expect(body.title).toBe("4711: Orderexport");
    expect(body.workItemRefs).toEqual([{ id: "4711" }]);
    const d: string = body.description;
    expect(d).toContain("## Samenvatting\n\nAlleen orders van actieve klanten worden geladen.");
    expect(d).not.toContain("12 unit tests passed");
    expect(d).toContain("## Wijzigingen\n\n- src/load.py\n- tests/test_load.py (nieuw)");
    expect(d).toContain("## Tests\n\n- Lint (guidelines): geslaagd\n- Tests (tests, python -m pytest tests/test_load.py): gefaald: /tests/test_load.py:2 AssertionError");
    expect(d).toContain("AB#4711");
    expect(d).not.toMatch(/Not run yet|<wat en waarom>/);
  });

  it("without verify the Tests section says honestly that nothing ran; a story with unproven criteria gets its table and a draft", async () => {
    const w = world({ criteria: true });
    const s = await changeStart(w.b(), { project: "test-project", repo: "repo-a", story: 4711, paths: ["/src/load.py"], prompt: "x" });
    await changeWrite(w.b(), s.id, "/src/load.py", { content: "orders = []\n" });
    const r = await changePush(w.b(), s.id, { pr: true });
    expect(r).toMatchObject({ status: "pushed", pr: { draft: true, criteria: { proven: 0, total: 1 } } });
    expect((r as { pr: { draftReason?: string } }).pr.draftReason).toMatch(/0\/1 acceptance criteria proven/);
    const d: string = w.prs[0].description;
    expect(w.prs[0].isDraft).toBe(true);
    expect(d).toContain("## Tests\n\nNog niet uitgevoerd.");
    expect(d).toContain("Acceptatiecriteria");
    expect(d).toContain("Een lege export heeft alleen de kopregel.");
  });

  it("an English team: English words, the title pattern's default when team.yaml has none", async () => {
    const w = world({ team: "version: 1\nlanguage: en\n" });
    const s = await changeStart(w.b(), { project: "test-project", repo: "repo-a", paths: ["/src/load.py"], prompt: "x" });
    await changeWrite(w.b(), s.id, "/src/load.py", { content: "orders = []\n" });
    await changePush(w.b(), s.id, { pr: true, message: "Keep only active orders" });
    expect(w.prs[0].description).toContain("## Tests\n\nNot run yet.");
    expect(w.prs[0].title).toBe("Keep only active orders");
    expect(verifyTests({ checks: [{ name: "ruff", kind: "lint", status: "skipped", reason: "not installed", errors: [] }] }, "en")).toBe("- Lint (ruff): not run (not installed)");
  });
});
