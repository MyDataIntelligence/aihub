import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commands, main } from "../src/router.js";
import { ctxFor, fakeFetch, sh } from "./helpers.js";
import { makeNamedRepo, newParent } from "./parity-helpers.js";

const run = async (cwd: string, argv: string[]) => {
  const { ctx, lines, errs } = ctxFor(cwd, fakeFetch([]).fn);
  const code = await main(argv, ctx, commands);
  return { code, out: lines.join("\n"), err: errs.join("\n") };
};

describe("recreate that stops after the backup leaves the worktree as it was", { timeout: 60_000 }, () => {
  it("staged, unstaged and untracked work keep their state", async () => {
    const parent = newParent();
    const a = makeNamedRepo(parent, "repo-a").dir;
    sh(a, ["config", "user.name", "Test"]);
    sh(a, ["config", "user.email", "test@example.invalid"]);
    sh(a, ["config", "core.autocrlf", "false"]);
    writeFileSync(join(a, "one.txt"), "1\n");
    writeFileSync(join(a, "two.txt"), "2\n");
    sh(a, ["add", "."]);
    sh(a, ["commit", "-m", "two files"]);
    sh(a, ["push", "origin", "main:refs/heads/feature/x"]);
    const old = join(parent, "other", "repo-a-x");
    sh(a, ["worktree", "add", old, "feature/x"]);
    writeFileSync(join(old, "one.txt"), "1 staged\n");
    sh(old, ["add", "one.txt"]);
    writeFileSync(join(old, "two.txt"), "2 unstaged\n");
    writeFileSync(join(old, "new.txt"), "untracked\n");
    // git refuses to remove a locked worktree: the action stops after the backup
    sh(a, ["worktree", "lock", old]);
    const before = sh(old, ["status", "--porcelain"]);
    expect(before).toContain("M  one.txt");
    const r = await run(a, ["worktree", "open", "--repos", "repo-a", "--branch", "feature/x", "--window", "none", "--existing", "recreate", "--discard-local-work", "--json"]);
    expect(JSON.parse(r.out).repos[0].ok).toBe(false);
    expect(sh(old, ["status", "--porcelain"])).toBe(before);
    // and the work is in the backup
    const dir = join(a, ".git", "aihub", "backup");
    expect(readdirSync(dir).filter((f) => f.endsWith(".patch"))).toHaveLength(1);
  });
});
