import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commands, main } from "../src/router.js";
import { readSetFile, repoBranch } from "../src/lib/setFile.js";
import { ctxFor, fakeFetch, sh } from "./helpers.js";
import { makeNamedRepo, newParent } from "./parity-helpers.js";

const run = async (cwd: string, argv: string[]) => {
  const { ctx, lines, errs } = ctxFor(cwd, fakeFetch([]).fn);
  const code = await main(argv, ctx, commands);
  return { code, out: lines.join("\n"), err: errs.join("\n") };
};

describe("worktree create into a story that has a set", { timeout: 90_000 }, () => {
  it("another --branch does not rename the set: the new repository gets its own branch", async () => {
    const parent = newParent();
    const dirs = ["repo-a", "repo-b"].map((n) => makeNamedRepo(parent, n).dir);
    for (const d of dirs) {
      sh(d, ["config", "user.name", "Test"]);
      sh(d, ["config", "user.email", "test@example.invalid"]);
    }
    const root = join(parent, "sets");
    const first = await run(dirs[0], ["worktree", "create", "--story", "4", "--repos", "repo-a", "--branch", "feature/4-a", "--root", root, "--json"]);
    expect(first.code).toBe(0);
    const folder = JSON.parse(first.out).folder;
    const second = await run(dirs[0], ["worktree", "create", "--story", "4", "--repos", "repo-b", "--branch", "feature/4-b", "--root", root, "--json"]);
    expect(second.code).toBe(0);
    const set = readSetFile(folder)!.top;
    expect(set.branch).toBe("feature/4-a");
    expect(set.repos.map((r) => [r.name, repoBranch(set, r)])).toEqual([
      ["repo-a", "feature/4-a"],
      ["repo-b", "feature/4-b"],
    ]);
    expect(sh(set.repos[0].path, ["branch", "--show-current"])).toBe("feature/4-a");
  });

  it("a folder with a set in the extension's format is not given a second set file", async () => {
    const parent = newParent();
    const a = makeNamedRepo(parent, "repo-a").dir;
    sh(a, ["config", "user.name", "Test"]);
    sh(a, ["config", "user.email", "test@example.invalid"]);
    const root = join(parent, "sets");
    const folder = join(root, "story-4");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, ".worktree-set.json"), JSON.stringify({ schemaVersion: 1, branch: "feature/4-a", slug: "feature-4-a", repos: [] }));
    const r = await run(a, ["worktree", "create", "--story", "4", "--repos", "repo-a", "--branch", "feature/4-a", "--root", root]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("extension's format");
    expect(existsSync(join(folder, ".aihub-set.json"))).toBe(false);
    expect(readFileSync(join(folder, ".worktree-set.json"), "utf8")).toContain("feature/4-a");
  });
});
