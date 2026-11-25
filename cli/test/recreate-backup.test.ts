import { readdirSync, readFileSync, writeFileSync } from "node:fs";
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

describe("recreate keeps the uncommitted work as a patch that applies again", { timeout: 60_000 }, () => {
  it("also for files with Windows line endings", async () => {
    const parent = newParent();
    const a = makeNamedRepo(parent, "repo-a").dir;
    sh(a, ["config", "user.name", "Test"]);
    sh(a, ["config", "user.email", "test@example.invalid"]);
    sh(a, ["config", "core.autocrlf", "false"]);
    writeFileSync(join(a, "report.sql"), "select 1\r\nfrom t\r\n");
    sh(a, ["add", "report.sql"]);
    sh(a, ["commit", "-m", "crlf file"]);
    sh(a, ["push", "origin", "main:refs/heads/feature/x"]);
    const old = join(parent, "other", "repo-a-x");
    sh(a, ["worktree", "add", old, "feature/x"]);
    writeFileSync(join(old, "report.sql"), "select 1\r\nfrom t\r\nwhere a = 1\r\n");
    const r = await run(a, ["worktree", "open", "--repos", "repo-a", "--branch", "feature/x", "--window", "none", "--existing", "recreate", "--discard-local-work", "--json"]);
    expect(r.code).toBe(0);
    const made = JSON.parse(r.out).repos[0].path as string;
    const dir = join(sh(made, ["rev-parse", "--git-common-dir"]), "aihub", "backup");
    const patch = join(dir, readdirSync(dir)[0]);
    // the patch must still apply to the clean branch and give back the work, byte for byte
    sh(made, ["apply", patch]);
    expect(readFileSync(join(made, "report.sql"), "utf8")).toBe("select 1\r\nfrom t\r\nwhere a = 1\r\n");
  });
});
