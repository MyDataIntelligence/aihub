import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commands, main } from "../src/router.js";
import { openSet } from "../src/lib/repoSet.js";
import { readStoryWorktrees, storyWorktreesFileFor } from "../src/lib/storyWorktrees.js";
import { ctxFor, fakeFetch, sh, write } from "./helpers.js";
import { makeNamedRepo, newParent } from "./parity-helpers.js";

/** Three synthetic clones with a story branch and a second branch everywhere (never real repositories). */
function world() {
  const parent = newParent();
  const repos = ["repo-a", "repo-b", "repo-c"].map((n) => makeNamedRepo(parent, n));
  for (const r of repos) {
    sh(r.dir, ["config", "user.name", "Test"]);
    sh(r.dir, ["config", "user.email", "test@example.invalid"]);
    sh(r.dir, ["push", "origin", "main:refs/heads/feature/123-search"]);
    sh(r.dir, ["push", "origin", "main:refs/heads/feature/other"]);
  }
  return { parent, repos };
}

const run = async (dir: string, argv: string[]) => {
  const { ctx, lines, errs } = ctxFor(dir, fakeFetch([]).fn);
  const code = await main(argv, ctx, commands);
  return { code, out: lines.join("\n"), err: errs.join("\n") };
};

const head = (dir: string) => sh(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
const fwd = (p: string) => p.split("\\").join("/");

/** A set of the three repositories on the story branch, as `aihub worktree open` makes it; no window. */
async function threeRepoSet() {
  const w = world();
  const set = JSON.parse((await run(w.repos[0].dir, ["worktree", "open", "--repos", "repo-a,repo-b,repo-c", "--branch", "feature/123-search", "--window", "none", "--json"])).out);
  expect(set.repos.every((r: { ok: boolean }) => r.ok)).toBe(true);
  return { ...w, set, inside: join(set.folder, "repo-a") };
}

const wsOf = (file: string) => JSON.parse(readFileSync(file, "utf8")) as { folders: { name: string; path: string }[]; settings: Record<string, { repos: { name: string; branch: string }[] }> };

describe("one repository of a set on another branch", { timeout: 30_000 }, () => {
  it("worktree open for one repository of the set switches it in place: same folder, same workspace, no window", async () => {
    const { set, inside } = await threeRepoSet();
    const before = readFileSync(set.workspace, "utf8");
    const { ctx } = ctxFor(inside, fakeFetch([]).fn);
    const launched: string[] = [];
    const r = openSet(ctx, { repos: ["repo-b"], branch: "feature/other", window: "new" }, (file) => (launched.push(file), true));
    expect(launched).toEqual([]);
    expect(r.opened).toBe(false);
    expect(fwd(r.folder)).toBe(fwd(set.folder));
    expect(r.repos).toMatchObject([{ repo: "repo-b", ok: true, state: "switched" }]);
    expect(r.stays).toBe("the window stays as it is: 3 repositories, repo-b now on feature/other");
    expect(head(join(set.folder, "repo-b"))).toBe("feature/other");
    expect(head(join(set.folder, "repo-a"))).toBe("feature/123-search");
    expect(head(join(set.folder, "repo-c"))).toBe("feature/123-search");
    const ws = wsOf(set.workspace);
    expect(ws.folders.map((f) => f.name)).toEqual(["repo-a (feature/123-search)", "repo-b (feature/other)", "repo-c (feature/123-search)"]);
    expect(ws.settings["aihub.set"].repos.find((x) => x.name === "repo-b")?.branch).toBe("feature/other");
    expect(before).not.toBe(readFileSync(set.workspace, "utf8"));
  });

  it("the set's worktree folder as --repos (the VS Code picker) also switches in place, with an explicit --mode switch", async () => {
    const { set, inside } = await threeRepoSet();
    const j = JSON.parse((await run(inside, ["worktree", "open", "--repos", join(set.folder, "repo-b"), "--branch", "feature/other", "--mode", "switch", "--window", "none", "--json"])).out);
    expect(j.repos).toMatchObject([{ repo: "repo-b", state: "switched", ok: true }]);
    expect(j.stays).toBe("the window stays as it is: 3 repositories, repo-b now on feature/other");
    expect(fwd(j.folder)).toBe(fwd(set.folder));
    expect(head(join(set.folder, "repo-b"))).toBe("feature/other");
  });

  it("aihub branch switch --repo is the one command, also from the set's root folder", async () => {
    const { set } = await threeRepoSet();
    const r = await run(set.folder, ["branch", "switch", "--repo", "repo-c", "--branch", "feature/other"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/ok\s+repo-c\s+switched/);
    expect(r.out).toContain("the window stays as it is: 3 repositories, repo-c now on feature/other");
    expect(head(join(set.folder, "repo-c"))).toBe("feature/other");
    expect(head(join(set.folder, "repo-b"))).toBe("feature/123-search");
  });

  it("without --repo it switches the repository you are in, and creates a missing branch from --from", async () => {
    const { set } = await threeRepoSet();
    const j = JSON.parse((await run(join(set.folder, "repo-b"), ["branch", "switch", "--branch", "feature/123-extra", "--from", "main", "--json"])).out);
    expect(j.repos).toMatchObject([{ repo: "repo-b", state: "switched", from: "origin/main" }]);
    expect(head(join(set.folder, "repo-b"))).toBe("feature/123-extra");
    // story-worktrees.json: the new story branch points at the worktree, the old one no longer does
    const d = readStoryWorktrees(storyWorktreesFileFor(join(set.folder, "repo-b"))!);
    expect(fwd(d.branches["feature/123-extra"].worktree!)).toBe(fwd(join(set.folder, "repo-b")));
    expect(d.branches["feature/123-search"].worktree).toBeUndefined();
  });

  it("uncommitted work: nothing is switched, and the line names the choices", async () => {
    const { set, inside } = await threeRepoSet();
    write(join(set.folder, "repo-b"), "README.md", "changed\n");
    const r = await run(inside, ["branch", "switch", "--repo", "repo-b", "--branch", "feature/other"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL repo-b\s+skipped\s+uncommitted changes in .*nothing was changed\. Commit or stash them first, or add --mode worktree/);
    expect(r.out).toContain("nothing was changed; the window stays as it is");
    expect(head(join(set.folder, "repo-b"))).toBe("feature/123-search");
    expect(readFileSync(join(set.folder, "repo-b", "README.md"), "utf8")).toBe("changed\n");
  });

  it("several repositories, one dirty: none is switched and no missing branch is created", async () => {
    const { repos, set, inside } = await threeRepoSet();
    write(join(set.folder, "repo-c"), "README.md", "changed\n");
    const j = JSON.parse((await run(inside, ["branch", "switch", "--repo", "repo-b,repo-c", "--branch", "feature/123-new", "--from", "main", "--json"])).out);
    expect(j.repos.map((x: { state: string }) => x.state)).toEqual(["skipped", "skipped"]);
    expect(head(join(set.folder, "repo-b"))).toBe("feature/123-search");
    expect(sh(repos[1].dir, ["branch", "--list", "feature/123-new"])).toBe("");
  });

  it("a branch checked out elsewhere is named; --mode worktree adds that folder to this set, still without a window", async () => {
    const { parent, set, inside } = await threeRepoSet();
    sh(join(parent, "repo-b"), ["switch", "feature/other"]);
    const r = await run(inside, ["branch", "switch", "--repo", "repo-b", "--branch", "feature/other"]);
    expect(r.code).toBe(1);
    // the main clone has it: it cannot be moved or recreated, so the line offers switching it, or reuse
    expect(fwd(r.out)).toContain(`feature/other is already checked out in ${fwd(join(parent, "repo-b"))}; nothing was changed. Switch that checkout to another branch first, or put it in this set: aihub branch switch --repo repo-b --branch feature/other --existing reuse`);
    expect(head(join(set.folder, "repo-b"))).toBe("feature/123-search");

    const { ctx } = ctxFor(inside, fakeFetch([]).fn);
    const launched: string[] = [];
    const w = openSet(ctx, { repos: ["repo-b"], branch: "feature/other", mode: "worktree" }, (file) => (launched.push(file), true));
    expect(launched).toEqual([]);
    expect(w.repos).toMatchObject([{ repo: "repo-b--other", ok: true, state: "reused-worktree" }]);
    expect(fwd(w.repos[0].path)).toBe(fwd(join(parent, "repo-b")));
    expect(w.stays).toBe("the window stays as it is: 4 repositories, repo-b--other added on feature/other");
    const ws = wsOf(set.workspace);
    expect(ws.folders.map((f) => f.name)).toEqual(["repo-a (feature/123-search)", "repo-b (feature/123-search)", "repo-c (feature/123-search)", "repo-b--other (feature/other)"]);
    const meta = JSON.parse(readFileSync(join(set.folder, ".aihub-set.json"), "utf8"));
    expect(meta.repos.map((x: { name: string }) => x.name)).toEqual(["repo-a", "repo-b", "repo-c", "repo-b--other"]);
  });

  it("--mode worktree in a set makes a second worktree <repo>--<variant> in the set folder", async () => {
    const { set, inside } = await threeRepoSet();
    const j = JSON.parse((await run(inside, ["branch", "switch", "--repo", "repo-a", "--branch", "feature/other", "--mode", "worktree", "--json"])).out);
    expect(j.repos).toMatchObject([{ repo: "repo-a--other", state: "existing", ok: true }]);
    expect(head(join(set.folder, "repo-a--other"))).toBe("feature/other");
    expect(head(join(set.folder, "repo-a"))).toBe("feature/123-search");
    expect(wsOf(set.workspace).folders).toContainEqual({ name: "repo-a--other (feature/other)", path: "repo-a--other" });
    expect(j.opened).toBe(false);
  });

  it("--new-set still makes a new set from inside a set", async () => {
    const { parent, set, inside } = await threeRepoSet();
    const j = JSON.parse((await run(inside, ["worktree", "open", "--repos", "repo-b", "--branch", "feature/other", "--new-set", "--window", "none", "--json"])).out);
    expect(j.stays).toBeUndefined();
    expect(fwd(j.folder)).toBe(fwd(join(parent, "worktrees", "feature-other")));
    expect(head(join(set.folder, "repo-b"))).toBe("feature/123-search");
    expect(existsSync(join(j.folder, "repo-b"))).toBe(true);
  });

  it("outside a set, branch switch switches the checkout and opens nothing", async () => {
    const { repos } = world();
    const r = await run(repos[0].dir, ["branch", "switch", "--branch", "feature/other"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("no window opened: repo-a now on feature/other");
    expect(head(repos[0].dir)).toBe("feature/other");
  });
});
