import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commands, main } from "../src/router.js";
import { findSet } from "../src/lib/setInfo.js";
import { ctxFor, fakeFetch, sh, write } from "./helpers.js";
import { makeNamedRepo, newParent } from "./parity-helpers.js";

const TEAM = "language: en\nbranches:\n  protected: [main]\nrepositories:\n  - name: repo-a\n  - name: repo-b\n  - name: repo-c\n";

/** Three synthetic clones (never real repositories), each with team.yaml and a pushed main. */
function clones() {
  const parent = newParent();
  const repos = ["repo-a", "repo-b", "repo-c"].map((n) => makeNamedRepo(parent, n));
  for (const r of repos) {
    sh(r.dir, ["config", "user.name", "Test"]);
    sh(r.dir, ["config", "user.email", "test@example.invalid"]);
    write(r.dir, ".agents/skills/_shared/references/team.yaml", TEAM);
    sh(r.dir, ["add", "."]);
    sh(r.dir, ["commit", "-m", "team"]);
    sh(r.dir, ["push", "origin", "main"]);
  }
  return { parent, repos };
}

/**
 * A set as the VS Code extension's Worktree Sets write it: `.worktree-set.json` with relative paths,
 * repo-b on its own branch (`repos[].branch`), and a workspace file with "<repo> (<branch>)" folder names.
 */
function extensionSet() {
  const { parent, repos } = clones();
  const folder = join(parent, "worktrees", "feature-7-demo");
  const own: Record<string, string> = { "repo-a": "feature/7-demo", "repo-b": "feature/8-other", "repo-c": "feature/7-demo" };
  for (const r of repos) {
    const name = r.dir.split(/[\\/]/).pop()!;
    sh(r.dir, ["worktree", "add", "-b", own[name], join(folder, name)]);
  }
  const set = {
    schemaVersion: 1,
    branch: "feature/7-demo",
    slug: "feature-7-demo",
    base: "main",
    createdAt: "2026-11-20T10:00:00.000Z",
    updatedAt: "2026-11-20T10:00:00.000Z",
    repos: repos.map((r) => {
      const name = r.dir.split(/[\\/]/).pop()!;
      return { name, source: r.dir, path: name, ...(own[name] !== "feature/7-demo" ? { branch: own[name] } : {}), base: "main" };
    }),
  };
  write(folder, ".worktree-set.json", JSON.stringify(set, null, 2));
  write(folder, "feature-7-demo.code-workspace", JSON.stringify({ folders: set.repos.map((r) => ({ name: `${r.name} (${own[r.name]})`, path: r.path })), settings: {} }, null, 2));
  return { parent, folder, repos };
}

const run = async (cwd: string, argv: string[]) => {
  const { ctx, lines, errs } = ctxFor(cwd, fakeFetch([]).fn);
  ctx.now = () => Date.parse("2026-11-25T12:00:00Z");
  const code = await main(argv, ctx, commands);
  return { code, out: lines.join("\n"), err: errs.join("\n") };
};

const head = (dir: string) => sh(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);

describe("a set whose repositories are on different branches", () => {
  it("worktree open --branch-for puts one repository on its own branch and the set file says so", async () => {
    const { repos } = clones();
    const j = JSON.parse((await run(repos[0].dir, ["worktree", "open", "--repos", "repo-a,repo-b", "--branch", "feature/1-x", "--branch-for", "repo-b=feature/2-y", "--from", "main", "--window", "none", "--json"])).out);
    expect(j.repos.map((r: { repo: string; branch: string }) => [r.repo, r.branch])).toEqual([["repo-a", "feature/1-x"], ["repo-b", "feature/2-y"]]);
    expect(head(j.repos[1].path)).toBe("feature/2-y");
    const meta = JSON.parse(readFileSync(join(j.folder, ".aihub-set.json"), "utf8"));
    expect(meta.repos.map((r: { name: string; branch?: string }) => [r.name, r.branch])).toEqual([["repo-a", undefined], ["repo-b", "feature/2-y"]]);
    expect(findSet(j.repos[1].path)?.repos.map((r) => r.branch)).toEqual(["feature/1-x", "feature/2-y"]);
  });

  it("--branch-for with a repository that is not in --repos changes nothing", async () => {
    const { repos } = clones();
    const r = await run(repos[0].dir, ["worktree", "open", "--repos", "repo-a", "--branch", "feature/1-x", "--branch-for", "repo-z=feature/2-y", "--window", "none"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--branch-for names repo-z");
    expect(sh(repos[0].dir, ["branch", "--list", "feature/1-x"])).toBe("");
  });

  it("an older set file without repos[].branch: every repository is on the set's branch", () => {
    const { parent, repos } = clones();
    const folder = join(parent, "worktrees", "story-5");
    for (const r of repos.slice(0, 2)) sh(r.dir, ["worktree", "add", "-b", "feature/5-demo", join(folder, r.dir.split(/[\\/]/).pop()!)]);
    write(folder, ".aihub-set.json", JSON.stringify({ story: 5, branch: "feature/5-demo", repos: repos.slice(0, 2).map((r) => ({ name: r.dir.split(/[\\/]/).pop(), source: r.dir, path: join(folder, r.dir.split(/[\\/]/).pop()!) })) }));
    expect(findSet(join(folder, "repo-a"))?.repos.map((r) => [r.name, r.branch])).toEqual([["repo-a", "feature/5-demo"], ["repo-b", "feature/5-demo"]]);
  });

  it("the extension's .worktree-set.json is a set too: status names repo-b's own branch", async () => {
    const { folder } = extensionSet();
    const s = findSet(join(folder, "repo-a"));
    expect(s?.kind).toBe("maker");
    expect(s?.repos.map((r) => [r.name, r.branch])).toEqual([["repo-a", "feature/7-demo"], ["repo-b", "feature/8-other"], ["repo-c", "feature/7-demo"]]);
    const r = await run(join(folder, "repo-a"), ["status"]);
    expect(r.out).toContain("Set: story-7 with repo-a, repo-b (feature/8-other), repo-c:");
    const list = await run(join(folder, "repo-a"), ["worktree", "list"]);
    expect(list.out).toMatch(/repo-b on 'feature\/8-other': clean/);
  });

  it("commit --all-repos commits each repository on its own branch", async () => {
    const { folder } = extensionSet();
    write(join(folder, "repo-a"), "src/a.py", "a = 1\n");
    write(join(folder, "repo-b"), "src/b.py", "b = 1\n");
    const r = await run(join(folder, "repo-a"), ["commit", "--all-repos", "--type", "feat", "--subject", "both"]);
    expect(r.err).toBe("");
    expect(r.out).toMatch(/repo-a committed.*repo-b \(feature\/8-other\) committed.*repo-c \(?.*skipped: nothing to commit/);
    expect(sh(join(folder, "repo-a"), ["log", "-1", "--format=%s", "feature/7-demo"])).toContain("both");
    expect(sh(join(folder, "repo-b"), ["log", "-1", "--format=%s", "feature/8-other"])).toContain("both");
  });

  it("branch switch inside the extension's set writes repos[].branch and the folder name back in its own format", async () => {
    const { folder } = extensionSet();
    const r = await run(join(folder, "repo-a"), ["branch", "switch", "--repo", "repo-c", "--branch", "feature/9-third", "--from", "main"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("the window stays as it is: 3 repositories, repo-c now on feature/9-third");
    expect(head(join(folder, "repo-c"))).toBe("feature/9-third");
    const set = JSON.parse(readFileSync(join(folder, ".worktree-set.json"), "utf8"));
    expect(set.schemaVersion).toBe(1);
    expect(set.createdAt).toBe("2026-11-20T10:00:00.000Z");
    expect(set.repos).toEqual([
      { name: "repo-a", source: expect.any(String), path: "repo-a", base: "main" },
      { name: "repo-b", source: expect.any(String), path: "repo-b", branch: "feature/8-other", base: "main" },
      { name: "repo-c", source: expect.any(String), path: "repo-c", branch: "feature/9-third", base: "main" },
    ]);
    const ws = JSON.parse(readFileSync(join(folder, "feature-7-demo.code-workspace"), "utf8"));
    expect(ws.folders.map((f: { name: string }) => f.name)).toEqual(["repo-a (feature/7-demo)", "repo-b (feature/8-other)", "repo-c (feature/9-third)"]);
    // back on the set's branch: repos[].branch is dropped again
    await run(join(folder, "repo-a"), ["branch", "switch", "--repo", "repo-b", "--branch", "feature/7-demo"]);
    expect(head(join(folder, "repo-b"))).toBe("feature/7-demo");
    expect(JSON.parse(readFileSync(join(folder, ".worktree-set.json"), "utf8")).repos[1].branch).toBeUndefined();
  });
});
