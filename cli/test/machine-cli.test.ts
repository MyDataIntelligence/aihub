import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { rememberUse } from "../src/lib/recentUse.js";
import { rememberStories } from "../src/lib/storyCache.js";
import { commands, main } from "../src/router.js";
import { ctxFor, fakeFetch, sh } from "./helpers.js";
import { makeNamedRepo, newParent } from "./parity-helpers.js";

/** One config home for several calls (ctxFor makes a new one each time). */
function runner(config: string) {
  return async (cwd: string, argv: string[]) => {
    const { ctx, lines, errs } = ctxFor(cwd, fakeFetch([]).fn);
    ctx.env.AIHUB_CONFIG_HOME = config;
    ctx.env.AIHUB_COMMON_ROOTS = "";
    const code = await main(argv, ctx, commands);
    return { code, out: lines.join("\n"), err: errs.join("\n") };
  };
}

describe("aihub worktree list --all | look-in, aihub recent", { timeout: 60_000 }, () => {
  it("lists every set and clone of this PC from a folder that has nothing to do with them", async () => {
    const parent = newParent();
    const a = makeNamedRepo(parent, "repo-a");
    const b = makeNamedRepo(parent, "repo-b");
    for (const r of [a, b]) {
      sh(r.dir, ["config", "user.name", "Test"]);
      sh(r.dir, ["config", "user.email", "test@example.invalid"]);
    }
    const config = mkdtempSync(join(tmpdir(), "aihub-cfg-"));
    const run = runner(config);
    const open = await run(a.dir, ["worktree", "open", "--repos", "repo-a,repo-b", "--branch", "feature/7-x", "--from", "main", "--window", "none", "--story", "7", "--json"]);
    expect(open.code).toBe(0);
    const elsewhere = mkdtempSync(join(tmpdir(), "aihub-elsewhere-"));
    // no list of folders yet and nothing known: it says how to start
    expect((await run(elsewhere, ["worktree", "list", "--all"])).out).toContain("looking in:");
    const add = await run(elsewhere, ["worktree", "look-in", "add", dirname(a.dir)]);
    expect(add.out).toContain("your list");
    const all = JSON.parse((await run(elsewhere, ["worktree", "list", "--all", "--json", "--refresh"])).out);
    expect(all.repositories.map((r: { name: string }) => r.name)).toEqual(expect.arrayContaining(["repo-a", "repo-b"]));
    expect(all.sets).toHaveLength(1);
    expect(all.sets[0]).toMatchObject({ story: 7, branch: "feature/7-x" });
    expect(all.sets[0].repos.map((r: { name: string }) => r.name)).toEqual(["repo-a", "repo-b"]);
    const text = (await run(elsewhere, ["worktree", "list", "--all"])).out;
    expect(text).toContain("worktree sets (1)");
    expect(text).toContain("feature/7-x");
    const gone = await run(elsewhere, ["worktree", "look-in", "remove", dirname(a.dir)]);
    expect(gone.out).toContain("(none)");
    const reset = await run(elsewhere, ["worktree", "look-in", "reset"]);
    expect(reset.out).toContain("the parents of what is known");
  });

  it("aihub recent: the list the buttons show, as text and json, and forget", async () => {
    const config = mkdtempSync(join(tmpdir(), "aihub-cfg-"));
    const run = runner(config);
    const env = { AIHUB_CONFIG_HOME: config };
    expect((await run(config, ["recent"])).out).toBe("nothing recent yet");
    rememberUse(env, { kind: "repo", id: "/code/repo-a", label: "repo-a", detail: "main" }, Date.now() - 3 * 3_600_000);
    rememberUse(env, { kind: "set", id: "/w/7/story-7.code-workspace", label: "#7 Export", story: 7 }, Date.now() - 60_000);
    rememberStories(env, [{ id: 7, title: "Export" }]);
    const text = (await run(config, ["recent"])).out.split("\n");
    expect(text[0]).toContain("#7 Export");
    expect(text[1]).toContain("repo-a");
    expect(text[1]).toContain("3 h ago");
    const json = JSON.parse((await run(config, ["recent", "--json"])).out);
    expect(json.recent.map((r: { id: string }) => r.id)).toEqual(["/w/7/story-7.code-workspace", "/code/repo-a"]);
    expect((await run(config, ["recent", "forget", "/code/repo-a"])).out).toContain("forgotten");
    expect(JSON.parse((await run(config, ["recent", "--json"])).out).recent).toHaveLength(1);
    expect((await run(config, ["recent", "nonsense"])).code).not.toBe(0);
  });

  it("aihub story open --id N opens the story's one set as it is: no Azure DevOps read, no new set, no question", async () => {
    const parent = newParent();
    const a = makeNamedRepo(parent, "repo-a");
    sh(a.dir, ["config", "user.name", "Test"]);
    sh(a.dir, ["config", "user.email", "test@example.invalid"]);
    const config = mkdtempSync(join(tmpdir(), "aihub-cfg-"));
    const run = runner(config);
    const made = JSON.parse((await run(a.dir, ["worktree", "open", "--repos", "repo-a", "--branch", "feature/7-x", "--from", "main", "--window", "none", "--story", "7", "--json"])).out);
    // the fake fetch has no answers: any call to Azure DevOps would fail this run
    const again = await run(a.dir, ["story", "open", "--id", "7", "--window", "none", "--json"]);
    expect(again.code).toBe(0);
    const r = JSON.parse(again.out);
    expect(r).toMatchObject({ story: 7, branch: "feature/7-x", folder: made.folder });
    expect(r.repos).toMatchObject([{ repo: "repo-a", ok: true, state: "existing" }]);
    // from a window that has nothing to do with it, too; and it is on the recent list now
    const elsewhere = mkdtempSync(join(tmpdir(), "aihub-elsewhere-"));
    await run(elsewhere, ["worktree", "look-in", "add", dirname(a.dir)]);
    expect(JSON.parse((await run(elsewhere, ["story", "open", "--id", "7", "--window", "none", "--json"])).out).folder).toBe(made.folder);
    expect(JSON.parse((await run(elsewhere, ["recent", "--json"])).out).recent[0]).toMatchObject({ kind: "set", story: 7 });
  });

  it("aihub worktree remove --folder removes exactly that set; a worktree with work in it stays and is named", async () => {
    const parent = newParent();
    const a = makeNamedRepo(parent, "repo-a");
    const b = makeNamedRepo(parent, "repo-b");
    for (const r of [a, b]) {
      sh(r.dir, ["config", "user.name", "Test"]);
      sh(r.dir, ["config", "user.email", "test@example.invalid"]);
    }
    const config = mkdtempSync(join(tmpdir(), "aihub-cfg-"));
    const run = runner(config);
    const made = JSON.parse((await run(a.dir, ["worktree", "open", "--repos", "repo-a,repo-b", "--branch", "feature/7-x", "--from", "main", "--window", "none", "--story", "7", "--json"])).out);
    writeFileSync(join(made.folder, "repo-b", "wip.txt"), "unsaved work");
    const first = JSON.parse((await run(a.dir, ["worktree", "remove", "--folder", made.folder, "--branch", "feature/7-x", "--story", "7", "--json"])).out);
    expect(first.kept).toEqual(["repo-b"]);
    expect(first.lines.join(" | ")).toContain("repo-b: kept, uncommitted changes");
    expect(existsSync(join(made.folder, "repo-a"))).toBe(false);
    expect(existsSync(join(made.folder, "repo-b", "wip.txt"))).toBe(true);
    // the branches stay
    expect(sh(a.dir, ["branch", "--list", "feature/7-x"])).toContain("feature/7-x");
    rmSync(join(made.folder, "repo-b", "wip.txt"));
    const second = JSON.parse((await run(a.dir, ["worktree", "remove", "--folder", made.folder, "--branch", "feature/7-x", "--json"])).out);
    expect(second.kept).toEqual([]);
    expect(existsSync(made.folder)).toBe(false);
    const none = await run(a.dir, ["worktree", "remove", "--folder", made.folder]);
    expect(none.code).not.toBe(0);
    expect(none.err).toContain("no worktree set in");
  });
});
