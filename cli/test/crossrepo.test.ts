import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commands, main } from "../src/router.js";
import { mapPaths, parsePathMap, swapRepoInUrl } from "../src/lib/crossRepo.js";
import { rewritePatch, splitPatch } from "../src/lib/port.js";
import { ctxFor, fakeFetch, sh, tmp, write, type Route } from "./helpers.js";

const ORG = "https://dev.azure.com/ferron-org/test-project/_git";
const API = "/ferron-org/test-project/_apis/";

/** Two sibling clones (test-project, test-developers) with bare remotes; origin URLs are ADO URLs rewritten to the bare repos. */
function world() {
  const base = tmp("aihub-cross-");
  const remotes = join(base, "remotes");
  mkdirSync(remotes);
  const make = (name: string) => {
    const bare = join(remotes, `${name}.git`);
    const dir = join(base, name);
    mkdirSync(bare);
    mkdirSync(dir);
    sh(bare, ["init", "--bare", "-b", "main"]);
    sh(dir, ["init", "-b", "main"]);
    for (const [k, v] of [
      ["user.name", "Test"],
      ["user.email", "test@example.com"],
      ["commit.gpgsign", "false"],
      ["remote.origin.url", `${ORG}/${name}`],
      ["remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
      [`url.${bare.replace(/\\/g, "/")}.insteadOf`, `${ORG}/${name}`],
    ])
      sh(dir, ["config", k, v]);
    return { dir, bare };
  };
  return { base, a: make("test-project"), b: make("test-developers") };
}
const commit = (dir: string, files: Record<string, string>, msg: string) => {
  for (const [f, t] of Object.entries(files)) write(dir, f, t);
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", msg]);
  return sh(dir, ["rev-parse", "HEAD"]);
};
const push = (dir: string) => {
  sh(dir, ["push", "origin", "main"]);
  sh(dir, ["fetch", "origin"]);
  sh(dir, ["remote", "set-head", "origin", "main"]);
};
const branches = (bare: string) => sh(bare, ["branch", "--list"]).split("\n").map((l) => l.replace(/^[*+]?\s+/, ""));
const show = (bare: string, ref: string, path: string) => sh(bare, ["show", `${ref}:${path}`]);

function seeded() {
  const w = world();
  commit(w.a.dir, { "src/app/a.py": "one\ntwo\nthree\n", "README.md": "a\n" }, "initial");
  push(w.a.dir);
  commit(w.b.dir, { "lib/app/a.py": "one\ntwo\nthree\n", "README.md": "b\n" }, "initial");
  push(w.b.dir);
  return w;
}
const MAP = "src/app=>lib/app";

describe("path helpers", () => {
  it("parses and applies path maps, longest prefix first, and reports unmapped files", () => {
    expect(parsePathMap("src/app/=>lib/app")).toEqual({ from: "src/app", to: "lib/app" });
    expect(parsePathMap("./=>.")).toEqual({ from: "", to: "" });
    expect(() => parsePathMap("nonsense")).toThrow(/srcDir=>dstDir/);
    const r = mapPaths(["src/app/a.py", "src/app/sub/b.py", "src/other.py", "docs/x.md"], [
      { from: "src", to: "code" },
      { from: "src/app", to: "lib/app" },
    ]);
    expect(r.mapped.map((m) => m.to)).toEqual(["lib/app/a.py", "lib/app/sub/b.py", "code/other.py"]);
    expect(r.unmapped).toEqual(["docs/x.md"]);
    expect(mapPaths(["a/b"], []).mapped).toEqual([{ from: "a/b", to: "a/b" }]);
  });

  it("splits a diff per file and rewrites header paths, also with spaces", () => {
    const diff = "diff --git a/src/my file.py b/src/my file.py\nindex 1..2 100644\n--- a/src/my file.py\n+++ b/src/my file.py\n@@ -1 +1 @@\n-a\n+src/my file.py b/src/my file.py\n";
    const [p] = splitPatch(diff);
    expect(p.path).toBe("src/my file.py");
    const out = rewritePatch(p, "lib/my file.py");
    expect(out).toContain("diff --git a/lib/my file.py b/lib/my file.py");
    expect(out).toContain("--- a/lib/my file.py\n+++ b/lib/my file.py\n");
    expect(out).toContain("+src/my file.py b/src/my file.py"); // body untouched
  });

  it("derives the remote of another repository", () => {
    expect(swapRepoInUrl(`${ORG}/test-project`, "test-project", "test-developers")).toBe(`${ORG}/test-developers`);
    expect(swapRepoInUrl("git@ssh.dev.azure.com:v3/o/p/test-project", "test-project", "test-developers")).toBe("git@ssh.dev.azure.com:v3/o/p/test-developers");
  });
});

describe("aihub port", () => {
  it("carries a commit into the other repo with rewritten paths and reports unmapped files", async () => {
    const w = seeded();
    const sha = commit(w.a.dir, { "src/app/a.py": "one\nTWO\nthree\n", "src/app/sub/b.py": "new\n", "docs/notes.md": "n\n" }, "fix: change two");
    push(w.a.dir);
    const headA = sh(w.a.dir, ["rev-parse", "HEAD"]);
    const { ctx, lines, errs } = ctxFor(w.a.dir, fakeFetch([]).fn);
    const code = await main(["port", "--from-repo", "test-project", "--from", sha, "--to-repo", "test-developers", "--path-map", MAP], ctx, commands);
    const out = lines.join("\n");
    expect(errs).toEqual([]);
    expect(code).toBe(0);
    const branch = `port/${sha.slice(0, 7)}-from-test-project`;
    expect(out).toContain(`ok  pushed ${branch}`);
    expect(out).toMatch(/not ported \(outside the path mapping, 1\):\n\s+docs\/notes\.md/);
    expect(branches(w.b.bare)).toContain(branch);
    expect(show(w.b.bare, branch, "lib/app/a.py")).toBe("one\nTWO\nthree");
    expect(show(w.b.bare, branch, "lib/app/sub/b.py")).toBe("new");
    expect(() => show(w.b.bare, branch, "docs/notes.md")).toThrow();
    expect(sh(w.b.bare, ["log", "-1", "--format=%s%n%b", branch])).toMatch(/fix: change two\nPorted from test-project/);
    // neither checkout nor worktree list is touched
    expect(sh(w.a.dir, ["rev-parse", "HEAD"])).toBe(headA);
    expect(sh(w.b.dir, ["status", "--porcelain"])).toBe("");
    expect(sh(w.b.dir, ["worktree", "list"]).split("\n")).toHaveLength(1);
  });

  it("uses a named map from team.yaml and --strict refuses unmapped files", async () => {
    const w = seeded();
    write(w.a.dir, ".agents/skills/_shared/references/team.yaml", "crossRepo:\n  pathMaps:\n    dev:\n      - from: src/app\n        to: lib/app\n");
    commit(w.a.dir, {}, "team config");
    const sha = commit(w.a.dir, { "src/app/a.py": "ONE\ntwo\nthree\n", "docs/notes.md": "n\n" }, "fix: upper");
    push(w.a.dir);
    const strict = ctxFor(w.a.dir, fakeFetch([]).fn);
    const c1 = await main(["port", "--from-repo", "test-project", "--from", sha, "--to-repo", "test-developers", "--map", "dev", "--strict"], strict.ctx, commands);
    expect(c1).toBe(1);
    expect(strict.errs.join("\n")).toMatch(/outside the path mapping and --strict/);
    expect(branches(w.b.bare).some((b) => b.startsWith("port/"))).toBe(false);
    const ok = ctxFor(w.a.dir, fakeFetch([]).fn);
    expect(await main(["port", "--from-repo", "test-project", "--from", sha, "--to-repo", "test-developers", "--map", "dev", "--json"], ok.ctx, commands)).toBe(0);
    const r = JSON.parse(ok.lines.join(""));
    expect(r.result).toBe("ok");
    expect(r.unmapped).toEqual(["docs/notes.md"]);
    expect(r.files).toEqual([{ from: "src/app/a.py", to: "lib/app/a.py" }]);
  });

  it("reports a conflict and pushes nothing", async () => {
    const w = seeded();
    commit(w.b.dir, { "lib/app/a.py": "one\nB-CHANGED\nthree\n" }, "b edit");
    push(w.b.dir);
    const sha = commit(w.a.dir, { "src/app/a.py": "one\nTWO\nthree\n" }, "fix: change two");
    push(w.a.dir);
    const { ctx, lines, errs } = ctxFor(w.a.dir, fakeFetch([]).fn);
    const code = await main(["port", "--from-repo", "test-project", "--from", sha, "--to-repo", "test-developers", "--path-map", MAP], ctx, commands);
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/conflict\s+conflict in lib\/app\/a\.py .*nothing pushed/);
    expect(errs.join("\n")).toMatch(/port stopped/);
    expect(branches(w.b.bare).some((b) => b.startsWith("port/"))).toBe(false);
    expect(sh(w.b.dir, ["worktree", "list"]).split("\n")).toHaveLength(1);
  });

  it("says already-applied when the target has the change and nothing-to-port when no file is mapped", async () => {
    const w = seeded();
    const sha = commit(w.a.dir, { "src/app/a.py": "one\nTWO\nthree\n" }, "fix: two");
    push(w.a.dir);
    commit(w.b.dir, { "lib/app/a.py": "one\nTWO\nthree\n" }, "same fix");
    push(w.b.dir);
    const c1 = ctxFor(w.a.dir, fakeFetch([]).fn);
    expect(await main(["port", "--from-repo", "test-project", "--from", sha, "--to-repo", "test-developers", "--path-map", MAP, "--json"], c1.ctx, commands)).toBe(0);
    expect(JSON.parse(c1.lines.join("")).result).toBe("already-applied");
    const docs = commit(w.a.dir, { "docs/x.md": "x\n" }, "docs");
    push(w.a.dir);
    const c2 = ctxFor(w.a.dir, fakeFetch([]).fn);
    expect(await main(["port", "--from-repo", "test-project", "--from", docs, "--to-repo", "test-developers", "--path-map", MAP, "--json"], c2.ctx, commands)).toBe(0);
    expect(JSON.parse(c2.lines.join("")).result).toBe("nothing-to-port");
  });

  it("ports a completed PR and creates a PR per the target repo template, linked to the source PR and story", async () => {
    const w = seeded();
    write(w.b.dir, ".azuredevops/pull_request_template.md", "## Beschrijving\n\n## Commits\n\n## Gerelateerde PR's\n");
    sh(w.b.dir, ["add", "."]);
    sh(w.b.dir, ["commit", "-m", "template"]);
    push(w.b.dir);
    const sha = commit(w.a.dir, { "src/app/a.py": "one\nTWO\nthree\n" }, "fix: change two");
    push(w.a.dir);
    write(w.a.dir, "body.md", "## Beschrijving\n\nPort van de fix.\n");
    let created: any;
    const routes: Route[] = [
      { match: /repositories\/test-project\/pullrequests\/5\?/, respond: () => ({ body: { pullRequestId: 5, status: "completed", sourceRefName: "refs/heads/feature/7-x", targetRefName: "refs/heads/main", lastMergeCommit: { commitId: sha } } }) },
      { match: /wit\/workitems\/7\?/, respond: () => ({ body: { fields: { "System.Title": "Synthetische story" } } }) },
      { method: "POST", match: /repositories\/test-developers\/pullrequests\?/, respond: (c) => ((created = c.body), { body: { pullRequestId: 31 } }) },
    ];
    const { ctx, lines } = ctxFor(w.a.dir, fakeFetch(routes).fn);
    const code = await main(["port", "--from-repo", "test-project", "--from", "pr:5", "--to-repo", "test-developers", "--path-map", MAP, "--pr", "--body-file", join(w.a.dir, "body.md")], ctx, commands);
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("PR !31 https://dev.azure.com/ferron-org/test-project/_git/test-developers/pullrequest/31");
    expect(created.sourceRefName).toBe("refs/heads/port/pr5-from-test-project");
    expect(created.targetRefName).toBe("refs/heads/main");
    expect(created.title).toMatch(/^Port pr5 from test-project: /);
    expect(created.description).toContain("Port van de fix.");
    expect(created.description).toMatch(/## Gerelateerde PR's\n\n- \[test-project !5\]\(https:\/\/dev\.azure\.com\/ferron-org\/test-project\/_git\/test-project\/pullrequest\/5\)/);
    expect(created.description).toContain(sha.slice(0, 7));
  });

  it("clones the other repository temporarily when it is not next to this one", async () => {
    const w = seeded();
    const sha = commit(w.a.dir, { "src/app/a.py": "one\nTWO\nthree\n" }, "fix: change two");
    push(w.a.dir);
    // move the target clone away so discovery fails; the remote stays reachable
    const lonely = tmp("aihub-lonely-");
    sh(lonely, ["clone", "-q", w.a.bare, "test-project"]);
    for (const [k, v] of [
      ["user.name", "Test"],
      ["user.email", "test@example.com"],
      ["remote.origin.url", `${ORG}/test-project`],
      [`url.${w.a.bare.replace(/\\/g, "/")}.insteadOf`, `${ORG}/test-project`],
      [`url.${w.b.bare.replace(/\\/g, "/")}.insteadOf`, `${ORG}/test-developers`],
    ])
      sh(join(lonely, "test-project"), ["config", k, v]);
    const { ctx, lines } = ctxFor(join(lonely, "test-project"), fakeFetch([]).fn);
    expect(await main(["port", "--from-repo", "test-project", "--from", sha, "--to-repo", "test-developers", "--path-map", MAP, "--json"], ctx, commands)).toBe(0);
    expect(JSON.parse(lines.join("")).result).toBe("ok");
    expect(branches(w.b.bare).some((b) => b.startsWith("port/"))).toBe(true);
  });
});

describe("aihub crossrepo test-resources", () => {
  function scenario() {
    const w = seeded();
    commit(w.a.dir, { "tests/data/orders.csv": "id\n1\n", "tests/data/skip.txt": "s\n", "src/app/b.py": "b\n" }, "test data");
    push(w.a.dir);
    sh(w.b.dir, ["push", "origin", "main:refs/heads/integration"]);
    write(w.a.dir, "tests/data/generated.csv", "id\n2\n"); // untracked generated resource
    write(
      w.a.dir,
      ".agents/skills/_shared/references/team.yaml",
      "branches:\n  protected: [main]\ncrossRepo:\n  testTarget:\n    repo: test-developers\n    branch: integration\n  testResources:\n    fromRepo: test-project\n    paths: ['tests/data/*.csv']\n    toPath: resources\n",
    );
    return w;
  }

  it("copies matching files (also generated ones) to the active branch of the other repo using the team defaults", async () => {
    const w = scenario();
    const { ctx, lines } = ctxFor(w.a.dir, fakeFetch([]).fn);
    write(w.a.dir, "msg.txt", "test: testresources van test-project\n");
    const code = await main(["crossrepo", "test-resources", "--message-file", join(w.a.dir, "msg.txt")], ctx, commands);
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/test-resources -> test-developers\/integration: ok/);
    expect(show(w.b.bare, "integration", "resources/tests/data/orders.csv")).toBe("id\n1");
    expect(show(w.b.bare, "integration", "resources/tests/data/generated.csv")).toBe("id\n2");
    expect(() => show(w.b.bare, "integration", "resources/tests/data/skip.txt")).toThrow();
    expect(sh(w.b.bare, ["log", "-1", "--format=%s", "integration"])).toBe("test: testresources van test-project");
    // main untouched; second run is a no-op
    expect(branches(w.b.bare)).toContain("main");
    expect(() => show(w.b.bare, "main", "resources/tests/data/orders.csv")).toThrow();
    const again = ctxFor(w.a.dir, fakeFetch([]).fn);
    expect(await main(["crossrepo", "test-resources"], again.ctx, commands)).toBe(0);
    expect(again.lines.join("\n")).toMatch(/: unchanged/);
  });

  it("refuses a protected target", async () => {
    const w = scenario();
    const { ctx, errs } = ctxFor(w.a.dir, fakeFetch([]).fn);
    expect(await main(["crossrepo", "test-resources", "--target", "main"], ctx, commands)).toBe(1);
    expect(errs.join("\n")).toMatch(/'main' is protected/);
  });

  it("queues and follows the pipeline of the other repo", async () => {
    const w = scenario();
    let queued: any;
    const routes: Route[] = [
      { match: /build\/definitions\?/, respond: () => ({ body: { value: [{ id: 9, name: "test-developers-robot" }] } }) },
      { method: "POST", match: /build\/builds\?/, respond: (c) => ((queued = c.body), { body: { id: 77, status: "notStarted" } }) },
      { match: /build\/builds\/77\/timeline/, respond: () => ({ body: { records: [] } }) },
      { match: /test\/runs/, respond: () => ({ body: { value: [{ name: "robot", totalTests: 4, passedTests: 4 }] } }) },
      { match: /build\/builds\/77\?/, respond: () => ({ body: { id: 77, status: "completed", result: "succeeded", buildNumber: "20260101.1" } }) },
    ];
    const { ctx, lines } = ctxFor(w.a.dir, fakeFetch(routes).fn);
    const code = await main(["crossrepo", "test-resources", "--run-pipeline", "test-developers-robot"], ctx, commands);
    expect(code).toBe(0);
    expect(queued.sourceBranch).toBe("refs/heads/integration");
    expect(lines.join("\n")).toMatch(/build 20260101\.1: succeeded/);
    expect(lines.join("\n")).toMatch(/tests robot: 4\/4 passed/);
  });
});

describe("aihub crossrepo status and link-prs", () => {
  const rel = (repoGuid: string, id: number) => ({ rel: "ArtifactLink", url: `vstfs:///Git/PullRequestId/proj-1%2F${repoGuid}%2F${id}`, attributes: { name: "Pull Request" } });
  const prA = { pullRequestId: 11, title: "Orders export", description: "## Beschrijving\n\nA kant\n", status: "active", sourceRefName: "refs/heads/feature/7-x", targetRefName: "refs/heads/main", repository: { id: "r-a", name: "test-project", project: { id: "proj-1" } } };
  const prB = { pullRequestId: 12, title: "Orders export (developers)", description: "## Beschrijving\n\nB kant\n\n## Gerelateerde PR's\n\n- oud\n", status: "completed", sourceRefName: "refs/heads/feature/7-x", targetRefName: "refs/heads/main", repository: { id: "r-b", name: "test-developers", project: { id: "proj-1" } } };
  const storyRoute = (rels: object[]): Route => ({ match: /wit\/workitems\/7\?/, respond: () => ({ body: { relations: rels } }) });
  const prRoutes: Route[] = [
    { match: new RegExp(`${API}git/pullrequests/11\\?`), respond: () => ({ body: prA }) },
    { match: new RegExp(`${API}git/pullrequests/12\\?`), respond: () => ({ body: prB }) },
  ];

  it("shows per repo branch, ahead/behind, PR status and pipeline", async () => {
    const w = seeded();
    const routes: Route[] = [
      storyRoute([rel("r-a", 11), rel("r-b", 12), { rel: "Hyperlink", url: "http://x" }]),
      ...prRoutes,
      { match: /repositories\/test-project\/stats\/branches\?/, respond: () => ({ body: { aheadCount: 3, behindCount: 1 } }) },
      { match: /repositories\/test-developers\/stats\/branches\?/, respond: () => ({ status: 404, body: { message: "gone" } }) },
      { match: /build\/builds\?.*pull%2F11%2Fmerge/, respond: () => ({ body: { value: [{ id: 5, status: "completed", result: "failed", definition: { id: 1, name: "tp-ci" } }] } }) },
      { match: /build\/builds\?/, respond: () => ({ body: { value: [] } }) },
    ];
    const { ctx, lines } = ctxFor(w.a.dir, fakeFetch(routes).fn);
    expect(await main(["crossrepo", "status", "--story", "7"], ctx, commands)).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("story 7: 2 pull request(s) in 2 repo(s)");
    expect(out).toContain("test-project: feature/7-x -> main  ahead 3 behind 1  PR !11 active  tp-ci failed");
    expect(out).toContain("test-developers: feature/7-x -> main  branch gone  PR !12 completed  no pipeline run");
    expect(out).toContain("/_git/test-developers/pullrequest/12");
  });

  it("cross-links the PRs in their descriptions, replacing an existing section and adding a missing one", async () => {
    const w = seeded();
    const patched: Record<number, string> = {};
    const routes: Route[] = [
      storyRoute([rel("r-a", 11), rel("r-b", 12)]),
      ...prRoutes,
      { method: "PATCH", match: /repositories\/test-project\/pullrequests\/11\?/, respond: (c) => ((patched[11] = c.body.description), { body: {} }) },
      { method: "PATCH", match: /repositories\/test-developers\/pullrequests\/12\?/, respond: (c) => ((patched[12] = c.body.description), { body: {} }) },
    ];
    const { ctx, lines } = ctxFor(w.a.dir, fakeFetch(routes).fn);
    write(w.a.dir, ".agents/skills/_shared/references/team.yaml", "language: nl\n");
    expect(await main(["crossrepo", "link-prs", "--story", "7"], ctx, commands)).toBe(0);
    expect(lines.join("\n")).toContain("test-project !11: related PRs section updated");
    expect(patched[11]).toContain("A kant");
    expect(patched[11]).toMatch(/## Gerelateerde PR's\n\n- \[test-developers !12\]\(https:\/\/dev\.azure\.com\/ferron-org\/test-project\/_git\/test-developers\/pullrequest\/12\) Orders export \(developers\) \(completed\)/);
    expect(patched[12]).toContain("B kant");
    expect(patched[12]).not.toContain("- oud");
    expect(patched[12]).toContain("[test-project !11]");
    expect((patched[12].match(/Gerelateerde PR's/g) ?? []).length).toBe(1);
  });

  it("links an extra PR to the story with an artifact link", async () => {
    const w = seeded();
    let linkOps: any;
    const routes: Route[] = [
      storyRoute([rel("r-a", 11)]),
      ...prRoutes,
      { match: /repositories\/test-developers\/pullrequests\/12\?/, respond: () => ({ body: prB }) },
      { method: "PATCH", match: /wit\/workitems\/7\?/, respond: (c) => ((linkOps = c.body), { body: {} }) },
      { method: "PATCH", match: /pullrequests\/1[12]\?/, respond: () => ({ body: {} }) },
    ];
    const { ctx, lines } = ctxFor(w.a.dir, fakeFetch(routes).fn);
    expect(await main(["crossrepo", "link-prs", "--story", "7", "--pr", "test-developers!12"], ctx, commands)).toBe(0);
    expect(linkOps[0].value.url).toBe("vstfs:///Git/PullRequestId/proj-1%2Fr-b%2F12");
    expect(lines.join("\n")).toContain("linked to story 7: !12");
  });

  it("refuses to link a story with a single PR", async () => {
    const w = seeded();
    const { ctx, errs } = ctxFor(w.a.dir, fakeFetch([storyRoute([rel("r-a", 11)]), ...prRoutes]).fn);
    expect(await main(["crossrepo", "link-prs", "--story", "7"], ctx, commands)).toBe(1);
    expect(errs.join("\n")).toMatch(/nothing to cross-link/);
  });
});

void readFileSync;
