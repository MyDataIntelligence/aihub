import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { commands, main } from "../src/router.js";
import { readSetFile } from "../src/lib/setFile.js";
import { ctxFor, fakeFetch, sh } from "./helpers.js";
import { makeNamedRepo, newParent } from "./parity-helpers.js";

function world(names = ["repo-a", "repo-b"]) {
  const parent = newParent();
  const repos = names.map((n) => makeNamedRepo(parent, n));
  for (const r of repos) {
    sh(r.dir, ["config", "user.name", "Test"]);
    sh(r.dir, ["config", "user.email", "test@example.invalid"]);
  }
  return { parent, dirs: repos.map((r) => r.dir) };
}
const run = async (cwd: string, argv: string[]) => {
  const { ctx, lines, errs } = ctxFor(cwd, fakeFetch([]).fn);
  const code = await main(argv, ctx, commands);
  return { code, out: lines.join("\n"), err: errs.join("\n") };
};
const open = (repos: string, branch: string, story: string) => ["worktree", "open", "--repos", repos, "--branch", branch, "--story", story, "--window", "none", "--json"];

describe("removing a set removes exactly the set that was named", { timeout: 90_000 }, () => {
  it("a branch that has no set in the folder (any more) removes nothing; the story's other set stays", async () => {
    const w = world();
    const r0 = await run(w.dirs[0], open("repo-a,repo-b", "feature/5-a", "5")); const a = JSON.parse(r0.out);
    await run(w.dirs[0], open("repo-a,repo-b", "feature/5-b", "5"));
    const first = await run(w.dirs[0], ["worktree", "remove", "--branch", "feature/5-a", "--story", "5"]);
    expect(first.code).toBe(0);
    expect(readSetFile(a.folder)?.top.branch).toBe("feature/5-b");
    // the same command again: the set is gone, so it must say so instead of removing feature/5-b
    const again = await run(w.dirs[0], ["worktree", "remove", "--branch", "feature/5-a"]);
    expect(again.code).not.toBe(0);
    expect(again.err).toContain("no worktree set for branch 'feature/5-a'");
    expect(readSetFile(a.folder)?.top.branch).toBe("feature/5-b");
    expect(existsSync(a.folder)).toBe(true);
  });

  it("a set that holds the main clone (a reused branch) can be removed: the clone stays, the other worktrees go", async () => {
    const w = world();
    sh(w.dirs[0], ["switch", "-c", "feature/6-x"]);
    const o = JSON.parse((await run(w.dirs[0], open("repo-a,repo-b", "feature/6-x", "6"))).out);
    expect(o.repos[0].state).toBe("reused-worktree");
    const r = await run(w.dirs[0], ["worktree", "remove", "--folder", o.folder, "--branch", "feature/6-x", "--json"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(existsSync(w.dirs[0])).toBe(true);
    expect(sh(w.dirs[0], ["branch", "--show-current"])).toBe("feature/6-x");
    expect(existsSync(o.repos[1].path)).toBe(false);
    expect(existsSync(o.folder)).toBe(false);
  });

  it("a worktree git cannot remove (locked) keeps itself in the set; the others are still removed and named", async () => {
    const w = world();
    const o = JSON.parse((await run(w.dirs[0], open("repo-a,repo-b", "feature/7-x", "7"))).out);
    sh(w.dirs[0], ["worktree", "lock", o.repos[0].path]);
    const r = await run(w.dirs[0], ["worktree", "remove", "--folder", o.folder, "--branch", "feature/7-x", "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.kept).toEqual(["repo-a"]);
    expect(existsSync(o.repos[1].path)).toBe(false);
    expect(readSetFile(o.folder)?.top.repos.map((x) => x.name)).toEqual(["repo-a"]);
  });
});
