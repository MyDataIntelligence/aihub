import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commands, main } from "../src/router.js";
import { ctxFor, fakeFetch, sh, write } from "./helpers.js";
import { makeNamedRepo, newParent } from "./parity-helpers.js";

/** Three synthetic clones (never real repositories). */
function clones() {
  const parent = newParent();
  const repos = ["repo-a", "repo-b", "repo-c"].map((n) => makeNamedRepo(parent, n));
  for (const r of repos) {
    sh(r.dir, ["config", "user.name", "Test"]);
    sh(r.dir, ["config", "user.email", "test@example.invalid"]);
    sh(r.dir, ["push", "origin", "main:refs/heads/feature/other"]);
  }
  return { parent, repos };
}

const run = async (cwd: string, argv: string[]) => {
  const { ctx, lines, errs } = ctxFor(cwd, fakeFetch([]).fn);
  const code = await main(argv, ctx, commands);
  return { code, out: lines.join("\n"), err: errs.join("\n") };
};

const head = (dir: string) => sh(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
const json = (f: string) => JSON.parse(readFileSync(f, "utf8"));

/** repo-a and repo-b as a set on feature/1-x, made by `aihub worktree open` (no window). */
async function twoRepoSet() {
  const w = clones();
  const set = JSON.parse((await run(w.repos[0].dir, ["worktree", "open", "--repos", "repo-a,repo-b", "--branch", "feature/1-x", "--from", "main", "--window", "none", "--json"])).out);
  return { ...w, set, inside: join(set.folder, "repo-a") };
}

describe("aihub worktree add | drop | repair", { timeout: 30_000 }, () => {
  it("add puts a repository in the set on the set's branch: worktree, set file and workspace file, no window", async () => {
    const { set, inside } = await twoRepoSet();
    const r = await run(inside, ["worktree", "add", "--repos", "repo-c", "--from", "main"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("the window stays as it is: 3 repositories, repo-c added on feature/1-x");
    expect(head(join(set.folder, "repo-c"))).toBe("feature/1-x");
    expect(json(join(set.folder, ".aihub-set.json")).repos.map((x: { name: string }) => x.name)).toEqual(["repo-a", "repo-b", "repo-c"]);
    expect(json(set.workspace).folders).toContainEqual({ name: "repo-c (feature/1-x)", path: "repo-c" });
  });

  it("add --branch gives the new repository its own branch (repos[].branch)", async () => {
    const { set, inside } = await twoRepoSet();
    const j = JSON.parse((await run(inside, ["worktree", "add", "--repos", "repo-c", "--branch", "feature/other", "--json"])).out);
    expect(j.repos).toMatchObject([{ repo: "repo-c", ok: true, branch: "feature/other" }]);
    expect(head(join(set.folder, "repo-c"))).toBe("feature/other");
    expect(json(join(set.folder, ".aihub-set.json")).repos[2]).toMatchObject({ name: "repo-c", branch: "feature/other" });
  });

  it("drop removes a clean worktree from the set; the branch stays", async () => {
    const { repos, set, inside } = await twoRepoSet();
    const r = await run(inside, ["worktree", "drop", "--repos", "repo-b"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("the window stays as it is: 1 repositories, repo-b taken out");
    expect(existsSync(join(set.folder, "repo-b"))).toBe(false);
    expect(sh(repos[1].dir, ["branch", "--list", "feature/1-x"])).toContain("feature/1-x");
    expect(json(join(set.folder, ".aihub-set.json")).repos.map((x: { name: string }) => x.name)).toEqual(["repo-a"]);
    expect(json(set.workspace).folders.map((f: { name: string }) => f.name)).toEqual(["repo-a (feature/1-x)"]);
  });

  it("drop keeps a worktree with uncommitted work, in the set, and says so", async () => {
    const { set, inside } = await twoRepoSet();
    write(join(set.folder, "repo-b"), "README.md", "changed\n");
    const r = await run(inside, ["worktree", "drop", "--repos", "repo-b"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL repo-b\s+kept\s+kept, uncommitted changes/);
    expect(readFileSync(join(set.folder, "repo-b", "README.md"), "utf8")).toBe("changed\n");
    expect(json(join(set.folder, ".aihub-set.json")).repos.map((x: { name: string }) => x.name)).toEqual(["repo-a", "repo-b"]);
  });

  it("drop of every repository points at worktree remove", async () => {
    const { inside } = await twoRepoSet();
    const r = await run(inside, ["worktree", "drop", "--repos", "repo-a,repo-b"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("aihub worktree remove --branch feature/1-x");
  });

  it("a repository added to the set file by hand (name only) is named by status and made by repair", async () => {
    const { parent, repos } = clones();
    // the extension's set format, as a person edits it: repo-c has only a name
    const folder = join(parent, "worktrees", "feature-1-x");
    for (const r of repos.slice(0, 2)) sh(r.dir, ["worktree", "add", "-b", "feature/1-x", join(folder, r.dir.split(/[\\/]/).pop()!)]);
    const set = { schemaVersion: 1, branch: "feature/1-x", slug: "feature-1-x", createdAt: "2026-11-20T10:00:00.000Z", updatedAt: "2026-11-20T10:00:00.000Z", repos: [{ name: "repo-a", source: repos[0].dir, path: "repo-a" }, { name: "repo-b", source: repos[1].dir, path: "repo-b" }, { name: "repo-c" }] };
    writeFileSync(join(folder, ".worktree-set.json"), JSON.stringify(set, null, 2));
    writeFileSync(join(folder, "feature-1-x.code-workspace"), JSON.stringify({ folders: [{ name: "repo-a (feature/1-x)", path: "repo-a" }, { name: "repo-b (feature/1-x)", path: "repo-b" }] }, null, 2));
    const st = await run(join(folder, "repo-a"), ["status"]);
    expect(st.out).toContain("1 repository(ies) in the set file have no worktree: aihub worktree repair");
    const r = await run(join(folder, "repo-a"), ["worktree", "repair", "--json"]);
    const j = JSON.parse(r.out);
    expect(j.repos).toMatchObject([{ repo: "repo-c", ok: true, state: "created" }]);
    expect(head(join(folder, "repo-c"))).toBe("feature/1-x");
    const after = json(join(folder, ".worktree-set.json"));
    expect(after.repos[2]).toMatchObject({ name: "repo-c", path: "repo-c" });
    expect(after.repos[2].source.split(/[\\/]/).pop()).toBe("repo-c");
    expect(json(join(folder, "feature-1-x.code-workspace")).folders.map((f: { name: string }) => f.name)).toEqual(["repo-a (feature/1-x)", "repo-b (feature/1-x)", "repo-c (feature/1-x)"]);
    expect((await run(join(folder, "repo-a"), ["worktree", "repair"])).out).toContain("nothing to repair");
  });
});
