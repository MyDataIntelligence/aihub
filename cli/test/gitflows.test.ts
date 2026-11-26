import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commands, main } from "../src/router.js";
import { parseSources, pickBranchName } from "../src/lib/cherryPick.js";
import { ctxFor, fakeFetch, makeRepo, sh, write } from "./helpers.js";

const BASE = "/ferron-org/test-project/_apis/git/repositories/test-repo";

function repo() {
  const r = makeRepo();
  sh(r.dir, ["config", "user.name", "Test"]);
  sh(r.dir, ["config", "user.email", "test@example.com"]);
  sh(r.dir, ["config", "commit.gpgsign", "false"]);
  return r;
}
const commit = (dir: string, file: string, text: string, msg: string) => {
  write(dir, file, text);
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", msg]);
  return sh(dir, ["rev-parse", "HEAD"]);
};
const remoteBranches = (bare: string) => sh(bare, ["branch", "--list"]).split("\n").map((l) => l.replace(/^[*+]?\s+/, ""));

describe("parseSources", () => {
  it("tells PR, story and commit apart", () => {
    expect(parseSources("42,pr:7,https://dev.azure.com/o/p/_git/r/pullrequest/9,story:5,AB#6,abc1234")).toEqual([
      { kind: "pr", id: 42 },
      { kind: "pr", id: 7 },
      { kind: "pr", id: 9 },
      { kind: "story", id: 5 },
      { kind: "story", id: 6 },
      { kind: "commit", sha: "abc1234" },
    ]);
    expect(() => parseSources("nonsense!")).toThrow(/not a PR/);
    expect(pickBranchName("pr42", "release/1.2")).toBe("cherry-pick/pr42-to-release-1.2");
  });
});

describe("cherry-pick", () => {
  function scenario() {
    const { dir, bare } = repo();
    for (const b of ["release/1.2", "release/1.3"]) sh(dir, ["push", "origin", `main:refs/heads/${b}`]);
    // release/1.3 changes README.md so the pick conflicts there
    sh(dir, ["checkout", "-q", "-b", "tmp", "main"]);
    commit(dir, "README.md", "release change\n", "release edit");
    sh(dir, ["push", "origin", "tmp:refs/heads/release/1.3", "--force"]);
    sh(dir, ["checkout", "-q", "main"]);
    sh(dir, ["branch", "-D", "tmp"]);
    const sha = commit(dir, "README.md", "main change\n", "fix: main change");
    sh(dir, ["push", "origin", "main"]);
    return { dir, bare, sha };
  }

  it("picks to every target in a temp worktree, conflict reports files and pushes nothing", async () => {
    const { dir, bare, sha } = scenario();
    // clean target: pick a commit that only adds a file
    const add = commit(dir, "new.txt", "n\n", "feat: new file");
    sh(dir, ["push", "origin", "main"]);
    const headBefore = sh(dir, ["rev-parse", "HEAD"]);
    const { ctx, lines, errs } = ctxFor(dir, fakeFetch([]).fn);
    const code = await main(["cherry-pick", "--from", `${add},${sha}`, "--to", "release/1.2", "--to", "release/1.3", "--no-pr"], ctx, commands);
    const out = lines.join("\n");
    expect(code).toBe(1);
    expect(out).toMatch(/release\/1\.2\s+ok/);
    expect(out).toMatch(/release\/1\.3\s+conflict\s+conflict in README\.md/);
    expect(errs.join("\n")).toMatch(/1 of 2 target\(s\) need attention \(release\/1\.3\)/);
    const bs = remoteBranches(bare);
    expect(bs.some((b) => b.startsWith("cherry-pick/") && b.endsWith("-to-release-1.2"))).toBe(true);
    expect(bs.some((b) => b.endsWith("-to-release-1.3"))).toBe(false);
    // the user's checkout is untouched and no temp worktree is left behind
    expect(sh(dir, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(sh(dir, ["status", "--porcelain"])).toBe("");
    expect(sh(dir, ["worktree", "list"]).split("\n")).toHaveLength(1);
  });

  it("creates a PR per the team template with --pr and resolves --to-group", async () => {
    const { dir, sha } = scenario();
    write(dir, ".agents/skills/_shared/references/team.yaml", "cherryPick:\n  groups:\n    supported: [release/1.2]\n");
    write(dir, ".azuredevops/pull_request_template.md", "## Beschrijving\n\n## Commits\n");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "chore: team"]);
    sh(dir, ["push", "origin", "main"]);
    const body = join(dir, "..", "body.md");
    write(join(dir, ".."), "body.md", "## Beschrijving\nPick naar release.\n");
    const f = fakeFetch([
      { method: "POST", match: /\/pullrequests\?/, respond: () => ({ body: { pullRequestId: 77 } }) },
    ]);
    const { ctx, lines } = ctxFor(dir, f.fn);
    const code = await main(["cherry-pick", "--from", sha, "--to-group", "supported", "--pr", "--body-file", body], ctx, commands);
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/release\/1\.2\s+ok.*PR !77/);
    const post = f.calls.find((c) => c.method === "POST")!;
    expect(post.body.targetRefName).toBe("refs/heads/release/1.2");
    expect(post.body.sourceRefName).toMatch(/^refs\/heads\/cherry-pick\/.*-to-release-1\.2$/);
    expect(post.body.description).toContain("Pick naar release.");
    expect(post.body.description).toContain("fix: main change");
  });

  it("opens a PR by default, links the story named in the commit (AB#) and takes the summary inline", async () => {
    const { dir } = scenario();
    write(dir, ".azuredevops/pull_request_template.md", "## Samenvatting\n\n## Gekoppelde stories\n");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "chore: sjabloon"]);
    const add = commit(dir, "fix.txt", "f\n", "fix: lege order (AB#4321)");
    sh(dir, ["push", "origin", "main"]);
    const f = fakeFetch([
      { match: /_apis\/wit\/workitems\/4321\?/, respond: () => ({ body: { fields: { "System.Title": "Lege order" } } }) },
      { method: "POST", match: /\/pullrequests\?/, respond: () => ({ body: { pullRequestId: 78 } }) },
    ]);
    const { ctx, lines } = ctxFor(dir, f.fn);
    expect(await main(["cherry-pick", "--from", add, "--to", "release/1.2", "--summary-text", "Zet de fix ook op de release."], ctx, commands)).toBe(0);
    expect(lines.join("\n")).toMatch(/release\/1\.2\s+ok.*PR !78/);
    const post = f.calls.find((c) => c.method === "POST")!;
    expect(post.body.workItemRefs).toEqual([{ id: "4321" }]);
    expect(post.body.description).toMatch(/## Samenvatting\n+Zet de fix ook op de release\./);
    expect(post.body.description).toContain("AB#4321");
  });

  it("resolves a completed PR to its merge commit and pushes --direct (protected is refused)", async () => {
    const { dir, bare } = scenario();
    const merged = commit(dir, "feat.txt", "f\n", "squashed feature");
    sh(dir, ["push", "origin", "main"]);
    write(dir, ".agents/skills/_shared/references/team.yaml", "branches:\n  protected: [release/1.3]\n");
    const f = fakeFetch([
      {
        match: /\/pullrequests\/42\?/,
        respond: () => ({ body: { pullRequestId: 42, title: "t", status: "completed", sourceRefName: "refs/heads/x", targetRefName: "refs/heads/main", lastMergeCommit: { commitId: merged } } }),
      },
    ]);
    const { ctx, lines } = ctxFor(dir, f.fn);
    const code = await main(["cherry-pick", "--from", "42", "--to", "release/1.2", "--to", "release/1.3", "--direct"], ctx, commands);
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/release\/1\.3\s+refused\s+'release\/1\.3' is protected/);
    expect(sh(bare, ["show", "release/1.2:feat.txt"])).toBe("f");
    expect(existsSync(join(dir, "feat.txt"))).toBe(true); // the user's own checkout is main, which has it
  });
});

describe("branch update", () => {
  function setup() {
    const r = repo();
    sh(r.dir, ["checkout", "-q", "-b", "feature/1-x"]);
    commit(r.dir, "x.txt", "x\n", "feat: x");
    sh(r.dir, ["push", "origin", "feature/1-x"]);
    sh(r.dir, ["checkout", "-q", "main"]);
    return r;
  }

  it("merges the target into a branch that is not checked out and pushes", async () => {
    const { dir, bare } = setup();
    commit(dir, "m.txt", "m\n", "feat: main moved");
    sh(dir, ["push", "origin", "main"]);
    const { ctx, lines } = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(["branch", "update", "--branch", "feature/1-x"], ctx, commands)).toBe(0);
    expect(lines.join("\n")).toMatch(/updated/);
    expect(sh(bare, ["show", "feature/1-x:m.txt"])).toBe("m");
    expect(sh(dir, ["worktree", "list"]).split("\n")).toHaveLength(1);
    expect(sh(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
  });

  it("rebases the checked-out branch and reports up to date the second time", async () => {
    const { dir, bare } = setup();
    sh(dir, ["checkout", "-q", "feature/1-x"]);
    sh(dir, ["checkout", "-q", "main"]);
    commit(dir, "m.txt", "m\n", "feat: main moved");
    sh(dir, ["push", "origin", "main"]);
    sh(dir, ["checkout", "-q", "feature/1-x"]);
    const { ctx, lines } = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(["branch", "update", "--rebase"], ctx, commands)).toBe(0);
    expect(readFileSync(join(dir, "m.txt"), "utf8").trim()).toBe("m");
    expect(sh(bare, ["log", "--format=%s", "feature/1-x"]).split("\n")[0]).toBe("feat: x");
    expect(await main(["branch", "update", "--rebase"], ctx, commands)).toBe(0);
    expect(lines.join("\n")).toMatch(/up-to-date/);
  });

  it("a conflict is reported and nothing changes", async () => {
    const { dir, bare } = setup();
    sh(dir, ["checkout", "-q", "feature/1-x"]);
    commit(dir, "README.md", "feature\n", "feat: readme");
    sh(dir, ["push", "origin", "feature/1-x"]);
    sh(dir, ["checkout", "-q", "main"]);
    commit(dir, "README.md", "main\n", "feat: readme main");
    sh(dir, ["push", "origin", "main"]);
    const before = sh(bare, ["rev-parse", "feature/1-x"]);
    const { ctx, lines } = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(["branch", "update", "--branch", "feature/1-x"], ctx, commands)).toBe(0);
    expect(lines.join("\n")).toMatch(/conflict in README\.md; nothing changed or pushed/);
    expect(sh(bare, ["rev-parse", "feature/1-x"])).toBe(before);
    expect(sh(dir, ["worktree", "list"]).split("\n")).toHaveLength(1);
  });
});

describe("pr changes", () => {
  it("diffs a PR that is not checked out against the real merge base, pages and iterations", async () => {
    const { dir } = repo();
    sh(dir, ["checkout", "-q", "-b", "feature/9-y"]);
    const c1 = commit(dir, "a.txt", "one\n", "feat: a");
    const c2 = commit(dir, "b.txt", Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n") + "\n", "feat: b");
    sh(dir, ["push", "origin", "feature/9-y"]);
    sh(dir, ["checkout", "-q", "main"]);
    const base = sh(dir, ["rev-parse", "HEAD"]);
    commit(dir, "main-only.txt", "m\n", "feat: unrelated main work");
    sh(dir, ["push", "origin", "main"]);
    const f = fakeFetch([
      {
        match: /\/pullrequests\/9\?/,
        respond: () => ({ body: { pullRequestId: 9, title: "t", status: "active", sourceRefName: "refs/heads/feature/9-y", targetRefName: "refs/heads/main" } }),
      },
      {
        match: /\/pullrequests\/9\/iterations\?/,
        respond: () => ({
          body: {
            value: [
              { id: 1, sourceRefCommit: { commitId: c1 }, commonRefCommit: { commitId: base } },
              { id: 2, sourceRefCommit: { commitId: c2 }, commonRefCommit: { commitId: base } },
            ],
          },
        }),
      },
    ]);
    const { ctx, lines } = ctxFor(dir, f.fn);
    expect(await main(["pr", "changes", "--pr", "9"], ctx, commands)).toBe(0);
    let out = lines.join("\n");
    expect(out).toContain("2 file(s) changed, +401 -0");
    expect(out).toMatch(/A {2}\+1 -0 {2}a\.txt/);
    expect(out).not.toContain("main-only.txt");
    expect(out).toMatch(/page 1\/2 \(next: --page 2\)/);
    lines.length = 0;
    await main(["pr", "changes", "--pr", "9", "--page", "2"], ctx, commands);
    expect(lines.join("\n")).toMatch(/page 2\/2/);
    lines.length = 0;
    await main(["pr", "changes", "--pr", "9", "--since-iteration", "1"], ctx, commands);
    out = lines.join("\n");
    expect(out).toContain("since iteration 1");
    expect(out).toContain("1 file(s) changed, +400 -0");
    expect(out).not.toMatch(/a\.txt/);
    lines.length = 0;
    await main(["pr", "changes", "--pr", "9", "--paths", "a.*"], ctx, commands);
    expect(lines.join("\n")).toContain("1 file(s) changed, +1 -0");
    expect(sh(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
  });
});

describe("branch update without a push, and a refused push", () => {
  function onFeature() {
    const r = repo();
    sh(r.dir, ["checkout", "-q", "-b", "feature/1-x"]);
    commit(r.dir, "x.txt", "x\n", "feat: x");
    sh(r.dir, ["push", "origin", "feature/1-x"]);
    sh(r.dir, ["checkout", "-q", "main"]);
    commit(r.dir, "m.txt", "m\n", "feat: main moved");
    sh(r.dir, ["push", "origin", "main"]);
    sh(r.dir, ["checkout", "-q", "feature/1-x"]);
    return r;
  }

  it("--no-push merges and leaves the remote branch where it was", async () => {
    const { dir, bare } = onFeature();
    const remoteBefore = sh(bare, ["rev-parse", "feature/1-x"]);
    // a commit of the user that is not pushed yet: it must not be published either
    commit(dir, "mine.txt", "mine\n", "feat: mine");
    const { ctx, lines } = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(["branch", "update", "--no-push", "--json"], ctx, commands)).toBe(0);
    expect(JSON.parse(lines[0])).toMatchObject({ result: "updated" });
    expect(lines[0]).toContain("not pushed");
    expect(readFileSync(join(dir, "m.txt"), "utf8").trim()).toBe("m");
    expect(sh(bare, ["rev-parse", "feature/1-x"])).toBe(remoteBefore);
  });

  it("a refused push puts the branch back with --keep, and keeps what was saved meanwhile", async () => {
    const { dir } = onFeature();
    const before = sh(dir, ["rev-parse", "HEAD"]);
    // the push hook refuses, and on its way somebody saves a tracked file
    const hook = join(dir, ".git", "hooks", "pre-push");
    const { writeFileSync, chmodSync } = await import("node:fs");
    writeFileSync(hook, "#!/bin/sh\necho saved-meanwhile > x.txt\nexit 1\n");
    chmodSync(hook, 0o755);
    const { ctx, errs } = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(["branch", "update"], ctx, commands)).toBe(1);
    expect(errs.join("\n")).toContain("local branch restored");
    expect(sh(dir, ["rev-parse", "HEAD"])).toBe(before);
    // old code: reset --hard threw the saved change away
    expect(readFileSync(join(dir, "x.txt"), "utf8").trim()).toBe("saved-meanwhile");
  });

  it("a refused push leaves the branch alone when the user committed meanwhile", async () => {
    const { dir } = onFeature();
    const hook = join(dir, ".git", "hooks", "pre-push");
    const { writeFileSync, chmodSync } = await import("node:fs");
    writeFileSync(hook, "#!/bin/sh\necho later > later.txt\ngit add later.txt\ngit -c user.name=T -c user.email=t@e.x commit -q -m 'feat: while pushing'\nexit 1\n");
    chmodSync(hook, 0o755);
    const { ctx, errs } = ctxFor(dir, fakeFetch([]).fn);
    await main(["branch", "update"], ctx, commands);
    expect(errs.join("\n")).toContain("left as it is");
    expect(sh(dir, ["log", "-1", "--format=%s"])).toBe("feat: while pushing");
  });
});
