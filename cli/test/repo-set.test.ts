import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commands, main } from "../src/router.js";
import { findSet } from "../src/lib/setInfo.js";
import { ctxFor, fakeFetch, sh, write } from "./helpers.js";
import { makeNamedRepo, newParent } from "./parity-helpers.js";

/** Three synthetic clones next to each other (never real repositories). */
function world() {
  const parent = newParent();
  const repos = ["repo-a", "repo-b", "repo-c"].map((n) => makeNamedRepo(parent, n));
  for (const r of repos) {
    sh(r.dir, ["config", "user.name", "Test"]);
    sh(r.dir, ["config", "user.email", "test@example.invalid"]);
  }
  // feature/shared exists in repo-a (pushed) and repo-b (local only); repo-c has none
  sh(repos[0].dir, ["push", "origin", "main:refs/heads/feature/shared"]);
  sh(repos[1].dir, ["branch", "feature/shared", "main"]);
  // repo-c takes its default target from team.yaml
  write(repos[2].dir, ".agents/skills/_shared/references/team.yaml", "repositories:\n  - name: repo-c\n    defaultTarget: staging\n");
  sh(repos[2].dir, ["add", "."]);
  sh(repos[2].dir, ["commit", "-m", "team"]);
  sh(repos[2].dir, ["push", "origin", "main:refs/heads/staging"]);
  return { parent, repos };
}

const run = async (dir: string, argv: string[]) => {
  const { ctx, lines, errs } = ctxFor(dir, fakeFetch([]).fn);
  const code = await main(argv, ctx, commands);
  return { code, out: lines.join("\n"), err: errs.join("\n"), ctx };
};

describe("aihub worktree groups", () => {
  it("saves, lists and removes a group in the user config, not in the repository", async () => {
    const { repos } = world();
    const { ctx } = ctxFor(repos[0].dir, fakeFetch([]).fn);
    expect(await main(["worktree", "groups", "save", "pipeline", "--repos", "repo-a,repo-b,repo-c"], ctx, commands)).toBe(0);
    const file = join(ctx.env.AIHUB_CONFIG_HOME!, "groups.json");
    expect(JSON.parse(readFileSync(file, "utf8")).groups.pipeline.map((r: { name: string }) => r.name)).toEqual(["repo-a", "repo-b", "repo-c"]);
    expect(sh(repos[0].dir, ["status", "--porcelain"])).toBe("");
    const lines: string[] = [];
    await main(["worktree", "groups", "list", "--json"], { ...ctx, out: (l) => lines.push(l) }, commands);
    expect(JSON.parse(lines[0])[0]).toMatchObject({ name: "pipeline", source: "user", missing: [] });
    await main(["worktree", "groups", "remove", "pipeline"], { ...ctx, out: (l) => lines.push(l) }, commands);
    expect(JSON.parse(readFileSync(file, "utf8")).groups).toEqual({});
  });
});

describe("aihub worktree open", () => {
  it("opens an existing branch and creates the missing one from the team target, in one worktree set", async () => {
    const { parent, repos } = world();
    const r = await run(repos[0].dir, ["worktree", "open", "--repos", "repo-a,repo-b,repo-c", "--branch", "feature/shared", "--window", "none", "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.mode).toBe("worktree");
    expect(j.repos.map((x: { repo: string; state: string }) => [x.repo, x.state])).toEqual([
      ["repo-a", "existing"],
      ["repo-b", "existing"],
      ["repo-c", "created"],
    ]);
    expect(j.repos[2].from).toBe("origin/staging");
    for (const n of ["repo-a", "repo-b", "repo-c"]) {
      expect(sh(join(parent, n), ["worktree", "list"])).toContain("feature/shared");
      expect(sh(join(j.folder, n), ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/shared");
      // the normal checkout stays on main
      expect(sh(join(parent, n), ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    }
    const ws = JSON.parse(readFileSync(j.workspace, "utf8"));
    expect(ws.folders).toEqual([
      { name: "repo-a (feature/shared)", path: "repo-a" },
      { name: "repo-b (feature/shared)", path: "repo-b" },
      { name: "repo-c (feature/shared)", path: "repo-c" },
    ]);
    expect(findSet(join(j.folder, "repo-b"))?.branch).toBe("feature/shared");
  });

  it("creates a missing branch everywhere from --from, and opens the workspace once through the launcher", async () => {
    const { repos } = world();
    const { ctx } = ctxFor(repos[0].dir, fakeFetch([]).fn);
    await main(["worktree", "groups", "save", "all", "--repos", "repo-a,repo-b,repo-c"], ctx, commands);
    const opened: string[] = [];
    const { openSet } = await import("../src/lib/repoSet.js");
    const res = openSet(ctx, { group: "all", branch: "feature/new-story", from: "main", window: "new" }, (file, win) => (opened.push(`${win}:${file}`), true));
    expect(res.repos.every((x) => x.ok && x.state === "created" && x.from === "origin/main")).toBe(true);
    expect(res.opened).toBe(true);
    expect(opened).toEqual([`new:${res.workspace}`]);
    expect(sh(repos[1].dir, ["branch", "--list", "feature/new-story"])).toContain("feature/new-story");
    // nothing was pushed: the branch is local until the first push
    expect(sh(repos[1].dir, ["ls-remote", "--heads", "origin", "feature/new-story"])).toBe("");
  });

  it("switch mode switches clean checkouts and refuses a dirty one, the others continue", async () => {
    const { parent } = world();
    write(join(parent, "repo-b"), "README.md", "changed\n");
    const r = await run(join(parent, "repo-a"), ["worktree", "open", "--repos", "repo-a,repo-b", "--branch", "feature/shared", "--mode", "switch", "--window", "none", "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.repos.map((x: { repo: string; state: string; ok: boolean }) => [x.repo, x.state, x.ok])).toEqual([
      ["repo-a", "switched", true],
      ["repo-b", "skipped", false],
    ]);
    expect(sh(join(parent, "repo-a"), ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/shared");
    expect(sh(join(parent, "repo-b"), ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(readFileSync(join(parent, "repo-b", "README.md"), "utf8")).toBe("changed\n");
    expect(JSON.parse(readFileSync(j.workspace, "utf8")).folders).toHaveLength(1);
  });

  it("without --json a repository that needs attention gives a table and exit code 1", async () => {
    const { parent } = world();
    write(join(parent, "repo-b"), "README.md", "changed" + String.fromCharCode(10));
    const r = await run(join(parent, "repo-a"), ["worktree", "open", "--repos", "repo-a,repo-b", "--branch", "feature/shared", "--mode", "switch", "--window", "none"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL repo-b\s+skipped\s+uncommitted changes/);
    expect(r.out).toMatch(/ok\s+repo-a\s+switched/);
    expect(r.err).toMatch(/1 of 2 repositories need attention/);
  });

  it("reuses the folder where the branch is already checked out instead of failing", async () => {
    const { parent } = world();
    sh(join(parent, "repo-a"), ["switch", "feature/shared"]);
    const r = await run(join(parent, "repo-a"), ["worktree", "open", "--repos", "repo-a,repo-b", "--branch", "feature/shared", "--window", "none", "--json"]);
    const j = JSON.parse(r.out);
    expect(j.repos[0]).toMatchObject({ repo: "repo-a", state: "reused-worktree", ok: true });
    const fwd = (p: string) => p.split("\\").join("/");
    expect(fwd(j.repos[0].path)).toBe(fwd(join(parent, "repo-a")));
    expect(existsSync(join(j.folder, "repo-b"))).toBe(true);
  });

  it("lists which branches exist in how many repositories", async () => {
    const { repos } = world();
    const r = await run(repos[0].dir, ["worktree", "branches", "--repos", "repo-a,repo-b,repo-c", "--json"]);
    const rows = JSON.parse(r.out).branches as { name: string; in: string[]; missing: string[] }[];
    const shared = rows.find((b) => b.name === "feature/shared")!;
    expect(shared.in).toEqual(["repo-a", "repo-b"]);
    expect(shared.missing).toEqual(["repo-c"]);
  });

  it("tells the current branch of each repository, so the picker can pre-select it", async () => {
    const { parent, repos } = world();
    sh(join(parent, "repo-b"), ["switch", "feature/shared"]);
    const r = await run(repos[0].dir, ["worktree", "branches", "--repos", "repo-a,repo-b,repo-c", "--json"]);
    expect(JSON.parse(r.out).current).toEqual({ "repo-a": "main", "repo-b": "feature/shared", "repo-c": "main" });
  });

  it("the workspace file opens the terminal in the set's root", async () => {
    const { repos } = world();
    const j = JSON.parse((await run(repos[0].dir, ["worktree", "open", "--repos", "repo-a,repo-b", "--branch", "feature/shared", "--window", "none", "--json"])).out);
    const fwd = (p: string) => p.split("\\").join("/");
    expect(fwd(JSON.parse(readFileSync(j.workspace, "utf8")).settings["terminal.integrated.cwd"])).toBe(fwd(j.folder));
  });

  it("opened from inside a set it puts the next set beside it, not inside it", async () => {
    const { parent, repos } = world();
    const first = JSON.parse((await run(repos[0].dir, ["worktree", "open", "--repos", "repo-a,repo-b", "--branch", "feature/shared", "--window", "none", "--json"])).out);
    const inside = join(first.folder, "repo-a");
    const second = JSON.parse((await run(inside, ["worktree", "open", "--repos", "repo-a,repo-b", "--branch", "feature/other", "--window", "none", "--json"])).out);
    const fwd = (p: string) => p.split("\\").join("/");
    expect(fwd(second.folder)).toBe(fwd(join(parent, "worktrees", "feature-other")));
  });

  it("switch mode run from inside a set switches the normal checkouts, never the set's worktrees", async () => {
    const { parent, repos } = world();
    const first = JSON.parse((await run(repos[0].dir, ["worktree", "open", "--repos", "repo-a,repo-b", "--branch", "feature/shared", "--window", "none", "--json"])).out);
    const inside = join(first.folder, "repo-a");
    const r = JSON.parse((await run(inside, ["worktree", "open", "--repos", "repo-a,repo-b", "--branch", "feature/other", "--from", "main", "--mode", "switch", "--window", "none", "--json"])).out);
    expect(r.repos.map((x: { state: string }) => x.state)).toEqual(["switched", "switched"]);
    for (const n of ["repo-a", "repo-b"]) {
      expect(sh(join(parent, n), ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/other");
      expect(sh(join(first.folder, n), ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/shared");
    }
  });

  it("removes a group set by branch and keeps the branch", async () => {
    const { repos } = world();
    const o = JSON.parse((await run(repos[0].dir, ["worktree", "open", "--repos", "repo-a,repo-b", "--branch", "feature/shared", "--window", "none", "--json"])).out);
    const r = await run(repos[0].dir, ["worktree", "remove", "--branch", "feature/shared"]);
    expect(r.out).toMatch(/set 'feature\/shared' removed/);
    expect(existsSync(join(o.folder, "repo-a"))).toBe(false);
    expect(existsSync(o.workspace)).toBe(false);
    expect(existsSync(o.folder)).toBe(false);
    expect(sh(repos[0].dir, ["branch", "--list", "feature/shared"])).toContain("feature/shared");
  });
});
