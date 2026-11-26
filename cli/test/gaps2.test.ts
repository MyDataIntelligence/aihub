import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, sh, tmp, write, type Route } from "./helpers.js";

describe("aihub pipeline retry", () => {
  const timeline = (stages: object[]) => ({ records: stages });
  const stage = (id: string, name: string, result: string) => ({ id, type: "Stage", name, identifier: id, result });

  it("retries the failed stages through the preview stages endpoint", async () => {
    const { dir } = makeRepo();
    const patched: { url: string; body: any }[] = [];
    const routes: Route[] = [
      { match: /build\/builds\/12\/timeline/, respond: () => ({ body: timeline([stage("Build", "Build", "succeeded"), stage("Test", "Test", "failed")]) }) },
      { method: "PATCH", match: /build\/builds\/12\/stages\//, respond: (c) => (patched.push({ url: c.url, body: c.body }), { body: {} }) },
    ];
    const { ctx, lines } = ctxFor(dir, fakeFetch(routes).fn);
    expect(await main(["pipeline", "retry", "--run", "12"], ctx)).toBe(0);
    expect(patched).toHaveLength(1);
    expect(patched[0].url).toContain("/build/builds/12/stages/Test?api-version=7.1-preview.1");
    expect(patched[0].body).toEqual({ state: "retry", forceRetryAllJobs: false });
    expect(lines[0]).toContain("retrying stage Test");

    patched.length = 0;
    expect(await main(["pipeline", "retry", "--run", "12", "--stage", "build"], ctx)).toBe(0);
    expect(patched[0].url).toContain("/stages/Build?");
  });

  it("explains when nothing failed, and requeues a run without stages", async () => {
    const { dir } = makeRepo();
    const posted: any[] = [];
    const ok = ctxFor(dir, fakeFetch([{ match: /build\/builds\/12\/timeline/, respond: () => ({ body: timeline([stage("Build", "Build", "succeeded")]) }) }]).fn);
    expect(await main(["pipeline", "retry", "--run", "12"], ok.ctx)).toBe(1);
    expect(ok.errs[0]).toContain("no failed stage to retry");

    const classic: Route[] = [
      { match: /build\/builds\/12\/timeline/, respond: () => ({ body: timeline([]) }) },
      { match: /build\/builds\/12\?/, respond: () => ({ body: { id: 12, sourceBranch: "refs/heads/f", definition: { id: 3, name: "ci" } } }) },
      { method: "POST", match: /build\/builds\?/, respond: (c) => (posted.push(c.body), { body: { id: 13 } }) },
    ];
    const c = ctxFor(dir, fakeFetch(classic).fn);
    expect(await main(["pipeline", "retry", "--run", "12"], c.ctx)).toBe(0);
    expect(posted).toEqual([{ definition: { id: 3 }, sourceBranch: "refs/heads/f" }]);
    expect(c.lines[0]).toContain("queued ci again as run 13");
  });
});

describe("aihub workitem create", () => {
  const created: { url: string; body: any[] }[] = [];
  const routes = (): Route[] => [
    { method: "POST", match: /wit\/workitems\/\$/, respond: (c) => (created.push({ url: c.url, body: c.body }), { body: { id: 301 } }) },
  ];

  it("creates a Bug from the built-in template with all its text in the repro field", async () => {
    const { dir } = makeRepo();
    created.length = 0;
    const f = join(tmp(), "bug.md");
    writeFileSync(f, "## Description\nExport crashes on empty invoices.\n\n## Steps to reproduce\n1. open invoice\n2. export\n\n## Expected result\nAn empty CSV.\n");
    const { ctx, lines, errs } = ctxFor(dir, fakeFetch(routes()).fn);
    expect(await main(["workitem", "create", "--type", "bug", "--title", "Export crash", "--body-file", f, "--parent", "7"], ctx)).toBe(0);
    expect(errs).toEqual([]);
    const c = created[0];
    expect(c.url).toContain("/wit/workitems/$Bug?");
    const field = (n: string) => c.body.find((o) => o.path === `/fields/${n}`)?.value as string;
    expect(field("System.Title")).toBe("Export crash");
    expect(field("Microsoft.VSTS.TCM.ReproSteps")).toContain("open invoice");
    expect(field("Microsoft.VSTS.TCM.ReproSteps")).toContain("Export crashes on empty invoices.");
    expect(field("Microsoft.VSTS.TCM.ReproSteps")).toContain("Expected result");
    expect(field("Microsoft.VSTS.TCM.ReproSteps")).toContain("Actual result");
    expect(c.body.some((o) => o.path === "/fields/System.Description")).toBe(false);
    expect(c.body.find((o) => o.path === "/relations/-").value.url).toContain("/_apis/wit/workItems/7");
    expect(lines[0]).toContain("Bug 301 created");
    expect(lines[0]).toContain("child of 7");
    expect(lines[0]).toContain("Actual result");
  });

  it("uses the team template and field mapping for a Task", async () => {
    const { dir } = makeRepo();
    created.length = 0;
    write(dir, ".agents/skills/_shared/assets/task-template.md", "## Beschrijving\n\n## Klaar als\n");
    write(
      dir,
      ".agents/skills/_shared/references/team.yaml",
      "workItems:\n  templates:\n    Task: .agents/skills/_shared/assets/task-template.md\n  emptySection: n.v.t.\n  sectionFields:\n    Klaar als: Microsoft.VSTS.Common.AcceptanceCriteria\n  areaPath: test-project\\Team\n",
    );
    const f = join(tmp(), "task.md");
    writeFileSync(f, "## Beschrijving\nRapport bijwerken\n\n## Klaar als\n- [ ] rapport klopt\n");
    const { ctx, errs } = ctxFor(dir, fakeFetch(routes()).fn);
    expect(await main(["workitem", "create", "--type", "Task", "--title", "Rapport", "--body-file", f, "--json"], ctx)).toBe(0);
    expect(errs).toEqual([]);
    const body = created[0].body;
    expect(created[0].url).toContain("$Task");
    expect(body.find((o) => o.path === "/fields/Microsoft.VSTS.Common.AcceptanceCriteria").value).toContain("rapport klopt");
    expect(body.find((o) => o.path === "/fields/System.Description").value).toContain("Rapport bijwerken");
    expect(body.find((o) => o.path === "/fields/System.AreaPath").value).toBe("test-project\\Team");
    expect(body.some((o) => o.path === "/relations/-")).toBe(false);
  });

  it("rejects other types and missing input", async () => {
    const { dir } = makeRepo();
    const { ctx, errs } = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(["workitem", "create", "--type", "Epic", "--title", "x", "--body-file", "x.md"], ctx)).toBe(1);
    expect(errs[0]).toContain("stories go through 'aihub story create'");
    expect(await main(["workitem", "create", "--type", "Bug", "--body-file", "x.md"], ctx)).toBe(1);
    expect(errs[1]).toContain("needs --title");
  });
});

describe("aihub repos", () => {
  it("lists the project's repositories, marking local clones, and clones missing ones next to this one", async () => {
    const { dir, bare } = makeRepo();
    const remote = bare.replace(/\\/g, "/");
    const routes: Route[] = [
      {
        match: /_apis\/git\/repositories\?/,
        respond: () => ({
          body: {
            value: [
              { id: "1", name: "test-repo", defaultBranch: "refs/heads/main", remoteUrl: "https://user@dev.azure.com/ferron-org/test-project/_git/test-repo" },
              { id: "2", name: "other-repo", defaultBranch: "refs/heads/main", remoteUrl: remote },
              { id: "3", name: "off", isDisabled: true, remoteUrl: remote },
            ],
          },
        }),
      },
    ];
    const { ctx, lines, errs } = ctxFor(dir, fakeFetch(routes).fn);
    // the test checkout is called "work"; pretend a clone of test-repo is next to it
    const parent = join(dir, "..");
    sh(parent, ["clone", "--quiet", remote, "test-repo"]);
    expect(await main(["repos", "list"], ctx)).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("2 repositories");
    expect(out).toMatch(/test-repo\s+main\s+cloned: /);
    expect(out).toMatch(/other-repo\s+main\s+not cloned/);
    expect(out).not.toContain("off");

    lines.length = 0;
    expect(await main(["repos", "clone", "--name", "other-repo,test-repo"], ctx)).toBe(0);
    expect(errs).toEqual([]);
    expect(existsSync(join(parent, "other-repo", ".git"))).toBe(true);
    expect(lines.join("\n")).toContain("other-repo: cloned at");
    expect(lines.join("\n")).toContain("test-repo: already there");

    // --root that does not exist yet is created (live: "git is not available: spawnSync git ENOENT")
    const fresh = join(dir, "..", "fresh-root", "deeper");
    expect(await main(["repos", "clone", "--name", "other-repo", "--root", fresh], ctx)).toBe(0);
    expect(existsSync(join(fresh, "other-repo", ".git"))).toBe(true);

    expect(await main(["repos", "clone", "--name", "nope"], ctx)).toBe(1);
    expect(errs[0]).toContain("not found in the project");
    expect(await main(["repos", "list", "--filter", "other", "--json"], ctx)).toBe(0);
    expect(JSON.parse(lines.at(-1)!)).toHaveLength(1);
  });
});
