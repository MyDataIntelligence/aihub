import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commands, main } from "../src/router.js";
import { ctxFor, fakeFetch, sh, write } from "./helpers.js";
import { makeNamedRepo, newParent } from "./parity-helpers.js";

/**
 * repo-a and repo-b (synthetic clones); repo-a's feature/x already has a worktree outside any set
 * (`<parent>/other/repo-a-x`), pushed so the remote branch exists.
 */
function world() {
  const parent = newParent();
  const repos = ["repo-a", "repo-b"].map((n) => makeNamedRepo(parent, n));
  for (const r of repos) {
    sh(r.dir, ["config", "user.name", "Test"]);
    sh(r.dir, ["config", "user.email", "test@example.invalid"]);
    sh(r.dir, ["push", "origin", "main:refs/heads/feature/x"]);
  }
  const old = join(parent, "other", "repo-a-x");
  sh(repos[0].dir, ["worktree", "add", old, "feature/x"]);
  return { parent, a: repos[0].dir, b: repos[1].dir, old, set: join(parent, "worktrees", "feature-x") };
}

const run = async (cwd: string, argv: string[], env: Record<string, string> = {}) => {
  const { ctx, lines, errs } = ctxFor(cwd, fakeFetch([]).fn);
  Object.assign(ctx.env, env);
  const code = await main(argv, ctx, commands);
  return { code, out: lines.join("\n"), err: errs.join("\n") };
};

const open = ["worktree", "open", "--repos", "repo-a,repo-b", "--branch", "feature/x", "--window", "none"];
const fwd = (p: string) => p.split("\\").join("/");
const head = (dir: string) => sh(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
const worktrees = (dir: string) => fwd(sh(dir, ["worktree", "list", "--porcelain"]));

describe("a branch whose worktree already exists elsewhere", { timeout: 30_000 }, () => {
  it("asks before anything changes: one line, three ready commands, move first; exit code 3", async () => {
    const w = world();
    write(w.old, "wip.txt", "half done\n");
    const r = await run(w.a, open);
    expect(r.code).toBe(3);
    expect(fwd(r.err)).toContain(`worktree for feature/x already exists: ${fwd(w.old)} (1 uncommitted file). choose: move it into this set (recommended; work and branch go along): aihub worktree open --repos repo-a,repo-b --branch feature/x --window none --existing move | reuse it where it is: aihub worktree open --repos repo-a,repo-b --branch feature/x --window none --existing reuse | recreate it (the old one is removed; its uncommitted work is saved as a patch first): aihub worktree open --repos repo-a,repo-b --branch feature/x --window none --existing recreate --discard-local-work`);
    // nothing changed: no set folder, no worktree for repo-b
    expect(existsSync(w.set)).toBe(false);
    expect(worktrees(w.b)).not.toContain("feature-x");
  });

  it("--json gives the question as needsChoice (exit code 0), for the VS Code extension", async () => {
    const w = world();
    const r = await run(w.a, [...open, "--json"]);
    expect(r.code).toBe(0);
    const q = JSON.parse(r.out).needsChoice;
    expect(q.existing).toMatchObject([{ repo: "repo-a", branch: "feature/x", state: "clean", dirty: 0 }]);
    expect(q.choices.map((c: { choice: string }) => c.choice)).toEqual(["move", "reuse", "recreate"]);
    expect(q.choices[2].command).not.toContain("--discard-local-work");
  });

  it("--existing reuse leaves it where it is and opens that folder in the set", async () => {
    const w = world();
    const j = JSON.parse((await run(w.a, [...open, "--existing", "reuse", "--json"])).out);
    expect(j.repos[0]).toMatchObject({ repo: "repo-a", state: "reused-worktree", ok: true });
    expect(fwd(j.repos[0].path)).toBe(fwd(w.old));
  });

  it("--existing move takes the worktree with its uncommitted work into the set", async () => {
    const w = world();
    write(w.old, "wip.txt", "half done\n");
    const j = JSON.parse((await run(w.a, [...open, "--existing", "move", "--json"])).out);
    expect(j.repos[0]).toMatchObject({ repo: "repo-a", state: "moved", ok: true });
    const to = join(w.set, "repo-a");
    expect(readFileSync(join(to, "wip.txt"), "utf8")).toBe("half done\n");
    expect(existsSync(w.old)).toBe(false);
    expect(worktrees(w.a)).toContain(`worktree ${fwd(to)}`);
    expect(worktrees(w.a)).not.toContain(fwd(w.old));
    expect(JSON.parse(readFileSync(j.workspace, "utf8")).folders).toContainEqual({ name: "repo-a", path: "repo-a" });
  });

  it("move when the target folder already exists: nothing is moved, reuse and recreate are offered", async () => {
    const w = world();
    mkdirSync(join(w.set, "repo-a"), { recursive: true });
    write(join(w.set, "repo-a"), "keep.txt", "mine\n");
    const r = await run(w.a, [...open, "--existing", "move"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL repo-a\s+failed\s+cannot move .* already exists; nothing was moved\. choose: reuse it: .* --existing reuse \| recreate it: .* --existing recreate/);
    expect(existsSync(w.old)).toBe(true);
    expect(readFileSync(join(w.set, "repo-a", "keep.txt"), "utf8")).toBe("mine\n");
  });

  it("--existing recreate removes the old worktree and makes a new one; local and remote branch stay", async () => {
    const w = world();
    const j = JSON.parse((await run(w.a, [...open, "--existing", "recreate", "--json"])).out);
    expect(j.repos[0]).toMatchObject({ repo: "repo-a", state: "recreated", ok: true });
    expect(existsSync(w.old)).toBe(false);
    expect(head(join(w.set, "repo-a"))).toBe("feature/x");
    expect(sh(w.a, ["branch", "--list", "feature/x"])).toContain("feature/x");
    expect(sh(w.a, ["ls-remote", "--heads", "origin", "feature/x"])).toContain("feature/x");
  });

  it("recreate refuses uncommitted work without --discard-local-work; with it a patch backup is kept first", async () => {
    const w = world();
    write(w.old, "wip.txt", "half done\n");
    const no = await run(w.a, [...open, "--existing", "recreate"]);
    expect(no.code).toBe(1);
    expect(no.out).toContain("1 uncommitted file(s) in");
    expect(readFileSync(join(w.old, "wip.txt"), "utf8")).toBe("half done\n");

    const j = JSON.parse((await run(w.a, [...open, "--existing", "recreate", "--discard-local-work", "--json"])).out);
    expect(j.repos[0]).toMatchObject({ state: "recreated", ok: true });
    const backup = /uncommitted work saved in (.+?\.patch)/.exec(j.repos[0].note)?.[1];
    expect(backup).toBeTruthy();
    expect(fwd(backup!)).toContain("/.git/aihub/backup/");
    expect(readFileSync(backup!, "utf8")).toContain("half done");
    expect(existsSync(join(w.set, "repo-a", "wip.txt"))).toBe(false);
  });

  it("recreate takes a folder link (junction) out first: what it points to stays whole", async () => {
    const w = world();
    const shared = join(w.parent, "shared-node-modules");
    write(shared, "pkg/index.js", "module.exports = 1;\n");
    symlinkSync(shared, join(w.old, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const j = JSON.parse((await run(w.a, [...open, "--existing", "recreate", "--json"])).out);
    expect(j.repos[0]).toMatchObject({ state: "recreated", ok: true });
    expect(readFileSync(join(shared, "pkg", "index.js"), "utf8")).toBe("module.exports = 1;\n");
  });

  it("a personal preference skips the question: move", async () => {
    const w = world();
    const { ctx } = ctxFor(w.a, fakeFetch([]).fn);
    const lines: string[] = [];
    await main(["worktree", "when-exists", "move"], { ...ctx, out: (l) => lines.push(l) }, commands);
    expect(lines[0]).toContain("when a worktree already exists: move (saved for you, not for the team)");
    const r = await run(w.a, [...open, "--json"], { AIHUB_CONFIG_HOME: ctx.env.AIHUB_CONFIG_HOME! });
    expect(JSON.parse(r.out).repos[0]).toMatchObject({ state: "moved", ok: true });
  });

  it("a preference recreate still refuses uncommitted work", async () => {
    const w = world();
    const { ctx } = ctxFor(w.a, fakeFetch([]).fn);
    await main(["worktree", "when-exists", "recreate"], ctx, commands);
    write(w.old, "wip.txt", "half done\n");
    const r = await run(w.a, open, { AIHUB_CONFIG_HOME: ctx.env.AIHUB_CONFIG_HOME! });
    expect(r.code).toBe(1);
    expect(existsSync(join(w.old, "wip.txt"))).toBe(true);
  });

  it("a worktree already in the set folder is reused without a question", async () => {
    const w = world();
    await run(w.a, [...open, "--existing", "move"]);
    const again = await run(w.a, [...open, "--json"]);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.out).repos.map((x: { state: string }) => x.state)).toEqual(["reused-worktree", "reused-worktree"]);
  });

  it("a registration whose folder is gone is pruned without a question", async () => {
    const w = world();
    rmSync(w.old, { recursive: true, force: true });
    const r = await run(w.a, [...open, "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).repos[0]).toMatchObject({ repo: "repo-a", ok: true, state: "existing" });
    expect(head(join(w.set, "repo-a"))).toBe("feature/x");
  });

  it("worktree create asks too, and --existing move puts the worktree in the story folder", async () => {
    const w = world();
    const root = join(w.parent, "sets");
    const create = ["worktree", "create", "--story", "3", "--repos", "repo-a", "--root", root, "--branch", "feature/x"];
    const r = await run(w.a, create);
    expect(r.code).toBe(3);
    expect(r.err).toContain("aihub worktree create --story 3 --repos repo-a --root");
    expect(r.err).toContain("--existing move");
    const m = await run(w.a, [...create, "--existing", "move"]);
    expect(m.code).toBe(0);
    expect(m.out).toMatch(/repo-a: moved here from/);
    expect(existsSync(w.old)).toBe(false);
    const meta = JSON.parse(readFileSync(join(root, "3-x", ".aihub-set.json"), "utf8"));
    expect(fwd(meta.repos[0].path)).toBe(fwd(join(root, "3-x", "repo-a")));
  });

  it("inside a set, branch switch to a branch with a worktree elsewhere asks with its own command", async () => {
    const w = world();
    sh(w.a, ["branch", "feature/y", "main"]);
    sh(w.b, ["branch", "feature/y", "main"]);
    const set = JSON.parse((await run(w.a, ["worktree", "open", "--repos", "repo-a,repo-b", "--branch", "feature/y", "--window", "none", "--json"])).out);
    const r = await run(join(set.folder, "repo-b"), ["branch", "switch", "--repo", "repo-a", "--branch", "feature/x"]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("aihub branch switch --repo repo-a --branch feature/x --existing move");
    expect(head(join(set.folder, "repo-a"))).toBe("feature/y");
    const m = JSON.parse((await run(join(set.folder, "repo-b"), ["branch", "switch", "--repo", "repo-a", "--branch", "feature/x", "--existing", "move", "--json"])).out);
    expect(m.repos[0]).toMatchObject({ repo: "repo-a--x", state: "moved", ok: true });
    expect(m.stays).toBe("the window stays as it is: 3 repositories, repo-a--x added on feature/x");
    expect(existsSync(w.old)).toBe(false);
  });
});
