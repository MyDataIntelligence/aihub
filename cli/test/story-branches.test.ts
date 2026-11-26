import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commands, main } from "../src/router.js";
import { readStoryWorktrees, storyWorktreesFileFor } from "../src/lib/storyWorktrees.js";
import { ctxFor, fakeFetch, sh, write, type Route } from "./helpers.js";
import { makeNamedRepo, newParent, storyRoutes } from "./parity-helpers.js";

/** Synthetic world: repo-a and repo-b next to each other, story 9 in Azure DevOps (mocked). */
function world() {
  const parent = newParent();
  const a = makeNamedRepo(parent, "repo-a");
  const b = makeNamedRepo(parent, "repo-b");
  for (const r of [a, b]) {
    sh(r.dir, ["config", "user.name", "Test"]);
    sh(r.dir, ["config", "user.email", "test@example.invalid"]);
  }
  return { parent, a, b };
}

const ref = (repo: string, branch: string) => ({ rel: "ArtifactLink", url: `vstfs:///Git/Ref/proj-1%2Frepo-${repo}%2FGB${encodeURIComponent(branch)}`, attributes: { name: "Branch" } });

function ado(relations: { rel: string; url: string }[] = [], prs: Record<string, unknown[]> = {}) {
  const patches: { ops: any[]; contentType: string }[] = [];
  const routes: Route[] = [
    ...storyRoutes(9, { title: "Export bouwen", state: "Active", relations }, patches),
    { match: /_apis\/git\/repositories\?/, respond: () => ({ body: { value: [{ id: "repo-repo-a", name: "repo-a" }, { id: "repo-repo-b", name: "repo-b" }] } }) },
    { match: /_apis\/git\/repositories\/([^/?]+)\/pullrequests\?/, respond: (c) => ({ body: { value: prs[/repositories\/([^/?]+)\/pullrequests/.exec(c.url)![1]] ?? [] } }) },
  ];
  return { routes, patches };
}

const run = async (dir: string, routes: Route[], argv: string[]) => {
  const { fn, calls } = fakeFetch(routes);
  const { ctx, lines, errs } = ctxFor(dir, fn);
  const code = await main(argv, ctx, commands);
  return { code, out: lines.join("\n"), err: errs.join("\n"), calls };
};

const state = (dir: string) => readStoryWorktrees(storyWorktreesFileFor(dir)!).branches;

describe("aihub story branches link / mark / unlink", () => {
  it("links several branches in Azure DevOps (Development) and locally; the last one with --current gets the star", async () => {
    const { a } = world();
    sh(a.dir, ["branch", "feature/9-export"]);
    sh(a.dir, ["branch", "feature/9-export-v2"]);
    const { routes, patches } = ado();
    const r = await run(a.dir, routes, ["story", "branches", "link", "--id", "9", "--branch", "feature/9-export,feature/9-export-v2", "--current"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const urls = patches.flatMap((p) => p.ops).filter((o) => o.path === "/relations/-").map((o) => decodeURIComponent(o.value.url));
    expect(urls).toEqual(["vstfs:///Git/Ref/proj-1/repo-repo-a/GBfeature/9-export", "vstfs:///Git/Ref/proj-1/repo-repo-a/GBfeature/9-export-v2"]);
    expect(state(a.dir)["feature/9-export"].status).toBe("parked");
    expect(state(a.dir)["feature/9-export-v2"].status).toBe("current");
    expect(r.out).toContain("★");
  });

  it("mark moves the star (the previous one becomes old) and sets a label, without any network call", async () => {
    const { a } = world();
    const { routes } = ado();
    sh(a.dir, ["branch", "feature/9-export"]);
    sh(a.dir, ["branch", "feature/9-export-v2"]);
    await run(a.dir, routes, ["story", "branches", "link", "--id", "9", "--branch", "feature/9-export", "--current"]);
    const r = await run(a.dir, [], ["story", "branches", "mark", "--branch", "feature/9-export-v2", "--status", "current", "--label", "second try"]);
    expect(r.err).toBe("");
    expect(r.calls).toEqual([]);
    expect(state(a.dir)["feature/9-export"].status).toBe("old");
    expect(state(a.dir)["feature/9-export-v2"]).toMatchObject({ status: "current", label: "second try", storyId: 9 });
  });

  it("unlink removes the Development link and the local entry; the branch stays", async () => {
    const { a } = world();
    sh(a.dir, ["branch", "feature/9-export"]);
    const link = ref("repo-a", "feature/9-export");
    const { routes, patches } = ado([{ rel: "System.LinkTypes.Hierarchy-Reverse", url: "x" }, link]);
    await run(a.dir, [], ["story", "branches", "mark", "--branch", "feature/9-export", "--status", "current"]);
    const r = await run(a.dir, routes, ["story", "branches", "unlink", "--id", "9", "--branch", "feature/9-export"]);
    expect(r.err).toBe("");
    expect(patches.flatMap((p) => p.ops)).toEqual([{ op: "remove", path: "/relations/1" }]);
    expect(state(a.dir)["feature/9-export"]).toBeUndefined();
    expect(sh(a.dir, ["branch", "--list", "feature/9-export"])).toContain("feature/9-export");
  });
});

describe("aihub story branches (the list)", () => {
  it("per repository: the Development links joined with the star, local work, pushed and the PR", async () => {
    const { a, b } = world();
    sh(a.dir, ["switch", "-q", "-c", "feature/9-export"]);
    write(a.dir, "x.txt", "1\n");
    sh(a.dir, ["add", "."]);
    sh(a.dir, ["commit", "-q", "-m", "x"]);
    sh(a.dir, ["push", "-q", "origin", "feature/9-export"]);
    sh(a.dir, ["switch", "-q", "main"]);
    sh(b.dir, ["branch", "feature/9-export-api"]);
    await run(a.dir, [], ["story", "branches", "mark", "--branch", "feature/9-export", "--status", "current"]);
    const { routes } = ado([ref("repo-a", "feature/9-export"), ref("repo-b", "feature/9-export-api")], { "repo-a": [{ pullRequestId: 41, sourceRefName: "refs/heads/feature/9-export", isDraft: true, status: "active" }] });
    const r = await run(a.dir, routes, ["story", "branches", "--id", "9", "--json"]);
    expect(r.err).toBe("");
    const s = JSON.parse(r.out).stories[0];
    expect(s).toMatchObject({ id: 9, title: "Export bouwen" });
    expect(s.branches).toEqual([
      expect.objectContaining({ repo: "repo-a", branch: "feature/9-export", linked: "both", status: "current", local: true, pushed: true, ahead: 0, pr: { id: 41, draft: true, status: "active" } }),
      expect.objectContaining({ repo: "repo-b", branch: "feature/9-export-api", linked: "ado", status: "parked", local: true, pushed: false, ahead: 0 }),
    ]);
    // the title goes into the shared file, for the Worktree Maker (no Azure DevOps access there)
    expect(readStoryWorktrees(storyWorktreesFileFor(b.dir)!).stories["9"].title).toBe("Export bouwen");
    const text = await run(a.dir, routes, ["story", "branches", "--id", "9"]);
    expect(text.out).toMatch(/★ repo-a: feature\/9-export\s+pushed, PR !41 \(draft\)/);
  });
});

describe("aihub story branches without --id", () => {
  it("lists the stories you have branches for here first, also when they are not assigned to you", async () => {
    const { a } = world();
    sh(a.dir, ["branch", "feature/9-export"]);
    await run(a.dir, [], ["story", "branches", "mark", "--branch", "feature/9-export", "--status", "current"]);
    const { routes } = ado([ref("repo-a", "feature/9-export")]);
    routes.push({ method: "POST", match: /_apis\/wit\/wiql/, respond: () => ({ body: { workItems: [] } }) });
    const r = await run(a.dir, routes, ["story", "branches", "--json"]);
    expect(r.err).toBe("");
    expect(JSON.parse(r.out).stories.map((s: { id: number }) => s.id)).toEqual([9]);
  });
});

describe("aihub story branches remove (never throws away local work)", () => {
  it("keeps a worktree with uncommitted work, removes a clean one after taking out its folder links", async () => {
    const { parent, a } = world();
    const keep = join(parent, "wt-keep");
    const clean = join(parent, "wt-clean");
    sh(a.dir, ["worktree", "add", "-q", "-b", "feature/9-keep", keep]);
    sh(a.dir, ["worktree", "add", "-q", "-b", "feature/9-clean", clean]);
    write(keep, "wip.txt", "work\n");
    // a node_modules linked to a folder elsewhere: removing the worktree must not empty it
    const shared = join(parent, "shared-node-modules");
    mkdirSync(shared);
    writeFileSync(join(shared, "keep.js"), "x");
    symlinkSync(shared, join(clean, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const r1 = await run(a.dir, [], ["story", "branches", "remove", "--branch", "feature/9-keep", "--delete-branch"]);
    expect(r1.out).toContain("kept: uncommitted changes");
    expect(existsSync(join(keep, "wip.txt"))).toBe(true);
    const r2 = await run(a.dir, [], ["story", "branches", "remove", "--branch", "feature/9-clean", "--delete-branch"]);
    expect(r2.err).toBe("");
    expect(r2.out).toContain("worktree and local branch removed");
    expect(existsSync(clean)).toBe(false);
    expect(readdirSync(shared)).toEqual(["keep.js"]);
  });

  it("keeps a branch whose commits are on no remote", async () => {
    const { parent, a } = world();
    const wt = join(parent, "wt-ahead");
    sh(a.dir, ["worktree", "add", "-q", "-b", "feature/9-ahead", wt]);
    write(wt, "y.txt", "1\n");
    sh(wt, ["add", "."]);
    sh(wt, ["commit", "-q", "-m", "only here"]);
    const r = await run(a.dir, [], ["story", "branches", "remove", "--branch", "feature/9-ahead", "--delete-branch"]);
    expect(r.out).toContain("kept: 1 commit(s) that are on no remote");
    expect(existsSync(wt)).toBe(true);
  });
});

describe("the story folder layout", () => {
  it("worktree open of a story branch goes to <root>/<id>-<slug>/<repo>, a second branch of the same repository to <repo>--<variant>, both linked", async () => {
    const { parent, a } = world();
    const first = JSON.parse((await run(a.dir, [], ["worktree", "open", "--repos", "repo-a,repo-b", "--branch", "feature/9-export", "--from", "main", "--window", "none", "--json"])).out);
    const fwd = (p: string) => p.split("\\").join("/");
    expect(fwd(first.folder)).toBe(fwd(join(parent, "worktrees", "9-export")));
    expect(first.repos.map((x: { path: string }) => fwd(x.path))).toEqual([fwd(join(parent, "worktrees", "9-export", "repo-a")), fwd(join(parent, "worktrees", "9-export", "repo-b"))]);
    const second = JSON.parse((await run(a.dir, [], ["worktree", "open", "--repos", "repo-a", "--branch", "feature/9-export-v2", "--from", "main", "--window", "none", "--json"])).out);
    expect(fwd(second.repos[0].path)).toBe(fwd(join(parent, "worktrees", "9-export", "repo-a--export-v2")));
    expect(state(a.dir)["feature/9-export"]).toMatchObject({ storyId: 9, status: "current" });
    expect(state(a.dir)["feature/9-export-v2"]).toMatchObject({ storyId: 9, status: "parked" });
    const ws = JSON.parse(readFileSync(second.workspace, "utf8"));
    expect(ws.settings["aihub.set"]).toMatchObject({ story: 9, branch: "feature/9-export-v2", mode: "worktree", repos: [{ name: "repo-a", branch: "feature/9-export-v2" }] });
  });

  it("worktree open --story puts a branch without the number in its name into the story folder and links it", async () => {
    const { parent, a } = world();
    const r = JSON.parse((await run(a.dir, [], ["worktree", "open", "--repos", "repo-a", "--branch", "feature/plain-name", "--from", "main", "--story", "42", "--window", "none", "--json"])).out);
    const fwd = (p: string) => p.split("\\").join("/");
    expect(r.story).toBe(42);
    expect(fwd(r.repos[0].path)).toBe(fwd(join(parent, "worktrees", "42-plain-name", "repo-a")));
    expect(state(a.dir)["feature/plain-name"]).toMatchObject({ storyId: 42, status: "current" });
  });

  it("story open opens the star of every repository as one set", async () => {
    const { parent, a, b } = world();
    sh(a.dir, ["branch", "feature/9-export"]);
    sh(a.dir, ["branch", "feature/9-export-v2"]);
    sh(b.dir, ["branch", "feature/9-export-api"]);
    await run(a.dir, [], ["story", "branches", "mark", "--branch", "feature/9-export-v2", "--status", "current"]);
    await run(a.dir, [], ["story", "branches", "mark", "--branch", "feature/9-export", "--status", "old"]);
    const { routes } = ado([ref("repo-a", "feature/9-export"), ref("repo-a", "feature/9-export-v2"), ref("repo-b", "feature/9-export-api")]);
    const r = await run(a.dir, routes, ["story", "open", "--id", "9", "--window", "none", "--json"]);
    expect(r.err).toBe("");
    const j = JSON.parse(r.out);
    expect(j.repos.map((x: { repo: string; branch: string; ok: boolean }) => [x.repo, x.branch, x.ok])).toEqual([
      ["repo-a", "feature/9-export-v2", true],
      ["repo-b", "feature/9-export-api", true],
    ]);
    expect(sh(join(parent, "worktrees", "9-export-v2", "repo-a"), ["branch", "--show-current"])).toBe("feature/9-export-v2");
  });

  it("place lists worktrees outside their story folder and moves them, folder links put back", async () => {
    const { parent, a } = world();
    const loose = join(parent, "somewhere", "a-9");
    sh(a.dir, ["worktree", "add", "-q", "-b", "feature/9-export", loose]);
    const shared = join(parent, "nm");
    mkdirSync(shared);
    symlinkSync(shared, join(loose, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const list = JSON.parse((await run(a.dir, [], ["story", "branches", "place", "--json"])).out);
    const fwd = (p: string) => p.split("\\").join("/");
    expect(list.misplaced.map((m: { target: string }) => fwd(m.target))).toEqual([fwd(join(parent, "worktrees", "9-export", "repo-a"))]);
    const moved = JSON.parse((await run(a.dir, [], ["story", "branches", "place", "--move", "all", "--json"])).out);
    expect(moved.moved[0]).toContain("1 folder link(s) put back");
    const target = join(parent, "worktrees", "9-export", "repo-a");
    expect(sh(target, ["branch", "--show-current"])).toBe("feature/9-export");
    expect(existsSync(join(target, "node_modules"))).toBe(true);
    expect(existsSync(loose)).toBe(false);
    expect(fwd(state(a.dir)["feature/9-export"].worktree!)).toBe(fwd(target));
  });

  it("story start makes the new branch the star", async () => {
    const { a } = world();
    const { routes } = ado();
    const r = await run(a.dir, routes, ["story", "start", "--id", "9", "--no-checkout"]);
    expect(r.err).toBe("");
    expect(state(a.dir)["feature/9-export-bouwen"]).toMatchObject({ storyId: 9, status: "current" });
  });
});

describe("branches that only have the story number in their name", () => {
  it("the rule: the story number is the first number after an optional prefix, on a word boundary", async () => {
    const { branchNamedForStory } = await import("../src/lib/storyWorktrees.js");
    for (const yes of ["feature/4711-x", "bugfix/4711_x", "4711-x", "users/me/feature/4711", "feature/US-4711-x", "feature/4711"]) expect(branchNamedForStory(yes, 4711), yes).toBe(true);
    for (const no of ["feature/47110-x", "feature/14711-x", "feature/4711a", "feature/4711.5-x", "release/4711.5", "feature/x-4711", "main", "feature/4712-x"]) expect(branchNamedForStory(no, 4711), no).toBe(false);
  });

  it("are listed as linked: name, from the refs (local and remote only), mixed with the linked ones; none for other numbers", async () => {
    const { a, b } = world();
    for (const br of ["feature/9-by-name", "bugfix/9_other", "feature/90-not", "feature/19-not", "feature/9a-not", "feature/9-linked"]) sh(a.dir, ["branch", br]);
    // remote only: pushed, then the local branch is gone
    sh(b.dir, ["branch", "feature/9-remote-only"]);
    sh(b.dir, ["push", "-q", "origin", "feature/9-remote-only"]);
    sh(b.dir, ["branch", "-q", "-D", "feature/9-remote-only"]);
    const { routes } = ado([ref("repo-a", "feature/9-linked")]);
    const r = await run(a.dir, routes, ["story", "branches", "--id", "9", "--json"]);
    expect(r.err).toBe("");
    const rows = JSON.parse(r.out).stories[0].branches as { repo: string; branch: string; linked: string; local: boolean; pushed: boolean }[];
    expect(rows.map((x) => [x.repo, x.branch, x.linked]).sort()).toEqual([
      ["repo-a", "bugfix/9_other", "name"],
      ["repo-a", "feature/9-by-name", "name"],
      ["repo-a", "feature/9-linked", "ado"],
      ["repo-b", "feature/9-remote-only", "name"],
    ]);
    expect(rows.find((x) => x.branch === "feature/9-remote-only")).toMatchObject({ local: false, pushed: true });
    // the text says it too
    const text = await run(a.dir, routes, ["story", "branches", "--id", "9"]);
    expect(text.out).toContain("not linked, found by its name");
  });

  it("story open takes a branch known by its name only when the repository has no other", async () => {
    const { a, b } = world();
    sh(a.dir, ["branch", "feature/9-by-name"]);
    sh(a.dir, ["branch", "feature/9-linked"]);
    sh(b.dir, ["branch", "feature/9-only-name"]);
    const { routes } = ado([ref("repo-a", "feature/9-linked")]);
    const r = await run(a.dir, routes, ["story", "open", "--id", "9", "--window", "none", "--json"]);
    const j = JSON.parse(r.out);
    expect(j.repos.map((x: { repo: string; branch: string }) => [x.repo, x.branch]).sort()).toEqual([["repo-a", "feature/9-linked"], ["repo-b", "feature/9-only-name"]]);
  });
});
