import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { commands, main } from "../src/router.js";
import { ctxFor, fakeFetch, sh, tmp, write, type Route } from "./helpers.js";
import { makeNamedRepo, newParent, storyRoutes } from "./parity-helpers.js";

const run = (dir: string, routes: Route[], argv: string[]) => {
  const { fn: inner, calls } = fakeFetch(routes);
  // binary request bodies (attachments) are not JSON: hand the fake a placeholder
  const fn = ((u: any, init: any = {}) => inner(u, init?.body instanceof Uint8Array ? { ...init, body: '"<binary>"' } : init)) as typeof fetch;
  const { ctx, lines, errs } = ctxFor(dir, fn);
  return main(argv, ctx, commands).then((code) => ({ code, lines, errs, calls, out: lines.join("\n") }));
};

const file = (name: string, content: string | Buffer) => {
  const p = join(tmp(), name);
  writeFileSync(p, content);
  return p;
};

describe("aihub worktree", () => {
  it("creates a set with one worktree per repository, lists it and removes it safely", async () => {
    const parent = newParent();
    const a = makeNamedRepo(parent, "repo-a");
    const b = makeNamedRepo(parent, "repo-b");
    const root = join(parent, "sets");
    const c = await run(a.dir, [], ["worktree", "create", "--story", "9", "--repos", "repo-a,repo-b", "--root", root, "--branch", "feature/9-x"]);
    expect(c.errs).toEqual([]);
    expect(existsSync(join(root, "9-x", "repo-a", "README.md"))).toBe(true);
    expect(sh(join(root, "9-x", "repo-b"), ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/9-x");
    expect(sh(b.dir, ["worktree", "list"])).toContain("9-x");

    const l = await run(a.dir, [], ["worktree", "list", "--root", root]);
    expect(l.out).toContain("story 9 'feature/9-x'");
    expect(l.out).toContain("repo-a: clean");

    // dirty worktree is kept, clean one removed
    write(join(root, "9-x", "repo-a"), "wip.txt", "unsaved\n");
    const r1 = await run(a.dir, [], ["worktree", "remove", "--story", "9", "--root", root]);
    expect(r1.out).toContain("repo-a: kept, uncommitted changes");
    expect(r1.out).toContain("repo-b: worktree removed");
    expect(existsSync(join(root, "9-x", "repo-a", "wip.txt"))).toBe(true);
    expect(existsSync(join(root, "9-x", "repo-b"))).toBe(false);
    expect(sh(b.dir, ["branch", "--list"])).toContain("feature/9-x");

    // unpushed commits are kept too
    sh(join(root, "9-x", "repo-a"), ["add", "."]);
    sh(join(root, "9-x", "repo-a"), ["commit", "-m", "local only"]);
    const r2 = await run(a.dir, [], ["worktree", "remove", "--story", "9", "--root", root]);
    expect(r2.out).toContain("1 unpushed commit");
    sh(join(root, "9-x", "repo-a"), ["push", "origin", "feature/9-x"]);
    const r3 = await run(a.dir, [], ["worktree", "remove", "--story", "9", "--root", root]);
    expect(r3.out).toContain("set for story 9 removed");
    expect(existsSync(join(root, "9-x"))).toBe(false);
  });

  it("refuses when the story branch is checked out in the source repository", async () => {
    const parent = newParent();
    const a = makeNamedRepo(parent, "repo-a");
    sh(a.dir, ["checkout", "-b", "feature/3-y"]);
    const r = await run(a.dir, [], ["worktree", "create", "--story", "3", "--repos", "repo-a", "--root", join(parent, "sets"), "--branch", "feature/3-y"]);
    expect(r.code).toBe(1);
    expect(r.errs.join("\n")).toContain("already checked out");
  });

  it("names the branch from the work item title when no branch exists", async () => {
    const parent = newParent();
    const a = makeNamedRepo(parent, "repo-a");
    const r = await run(a.dir, storyRoutes(11, { title: "Nieuwe zaak" }), ["worktree", "create", "--story", "11", "--repos", "repo-a", "--root", join(parent, "sets")]);
    expect(r.errs).toEqual([]);
    expect(sh(join(parent, "sets", "11-nieuwe-zaak", "repo-a"), ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/11-nieuwe-zaak");
  });
});

const PR = (id: number, extra: object = {}) => ({
  pullRequestId: id,
  title: "Zoek bouwen",
  description: "## Tests\n\nnog niets\n",
  status: "active",
  sourceRefName: "refs/heads/feature/1234-zoek",
  targetRefName: "refs/heads/main",
  createdBy: { displayName: "Dev One", id: "u1" },
  lastMergeSourceCommit: { commitId: "bbb" },
  ...extra,
});

function prRoutes(id: number): Route[] {
  return [
    { match: new RegExp(`/pullrequests/${id}\\?`), respond: () => ({ body: PR(id) }) },
    { match: new RegExp(`/pullrequests/${id}/iterations\\?`), respond: () => ({ body: { value: [{ id: 1 }, { id: 2, sourceRefCommit: { commitId: "bbb" }, commonRefCommit: { commitId: "aaa" } }] } }) },
    {
      match: new RegExp(`/iterations/2/changes\\?`),
      respond: () => ({ body: { changeEntries: [{ changeType: "edit", item: { path: "/a.py" } }, { changeType: "add", item: { path: "/b.py" } }, { changeType: "edit", item: { path: "/dir", isFolder: true } }] } }),
    },
    {
      match: /\/items\?/,
      respond: (c) => {
        const u = decodeURIComponent(c.url);
        const base = u.includes("version=aaa");
        return { text: u.includes("path=/a.py") ? (base ? "x = 1\ny = 2\n" : "x = 1\ny = 3\n") : "new file\n" };
      },
    },
    { match: new RegExp(`/pullrequests/${id}/threads\\?`), respond: () => ({ body: { value: [{ id: 7, status: "active", comments: [{ id: 1, content: "waarom?", author: { displayName: "Rev" } }] }] } }) },
  ];
}

describe("aihub review and pr", () => {
  it("review show: files with diffs and threads, accepts a PR url", async () => {
    const { dir } = makeNamedRepo(newParent(), "test-repo");
    const r = await run(dir, prRoutes(5), ["review", "show", "--pr", "https://dev.azure.com/ferron-org/test-project/_git/test-repo/pullrequest/5"]);
    expect(r.errs).toEqual([]);
    expect(r.out).toContain("!5 Zoek bouwen");
    expect(r.out).toContain("### edit /a.py (+1 -1)");
    expect(r.out).toContain("-    2 y = 2");
    expect(r.out).toContain("+    2 y = 3");
    expect(r.out).toContain("### add /b.py (+1 -0)");
    expect(r.out).not.toContain("/dir");
    expect(r.out).toContain("[7] (general) (active) Rev: waarom?");
  });

  it("review post creates one thread per comment, file comments with a line", async () => {
    const { dir } = makeNamedRepo(newParent(), "test-repo");
    const posted: any[] = [];
    const cf = file("c.yaml", "- file: src/a.py\n  line: 12\n  text: Controleer de rand.\n- text: Mooi werk.\n");
    const routes: Route[] = [
      { method: "POST", match: /pullrequests\/5\/threads\?/, respond: (c) => (posted.push(c.body), { body: { id: 100 + posted.length } }) },
      ...prRoutes(5),
    ];
    const r = await run(dir, routes, ["review", "post", "--pr", "5", "--comments-file", cf]);
    expect(r.errs).toEqual([]);
    expect(posted).toHaveLength(2);
    expect(posted[0].threadContext.filePath).toBe("/src/a.py");
    expect(posted[0].threadContext.rightFileStart.line).toBe(12);
    expect(posted[0].comments[0].content).toBe("Controleer de rand.");
    expect(posted[1].threadContext).toBeUndefined();
    expect(r.out).toContain("2 thread(s) created");
  });

  it("review post rejects a line without a file", async () => {
    const { dir } = makeNamedRepo(newParent(), "test-repo");
    const r = await run(dir, [], ["review", "post", "--pr", "5", "--comments-file", file("c.yaml", "- line: 3\n  text: x\n")]);
    expect(r.code).toBe(1);
    expect(r.errs.join("")).toContain("a line needs a file");
  });

  it("pr explain gives compact facts", async () => {
    const { dir } = makeNamedRepo(newParent(), "test-repo");
    const routes: Route[] = [
      { match: /_apis\/wit\/workitems\/1234\?/, respond: () => ({ body: { fields: { "System.Title": "Zoeken", "System.State": "Active" } } }) },
      { match: /_apis\/build\/builds\?/, respond: () => ({ body: { value: [{ definition: { name: "ci" }, status: "completed", result: "succeeded" }, { definition: { name: "ci" }, status: "completed", result: "failed" }] } }) },
      ...prRoutes(5),
    ];
    const r = await run(dir, routes, ["pr", "explain", "--pr", "5"]);
    expect(r.errs).toEqual([]);
    expect(r.out).toContain("Story: AB#1234 Zoeken (Active)");
    expect(r.out).toContain("Files: 2 (1 edit, 1 add)");
    expect(r.out).toContain("Pipelines: ci succeeded");
    expect(r.out).toContain("Threads: 1 (1 open)");
  });

  it("pr complete --auto without policies says it completed immediately (live: ferron-test)", async () => {
    const { dir } = makeNamedRepo(newParent(), "test-repo");
    const patched: any[] = [];
    const routes: Route[] = [
      { match: /_apis\/connectionData\?/, respond: () => ({ body: { authenticatedUser: { id: "me-1" } } }) },
      { method: "PATCH", match: /pullrequests\/5\?/, respond: (c) => (patched.push(c.body), { body: PR(5) }) },
      // after the PATCH Azure DevOps has completed the PR
      { match: /pullrequests\/5\?/, respond: () => ({ body: PR(5, patched.length ? { status: "completed" } : {}) }) },
      ...prRoutes(5).slice(1),
    ];
    const r = await run(dir, routes, ["pr", "complete", "--pr", "5", "--auto", "--delete-source", "--squash"]);
    expect(r.errs).toEqual([]);
    expect(patched[0]).toEqual({ autoCompleteSetBy: { id: "me-1" }, completionOptions: { deleteSourceBranch: true, bypassPolicy: false, mergeStrategy: "squash" } });
    expect(r.out).toContain("completed immediately");
    expect(r.out).not.toContain("auto-complete set");
  });

  it("pr complete --auto with a blocking policy names what it waits for", async () => {
    const { dir } = makeNamedRepo(newParent(), "test-repo");
    const routes: Route[] = [
      { match: /_apis\/connectionData\?/, respond: () => ({ body: { authenticatedUser: { id: "me-1" } } }) },
      { method: "PATCH", match: /pullrequests\/5\?/, respond: () => ({ body: PR(5) }) },
      { match: /\/_apis\/git\/repositories\/[^/?]+\?/, respond: () => ({ body: { id: "repo-1", project: { id: "proj-1" } } }) },
      {
        match: /_apis\/policy\/evaluations\?/,
        respond: () => ({ body: { value: [{ evaluationId: "e1", status: "queued", configuration: { isEnabled: true, isBlocking: true, type: { displayName: "Build" }, settings: { displayName: "ci" } } }] } }),
      },
      ...prRoutes(5),
    ];
    const r = await run(dir, routes, ["pr", "complete", "--pr", "5", "--auto"]);
    expect(r.errs).toEqual([]);
    expect(r.out).toContain("auto-complete set, it merges when: Build (ci) is queued");
  });

  it("pr complete without --auto completes with the source commit; refuses drafts", async () => {
    const { dir } = makeNamedRepo(newParent(), "test-repo");
    const patched: any[] = [];
    const patchRoute: Route = { method: "PATCH", match: /pullrequests\/5\?/, respond: (c) => (patched.push(c.body), { body: PR(5, { status: "completed" }) }) };
    const ok = await run(dir, [patchRoute, ...prRoutes(5)], ["pr", "complete", "--pr", "5"]);
    expect(ok.errs).toEqual([]);
    expect(patched[0].status).toBe("completed");
    expect(patched[0].lastMergeSourceCommit.commitId).toBe("bbb");
    expect(patched[0].completionOptions.bypassPolicy).toBe(false);
    const draft = await run(dir, [{ match: /pullrequests\/5\?/, respond: () => ({ body: PR(5, { isDraft: true }) }) }], ["pr", "complete", "--pr", "5"]);
    expect(draft.errs.join("")).toContain("draft");
  });
});

describe("aihub workitem state", () => {
  it("sets the state, and is a no-op when it already matches", async () => {
    const { dir } = makeNamedRepo(newParent(), "test-repo");
    const patches: { ops: any[]; contentType: string }[] = [];
    const r = await run(dir, storyRoutes(4, { state: "Active" }, patches), ["workitem", "state", "--id", "4", "--to", "Resolved"]);
    expect(r.out).toBe("work item 4: Active -> Resolved");
    expect(patches[0].ops[0]).toEqual({ op: "add", path: "/fields/System.State", value: "Resolved" });
    const same = await run(dir, storyRoutes(4, { state: "Resolved" }, patches), ["workitem", "state", "--id", "4", "--to", "resolved"]);
    expect(same.out).toContain("already Resolved");
    expect(patches).toHaveLength(1);
  });
});

describe("aihub wiki update", () => {
  const wikiRoutes = (existing: string | undefined, puts: any[]): Route[] => [
    { match: /_apis\/wiki\/wikis\?/, respond: () => ({ body: { value: [{ id: "w1", name: "test-project.wiki", type: "projectWiki" }] } }) },
    {
      match: /_apis\/wiki\/wikis\/w1\/pages\?/,
      respond: () => (existing === undefined ? { status: 404, body: { message: "page not found" } } : { body: { content: existing }, headers: { etag: '"v7"' } }),
    },
    { method: "PUT", match: /_apis\/wiki\/wikis\/w1\/pages\?/, respond: (c) => (puts.push({ body: c.body, ifMatch: c.headers["If-Match"], url: c.url }), { body: {} }) },
  ];

  it("shows only the diff without --publish", async () => {
    const { dir } = makeNamedRepo(newParent(), "test-repo");
    const puts: any[] = [];
    const r = await run(dir, wikiRoutes("# T\n\nold\n", puts), ["wiki", "update", "--page", "Team/Home", "--body-file", file("b.md", "# T\n\nnew\n")]);
    expect(r.out).toContain("+1 -1 (not published");
    expect(r.out).toContain("- ");
    expect(puts).toEqual([]);
  });

  it("publishes with the page version and creates a new page without one", async () => {
    const { dir } = makeNamedRepo(newParent(), "test-repo");
    const puts: any[] = [];
    await run(dir, wikiRoutes("old\n", puts), ["wiki", "update", "--page", "/Team/Home.md", "--body-file", file("b.md", "new\n"), "--publish"]);
    expect(puts[0].ifMatch).toBe('"v7"');
    expect(puts[0].body).toEqual({ content: "new\n" });
    expect(decodeURIComponent(puts[0].url)).toContain("path=/Team/Home");
    const fresh: any[] = [];
    const r = await run(dir, wikiRoutes(undefined, fresh), ["wiki", "update", "--page", "Nieuw", "--body-file", file("b.md", "hallo\n"), "--publish"]);
    expect(r.out).toContain("new page");
    expect(fresh[0].ifMatch).toBeUndefined();
  });
});

describe("aihub evidence add", () => {
  it("uploads the image and links it in the Tests section", async () => {
    const { dir } = makeNamedRepo(newParent(), "test-repo");
    const patched: any[] = [];
    const uploads: string[] = [];
    const routes: Route[] = [
      { method: "POST", match: /pullrequests\/5\/attachments\/shot\.png\?/, respond: (c) => (uploads.push(c.headers["Content-Type"]), { body: { url: "https://example.invalid/att/shot.png" } }) },
      { method: "PATCH", match: /pullrequests\/5\?/, respond: (c) => (patched.push(c.body), { body: {} }) },
      ...prRoutes(5),
    ];
    const img = file("shot.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const r = await run(dir, routes, ["evidence", "add", "--pr", "5", "--file", img, "--caption", "Zoekresultaat"]);
    expect(r.errs).toEqual([]);
    expect(uploads).toEqual(["application/octet-stream"]);
    expect(patched[0].description).toContain("nog niets\n\n![Zoekresultaat](https://example.invalid/att/shot.png)");
    const bad = await run(dir, routes, ["evidence", "add", "--pr", "5", "--file", file("x.txt", "t")]);
    expect(bad.errs.join("")).toContain("only image files");
  });
});

describe("aihub release plan and run", () => {
  function setup() {
    const parent = newParent();
    const { dir, bare } = makeNamedRepo(parent, "test-repo");
    sh(dir, ["checkout", "-b", "feature/1-a"]);
    write(dir, "a.txt", "a\n");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "feat: a"]);
    const c1 = sh(dir, ["rev-parse", "HEAD"]);
    write(dir, "b.txt", "b\n");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "feat: b"]);
    const c2 = sh(dir, ["rev-parse", "HEAD"]);
    sh(dir, ["push", "origin", "feature/1-a"]);
    sh(dir, ["checkout", "main"]);
    return { dir, bare, c1, c2 };
  }
  const done = (id: number, commit: string, closed: string, story?: number) => ({
    match: new RegExp(`/pullrequests/${id}\\?`),
    respond: () => ({ body: { pullRequestId: id, title: `PR ${id}`, status: "completed", closedDate: closed, lastMergeCommit: { commitId: commit }, workItemRefs: story ? [{ id: String(story) }] : [], sourceRefName: "refs/heads/x", targetRefName: "refs/heads/main" } }),
  });

  it("plans from PRs in merge order and skips PRs that are not completed", async () => {
    const { dir, c1, c2 } = setup();
    const routes: Route[] = [
      done(42, c2, "2026-01-02", 12),
      done(41, c1, "2026-01-01"),
      { match: /pullrequests\/43\?/, respond: () => ({ body: { pullRequestId: 43, title: "open", status: "active", sourceRefName: "refs/heads/y", targetRefName: "refs/heads/main" } }) },
    ];
    const out = join(tmp(), "plan.yaml");
    const r = await run(dir, routes, ["release", "plan", "--prs", "42,41,43", "--target", "main", "--also-cherry-pick-to", "staging", "--name", "release/t1", "--out", out]);
    expect(r.errs).toEqual([]);
    const plan = parse(readFileSync(out, "utf8"));
    expect(plan.items.map((i: any) => i.pr)).toEqual([41, 42]);
    expect(plan.items[1].story).toBe(12);
    expect(plan.targets).toEqual(["main", "staging"]);
    expect(plan.notes[0]).toContain("!43: skipped");
  });

  it("plans from commits and tags next to PRs, named by --version", async () => {
    const { dir, c1, c2 } = setup();
    sh(dir, ["tag", "v1.0.0", c1]);
    sh(dir, ["tag", "v1.1.0", c2]);
    const routes: Route[] = [done(41, c1, "2026-01-01")];
    const out = join(tmp(), "plan.yaml");
    const r = await run(dir, routes, ["release", "plan", "--prs", "41", "--tags", "v1.0.0,v1.1.0", "--commits", c1, "--version", "1.2.0", "--out", out]);
    expect(r.errs).toEqual([]);
    const plan = parse(readFileSync(out, "utf8"));
    expect(plan.name).toBe("release/1.2.0");
    expect(plan.items.map((i: any) => [i.pr, i.commit])).toEqual([[41, c1], [undefined, c2]]);
    const one = await run(dir, [], ["release", "plan", "--tags", "v1.0.0", "--json"]);
    expect(JSON.parse(one.out).items.map((i: any) => i.commit)).toEqual([c1]);
    const bad = await run(dir, [], ["release", "plan", "--tags", "v9"]);
    expect(bad.errs.join("")).toContain("not a commit or tag");
  });

  it("run cherry-picks onto a release branch per target and opens PRs", async () => {
    const { dir, bare, c1, c2 } = setup();
    sh(dir, ["push", "origin", "main:refs/heads/staging"]);
    sh(dir, ["fetch", "origin"]);
    const plan = file("plan.yaml", `version: 1\nrepo: test-repo\nname: release/t1\ntargets: [main, staging]\nitems:\n  - {pr: 41, title: PR 41, commit: ${c1}}\n  - {pr: 42, title: PR 42, commit: ${c2}, story: 12}\n`);
    const created: any[] = [];
    const routes: Route[] = [{ method: "POST", match: /git\/repositories\/test-repo\/pullrequests\?/, respond: (c) => (created.push(c.body), { body: { pullRequestId: 70 + created.length } }) }];
    const r = await run(dir, routes, ["release", "run", "--plan-file", plan]);
    expect(r.errs).toEqual([]);
    expect(sh(bare, ["branch", "--list"])).toContain("release/t1-to-staging");
    expect(sh(bare, ["show", "release/t1:a.txt"])).toBe("a");
    expect(sh(bare, ["show", "release/t1:b.txt"])).toBe("b");
    expect(created.map((c) => c.targetRefName)).toEqual(["refs/heads/main", "refs/heads/staging"]);
    expect(created[0].workItemRefs).toEqual([{ id: "12" }]);
    expect(created[0].description).toContain("PR 41");
    expect(r.out).toContain("main: !41 cherry-picked");
    expect(r.out).toContain("PR !72");
    // scratch worktrees and local release branches are gone
    expect(sh(dir, ["worktree", "list"]).split("\n")).toHaveLength(1);
    expect(sh(dir, ["branch", "--list"])).not.toContain("release/");
  });

  it("reports a conflict per step, pushes nothing for that target and exits non-zero", async () => {
    const { dir, bare, c1 } = setup();
    write(dir, "a.txt", "conflicting\n");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "main also adds a"]);
    sh(dir, ["push", "origin", "main"]);
    const plan = file("plan.yaml", `version: 1\nrepo: test-repo\nname: release/t2\ntargets: [main]\nitems:\n  - {pr: 41, title: PR 41, commit: ${c1}}\n`);
    const created: any[] = [];
    const r = await run(dir, [{ method: "POST", match: /pullrequests\?/, respond: (c) => (created.push(c.body), { body: { pullRequestId: 1 } }) }], ["release", "run", "--plan-file", plan]);
    expect(r.code).toBe(1);
    expect(r.errs.join("\n")).toContain("!41 FAILED, conflict in a.txt");
    expect(sh(bare, ["branch", "--list"])).not.toContain("release/t2");
    expect(created).toEqual([]);
    expect(sh(dir, ["status", "--porcelain"])).toBe("");
  });
});
