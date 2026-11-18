import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commands, main } from "../src/router.js";
import { ctxFor, fakeFetch, sh, write, type Route } from "./helpers.js";
import { makeNamedRepo, newParent, storyRoutes } from "./parity-helpers.js";

const run = (dir: string, routes: Route[], argv: string[]) => {
  const { fn, calls } = fakeFetch(routes);
  const { ctx, lines, errs } = ctxFor(dir, fn);
  return main(argv, ctx, commands).then((code) => ({ code, lines, errs, calls }));
};

const branches = (dir: string) => sh(dir, ["branch", "--list"]).replace(/[*+ ]/g, "").split("\n").filter(Boolean);

describe("aihub story start", () => {
  it("creates feature/<id>-<slug> from the base, pushes, links and sets Active", async () => {
    const parent = newParent();
    const { dir, bare } = makeNamedRepo(parent, "test-repo");
    const patches: { ops: any[]; contentType: string }[] = [];
    const r = await run(dir, storyRoutes(1234, { title: "Zoekfunctie bouwen" }, patches), ["story", "start", "--id", "1234"]);
    expect(r.errs).toEqual([]);
    expect(r.code).toBe(0);
    expect(sh(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/1234-zoekfunctie-bouwen");
    expect(sh(bare, ["branch", "--list"])).toContain("feature/1234-zoekfunctie-bouwen");
    const ops = patches.flatMap((p) => p.ops);
    expect(patches.every((p) => p.contentType === "application/json-patch+json")).toBe(true);
    const link = ops.find((o) => o.path === "/relations/-");
    expect(decodeURIComponent(link.value.url)).toBe("vstfs:///Git/Ref/proj-1/repo-test-repo/GBfeature/1234-zoekfunctie-bouwen");
    expect(ops.find((o) => o.path === "/fields/System.State").value).toBe("Active");
  });

  it("uses the branch pattern and states of team.yaml and reuses an existing branch", async () => {
    const parent = newParent();
    const { dir } = makeNamedRepo(parent, "test-repo");
    write(dir, ".agents/skills/_shared/references/team.yaml", "branches:\n  feature: 'story/{storyId}_{slug}'\nworkItems:\n  states:\n    active: In Progress\n");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "team"]);
    sh(dir, ["push", "origin", "main"]);
    const patches: { ops: any[]; contentType: string }[] = [];
    const first = await run(dir, storyRoutes(7, { title: "Eén ding" }, patches), ["story", "start", "--id", "7", "--no-checkout"]);
    expect(first.errs).toEqual([]);
    expect(branches(dir)).toContain("story/7_een-ding");
    expect(patches.flatMap((p) => p.ops).find((o) => o.path === "/fields/System.State").value).toBe("In Progress");
    const again = await run(dir, storyRoutes(7, { title: "Eén ding", state: "In Progress" }, []), ["story", "start", "--id", "7", "--no-checkout"]);
    expect(again.lines.join("\n")).toContain("reused");
    expect(again.lines.join("\n")).toContain("state stays In Progress");
  });

  it("starts the story in several repositories next to the current one without switching them", async () => {
    const parent = newParent();
    const a = makeNamedRepo(parent, "repo-a");
    const b = makeNamedRepo(parent, "repo-b");
    const r = await run(a.dir, storyRoutes(9, { title: "Beide repos" }), ["story", "start", "--id", "9", "--repos", "repo-a,repo-b", "--base", "main"]);
    expect(r.errs).toEqual([]);
    expect(branches(a.dir)).toContain("feature/9-beide-repos");
    expect(branches(b.dir)).toContain("feature/9-beide-repos");
    expect(sh(a.dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(sh(b.bare, ["branch", "--list"])).toContain("feature/9-beide-repos");
  });

  it("does not switch a dirty checkout", async () => {
    const parent = newParent();
    const { dir } = makeNamedRepo(parent, "test-repo");
    write(dir, "wip.txt", "x\n");
    sh(dir, ["add", "wip.txt"]);
    const r = await run(dir, storyRoutes(5, { title: "Vuil" }), ["story", "start", "--id", "5"]);
    expect(r.lines.join("\n")).toContain("uncommitted changes");
    expect(sh(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
  });
});

describe("aihub story link", () => {
  it("links the current branch and its active PR, once", async () => {
    const parent = newParent();
    const { dir } = makeNamedRepo(parent, "test-repo");
    sh(dir, ["checkout", "-b", "feature/21-link"]);
    const patches: { ops: any[]; contentType: string }[] = [];
    const routes: Route[] = [
      { match: /pullrequests\?.*searchCriteria/, respond: () => ({ body: { value: [{ pullRequestId: 88, title: "t", status: "active", sourceRefName: "refs/heads/feature/21-link", targetRefName: "refs/heads/main" }] } }) },
      ...storyRoutes(21, { title: "Link" }, patches),
    ];
    const r = await run(dir, routes, ["story", "link", "--id", "21"]);
    expect(r.errs).toEqual([]);
    expect(patches.flatMap((p) => p.ops).map((o) => decodeURIComponent(o.value.url))).toEqual([
      "vstfs:///Git/Ref/proj-1/repo-test-repo/GBfeature/21-link",
      "vstfs:///Git/PullRequestId/proj-1/repo-test-repo/88",
    ]);
    const had = [
      { rel: "ArtifactLink", url: "vstfs:///Git/Ref/proj-1%2Frepo-test-repo%2FGBfeature%2F21-link" },
      { rel: "ArtifactLink", url: "vstfs:///Git/PullRequestId/proj-1%2Frepo-test-repo%2F88" },
    ];
    const again: { ops: any[]; contentType: string }[] = [];
    await run(dir, [routes[0], ...storyRoutes(21, { relations: had }, again)], ["story", "link", "--id", "21"]);
    expect(again).toEqual([]);
  });
});

describe("aihub story finish", () => {
  /** A merged story branch: pushed, PR completed with the branch tip as final source commit. */
  function merged(parent: string, id: number, slug = "klaar") {
    const repo = makeNamedRepo(parent, "test-repo");
    const branch = `feature/${id}-${slug}`;
    sh(repo.dir, ["checkout", "-b", branch]);
    write(repo.dir, "f.txt", "feature\n");
    sh(repo.dir, ["add", "."]);
    sh(repo.dir, ["commit", "-m", "feat: f"]);
    sh(repo.dir, ["push", "-u", "origin", branch]);
    const tip = sh(repo.dir, ["rev-parse", "HEAD"]);
    // squash merge on main (content equal, different commit)
    sh(repo.dir, ["checkout", "main"]);
    write(repo.dir, "f.txt", "feature\n");
    sh(repo.dir, ["add", "."]);
    sh(repo.dir, ["commit", "-m", "squash"]);
    sh(repo.dir, ["push", "origin", "main"]);
    return { ...repo, branch, tip };
  }
  const prRoutes = (branch: string, tip: string, patches: any[] = [], state = "Resolved"): Route[] => [
    {
      match: /pullrequests\?.*searchCriteria.status=active/,
      respond: () => ({ body: { value: [] } }),
    },
    {
      match: /pullrequests\?.*searchCriteria.status=completed/,
      respond: () => ({ body: { value: [{ pullRequestId: 50, title: "t", status: "completed", sourceRefName: `refs/heads/${branch}`, targetRefName: "refs/heads/main", lastMergeSourceCommit: { commitId: tip } }] } }),
    },
    ...storyRoutes(30, { title: "Klaar", state }, patches),
  ];

  it("removes merged branches and its clean worktree, then sets Done", async () => {
    const parent = newParent();
    const m = merged(parent, 30);
    const wt = join(parent, "wt");
    sh(m.dir, ["worktree", "add", wt, m.branch]);
    const patches: { ops: any[]; contentType: string }[] = [];
    const r = await run(m.dir, prRoutes(m.branch, m.tip, patches), ["story", "finish", "--id", "30"]);
    expect(r.errs).toEqual([]);
    expect(existsSync(wt)).toBe(false);
    expect(branches(m.dir)).not.toContain(m.branch);
    expect(sh(m.bare, ["branch", "--list"])).not.toContain(m.branch);
    expect(patches.flatMap((p) => p.ops).find((o) => o.path === "/fields/System.State").value).toBe("Done");
  });

  it("keeps a worktree with uncommitted changes and does not set Done", async () => {
    const parent = newParent();
    const m = merged(parent, 30);
    const wt = join(parent, "wt");
    sh(m.dir, ["worktree", "add", wt, m.branch]);
    write(wt, "wip.txt", "unsaved\n");
    const patches: { ops: any[]; contentType: string }[] = [];
    const r = await run(m.dir, prRoutes(m.branch, m.tip, patches), ["story", "finish", "--id", "30"]);
    expect(existsSync(join(wt, "wip.txt"))).toBe(true);
    expect(r.lines.join("\n")).toContain("uncommitted changes");
    expect(branches(m.dir)).toContain(m.branch);
    expect(sh(m.bare, ["branch", "--list"])).toContain(m.branch);
    expect(patches).toEqual([]);
  });

  it("never deletes a branch whose PR is not merged", async () => {
    const parent = newParent();
    const m = merged(parent, 30);
    const patches: { ops: any[]; contentType: string }[] = [];
    const routes: Route[] = [
      { match: /pullrequests\?.*searchCriteria.status=active/, respond: () => ({ body: { value: [] } }) },
      { match: /pullrequests\?.*searchCriteria.status=completed/, respond: () => ({ body: { value: [] } }) },
      ...storyRoutes(30, { state: "Active" }, patches),
    ];
    const r = await run(m.dir, routes, ["story", "finish", "--id", "30"]);
    expect(r.lines.join("\n")).toContain("not merged");
    expect(branches(m.dir)).toContain(m.branch);
    expect(sh(m.bare, ["branch", "--list"])).toContain(m.branch);
    expect(patches).toEqual([]);
  });

  it("keeps a branch that has commits after the merged PR", async () => {
    const parent = newParent();
    const m = merged(parent, 30);
    sh(m.dir, ["checkout", m.branch]);
    write(m.dir, "extra.txt", "after the merge\n");
    sh(m.dir, ["add", "."]);
    sh(m.dir, ["commit", "-m", "late work"]);
    sh(m.dir, ["checkout", "main"]);
    const r = await run(m.dir, prRoutes(m.branch, m.tip), ["story", "finish", "--id", "30"]);
    expect(r.lines.join("\n")).toContain("local commits are not in the merged PR");
    expect(branches(m.dir)).toContain(m.branch);
  });

  it("--dry-run changes nothing", async () => {
    const parent = newParent();
    const m = merged(parent, 30);
    const patches: { ops: any[]; contentType: string }[] = [];
    const r = await run(m.dir, prRoutes(m.branch, m.tip, patches), ["story", "finish", "--id", "30", "--dry-run"]);
    expect(r.lines.join("\n")).toContain("would: deleted local branch");
    expect(branches(m.dir)).toContain(m.branch);
    expect(patches).toEqual([]);
  });

  it("switches off a clean checked-out merged branch before deleting it", async () => {
    const parent = newParent();
    const m = merged(parent, 30);
    sh(m.dir, ["checkout", m.branch]);
    const r = await run(m.dir, prRoutes(m.branch, m.tip), ["story", "finish", "--id", "30", "--no-state"]);
    expect(r.errs).toEqual([]);
    expect(sh(m.dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(branches(m.dir)).not.toContain(m.branch);
  });
});

describe("aihub story start with a process that has other state names", () => {
  it("names the states of the project instead of the bare 400 (live: Basic process To do/Doing/Done)", async () => {
    const parent = newParent();
    const { dir } = makeNamedRepo(parent, "test-repo");
    const routes: Route[] = [
      {
        method: "PATCH",
        match: /\/_apis\/wit\/workitems\/1234\?/,
        respond: (c) =>
          c.body?.some((o: any) => o.path === "/fields/System.State")
            ? { status: 400, body: { message: "The field 'State' contains the value 'Active' that is not in the list of supported values" } }
            : { body: { id: 1234 } },
      },
      { match: /\/_apis\/wit\/workitemtypes\/User%20Story\/states\?/, respond: () => ({ body: { value: [{ name: "To do" }, { name: "Doing" }, { name: "Done" }] } }) },
      ...storyRoutes(1234, { title: "Zoekfunctie bouwen" }),
    ];
    const r = await run(dir, routes, ["story", "start", "--id", "1234"]);
    expect(r.code).not.toBe(0);
    expect(r.errs.join("\n")).toMatch(/state 'Active' does not exist.*To do, Doing, Done.*workItems\.states/);
  });
});
