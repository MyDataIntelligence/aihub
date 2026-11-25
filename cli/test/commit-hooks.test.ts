import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { digestHookOutput } from "../src/lib/hookDigest.js";
import { ctxFor, fakeFetch, makeRepo, sh, write } from "./helpers.js";

const TEAM = 'branches:\n  protected: [main]\ncommits:\n  format: "{type}({scope}): {subject} (AB#{storyId})"\n  types: [feat, fix, docs]\n';

function setup() {
  const { dir, bare } = makeRepo();
  sh(dir, ["config", "user.name", "Test"]);
  sh(dir, ["config", "user.email", "test@example.invalid"]);
  write(dir, ".agents/skills/_shared/references/team.yaml", TEAM);
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "chore: team"]);
  sh(dir, ["push", "origin", "main"]);
  sh(dir, ["checkout", "-b", "feature/77-export"]);
  return { dir, bare };
}
// git only runs executable hooks (the mode matters on Linux)
const hook = (dir: string, name: string, body: string) => {
  write(dir, `.git/hooks/${name}`, `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, ".git", "hooks", name), 0o755);
};
const dots = ".".repeat(40);
const COMMIT = ["commit", "--type", "feat", "--subject", "a"];

describe("digestHookOutput", () => {
  it("reads the pre-commit table: the failed checks, their id, exit code and first lines", () => {
    const d = digestHookOutput(
      [`trim trailing whitespace${dots}Passed`, `ruff${dots}Failed`, "- hook id: ruff", "- exit code: 1", "", "src/a.py:3:1: F401 `os` imported but unused", "Found 1 error.", `mypy${dots}Skipped`].join("\n"),
    );
    expect(d.checks).toHaveLength(1);
    expect(d.checks[0]).toMatchObject({ name: "ruff", id: "ruff", exit: 1, modifiedFiles: false });
    expect(d.checks[0].lines[0]).toContain("F401");
    expect(d.onlyFixers).toBe(false);
  });
  it("knows a formatter that only changed files from a real failure", () => {
    const fixer = digestHookOutput([`ruff-format${dots}Failed`, "- hook id: ruff-format", "- files were modified by this hook", "", "1 file reformatted"].join("\n"));
    expect(fixer.onlyFixers).toBe(true);
    const mixed = digestHookOutput([`ruff-format${dots}Failed`, "- hook id: ruff-format", "- files were modified by this hook", "1 file reformatted", `ruff${dots}Failed`, "- hook id: ruff", "- exit code: 1", "src/a.py:1:1: E501 line too long"].join("\n"));
    expect(mixed.onlyFixers).toBe(false);
  });
  it("falls back to the error lines of a hook without a table", () => {
    const d = digestHookOutput("running tests\nhusky - pre-commit script failed (code 1)\nsrc/a.py:3:1: E501 line too long\nall fine here\n");
    expect(d.checks).toHaveLength(0);
    expect(d.tail).toContain("src/a.py:3:1: E501 line too long");
    expect(d.tail.join("\n")).not.toContain("husky -");
  });
});

describe("aihub commit: a hook that stops the commit or the push", () => {
  it("says which check failed, its lines and the three choices; nothing is committed", async () => {
    const { dir } = setup();
    hook(dir, "pre-commit", [`echo "ruff${dots}Failed"`, 'echo "- hook id: ruff"', 'echo "- exit code: 1"', 'echo ""', 'echo "src/a.py:1:1: F401 os imported but unused"', "exit 1"].join("\n"));
    write(dir, "src/a.py", "import os\n");
    const before = sh(dir, ["rev-parse", "HEAD"]);
    const { ctx, errs } = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(COMMIT, ctx)).toBe(1);
    const text = errs.join("\n");
    expect(text).toMatch(/not committed: the pre-commit hook stopped it \(\d+\.\d s\)/);
    expect(text).toContain("failed: ruff (exit 1)");
    expect(text).toContain("ruff: src/a.py:1:1: F401 os imported but unused");
    expect(text).toContain('fix the lines above, then run again: aihub commit --type feat --subject "a"');
    expect(text).toContain('skip only this check: aihub commit --type feat --subject "a" --skip-hooks ruff');
    expect(text).toContain('skip all hooks this once: aihub commit --type feat --subject "a" --no-verify');
    expect(sh(dir, ["rev-parse", "HEAD"])).toBe(before);
    const file = /full output: (.+)$/m.exec(text)?.[1] ?? "";
    expect(existsSync(file) && readFileSync(file, "utf8")).toContain("- hook id: ruff");
  });

  it("a hook without a table: the error lines it printed", async () => {
    const { dir } = setup();
    hook(dir, "pre-commit", 'echo "collecting tests"\necho "tests/test_a.py:4: AssertionError: expected 2" >&2\nexit 1');
    write(dir, "src/a.py", "x = 1\n");
    const { ctx, errs } = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(COMMIT, ctx)).toBe(1);
    const text = errs.join("\n");
    expect(text).toContain("what the hook said:");
    expect(text).toContain("tests/test_a.py:4: AssertionError: expected 2");
    expect(text).not.toContain("--skip-hooks");
  });

  it("hooks that only reformatted the files get one second try and the commit holds their version", async () => {
    const { dir } = setup();
    hook(
      dir,
      "pre-commit",
      ['if grep -q "x=1" src/a.py; then', '  printf "x = 1\\n" > src/a.py', `  echo "ruff-format${dots}Failed"`, '  echo "- hook id: ruff-format"', '  echo "- files were modified by this hook"', '  echo ""', '  echo "1 file reformatted"', "  exit 1", "fi", "exit 0"].join("\n"),
    );
    write(dir, "src/a.py", "x=1\n");
    const { ctx, lines, errs } = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(COMMIT, ctx)).toBe(0);
    expect(errs).toHaveLength(0);
    expect(lines[lines.length - 1]).toContain("the hooks reformatted 1 file(s); committed on the second try");
    expect(sh(dir, ["show", "HEAD:src/a.py"])).toBe("x = 1");
    expect(sh(dir, ["status", "--porcelain"])).toBe("");
  });

  it("--skip-hooks passes the ids to the hooks (SKIP) and says so", async () => {
    const { dir } = setup();
    hook(dir, "pre-commit", 'if [ "$SKIP" = "ruff,mypy" ]; then exit 0; fi\necho "ruff failed"\nexit 1');
    write(dir, "src/a.py", "x = 1\n");
    const { ctx, lines } = ctxFor(dir, fakeFetch([]).fn);
    expect(await main([...COMMIT, "--skip-hooks", "ruff,mypy"], ctx)).toBe(0);
    expect(lines[lines.length - 1]).toContain("(skipped at the user's request: ruff, mypy)");
  });

  it("a pre-push hook: the commit stays, the message says so, and the same command again only pushes", async () => {
    const { dir, bare } = setup();
    hook(dir, "pre-push", 'echo "pytest: 2 failed, 40 passed" >&2\nexit 1');
    write(dir, "src/a.py", "x = 1\n");
    const a = ctxFor(dir, fakeFetch([]).fn);
    expect(await main([...COMMIT, "--push"], a.ctx)).toBe(1);
    const text = a.errs.join("\n");
    expect(text).toMatch(/^aihub: committed \w+ on feature\/77-export; not pushed: the pre-push hook stopped it/);
    expect(text).toContain("pytest: 2 failed, 40 passed");
    expect(text).toContain('run again: aihub commit --type feat --subject "a" --push');
    expect(sh(dir, ["log", "-1", "--format=%s"])).toBe("feat(src): a (AB#77)");
    expect(sh(bare, ["branch", "--list", "feature/77-export"])).toBe("");
    // fixed (here: the hook passes now): the same command pushes the commit that is already there
    hook(dir, "pre-push", "exit 0");
    const b = ctxFor(dir, fakeFetch([]).fn);
    expect(await main([...COMMIT, "--push"], b.ctx)).toBe(0);
    expect(b.lines[b.lines.length - 1]).toMatch(/^pushed \w+ on feature\/77-export \(nothing new to commit\)/);
    expect(sh(bare, ["branch", "--list", "feature/77-export"])).toContain("feature/77-export");
  });

  it("--no-verify after a failed push pushes the existing commit without the hook", async () => {
    const { dir, bare } = setup();
    hook(dir, "pre-push", "exit 1");
    write(dir, "src/a.py", "x = 1\n");
    expect(await main([...COMMIT, "--push"], ctxFor(dir, fakeFetch([]).fn).ctx)).toBe(1);
    const b = ctxFor(dir, fakeFetch([]).fn);
    expect(await main([...COMMIT, "--push", "--no-verify"], b.ctx)).toBe(0);
    expect(b.lines[b.lines.length - 1]).toContain("(hooks skipped at the user's request)");
    expect(sh(bare, ["branch", "--list", "feature/77-export"])).toContain("feature/77-export");
  });
});
