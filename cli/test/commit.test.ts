import { chmodSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { formatCommit, inferScope } from "../src/lib/commit.js";
import { hasWorkToCommit } from "../src/lib/gitx.js";
import { ctxFor, fakeFetch, makeRepo, sh, write } from "./helpers.js";

function setup(team: string) {
  const { dir, bare } = makeRepo();
  sh(dir, ["config", "user.name", "Test"]);
  sh(dir, ["config", "user.email", "test@example.invalid"]);
  write(dir, ".agents/skills/_shared/references/team.yaml", team);
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "chore: team"]);
  sh(dir, ["push", "origin", "main"]);
  sh(dir, ["checkout", "-b", "feature/77-export"]);
  return { dir, bare };
}

const TEAM = 'branches:\n  protected: [main]\ncommits:\n  format: "{type}({scope}): {subject} (AB#{storyId})"\n  types: [feat, fix, docs]\n';

describe("formatCommit", () => {
  it("fills the team format and drops unknown optional parts", () => {
    expect(formatCommit("{type}({scope}): {subject} (AB#{storyId})", { type: "feat", scope: "orders", subject: "toon korting", storyId: 5 })).toBe("feat(orders): toon korting (AB#5)");
    expect(formatCommit("{type}({scope}): {subject} (AB#{storyId})", { type: "fix", subject: "x" })).toBe("fix: x");
    expect(formatCommit("{subject} (AB#{storyId})", { subject: "x", storyId: 9 })).toBe("x (AB#9)");
  });
  it("infers the scope from the most common top-level folder", () => {
    expect(inferScope(["bench/a.py", "bench/b.py", "docs/x.md", "README.md"])).toBe("bench");
    expect(inferScope(["README.md"])).toBeUndefined();
  });
});

describe("aihub commit", () => {
  it("does not stage build output (__pycache__, .pyc) in a repository without .gitignore, and status ignores it too", async () => {
    const { dir } = setup(TEAM);
    write(dir, "bench/a.py", "x = 1\n");
    write(dir, "bench/__pycache__/a.cpython-312.pyc", "bin\n");
    const { ctx } = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(["commit", "--type", "feat", "--subject", "iets"], ctx)).toBe(0);
    const files = sh(dir, ["show", "--name-only", "--format=", "HEAD"]);
    expect(files).toContain("bench/a.py");
    expect(files).not.toContain("pycache");
    expect(hasWorkToCommit(dir)).toBe(false);
    write(dir, "bench/new.py", "y = 2\n");
    expect(hasWorkToCommit(dir)).toBe(true);
  });

  it("stages everything, builds the message from team.yaml and the branch, and does not push without --push", async () => {
    const { dir, bare } = setup(TEAM);
    write(dir, "bench/a.py", "x = 1\n");
    write(dir, "README.md", "changed\n");
    const { ctx, lines, errs } = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(["commit", "--type", "feat", "--subject", "toon het totaal van een order"], ctx)).toBe(0);
    expect(errs).toEqual([]);
    expect(sh(dir, ["log", "-1", "--format=%s"])).toBe("feat(bench): toon het totaal van een order (AB#77)");
    expect(sh(dir, ["status", "--porcelain"])).toBe("");
    expect(sh(bare, ["branch", "--list", "feature/77-export"])).toBe("");
    expect(lines[0]).toContain("committed");
  });

  it("pushes with --push", async () => {
    const { dir, bare } = setup(TEAM);
    write(dir, "src/a.py", "x = 1\n");
    const { ctx } = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(["commit", "--type", "fix", "--subject", "herstel", "--push"], ctx)).toBe(0);
    expect(sh(bare, ["rev-parse", "feature/77-export"])).toBe(sh(dir, ["rev-parse", "HEAD"]));
  });

  it("rejects an unknown type, a missing type, nothing to commit and a protected branch", async () => {
    const { dir } = setup(TEAM);
    write(dir, "a.py", "1\n");
    const { ctx, errs } = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(["commit", "--type", "wip", "--subject", "x"], ctx)).toBe(1);
    expect(errs.join("\n")).toMatch(/must be one of: feat, fix, docs/);
    expect(await main(["commit", "--subject", "x"], ctx)).toBe(1);
    expect(errs.join("\n")).toMatch(/--type is required/);
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "chore: eerst"]);
    expect(await main(["commit", "--type", "feat", "--subject", "x"], ctx)).toBe(1);
    expect(errs.join("\n")).toMatch(/nothing to commit/);
    sh(dir, ["checkout", "main"]);
    write(dir, "b.py", "1\n");
    expect(await main(["commit", "--type", "feat", "--subject", "x"], ctx)).toBe(1);
    expect(errs.join("\n")).toMatch(/protected branch/);
  });

  it("works without a commits block: subject plus the story link", async () => {
    const { dir } = setup("branches:\n  protected: [main]\n");
    write(dir, "a.py", "1\n");
    const { ctx } = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(["commit", "--subject", "iets"], ctx)).toBe(0);
    expect(sh(dir, ["log", "-1", "--format=%s"])).toBe("iets (AB#77)");
  });
});

describe("aihub commit and the repository's git hooks", () => {
  // git only runs executable hooks (the mode matters on Linux)
  const hook = (dir: string, name: string, body: string) => {
    write(dir, `.git/hooks/${name}`, `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, ".git", "hooks", name), 0o755);
  };


  it("says which hooks run before them and how long they took after (live: a pre-commit running the full suite)", async () => {
    const { dir } = setup(TEAM);
    hook(dir, "pre-commit", "exit 0");
    write(dir, ".git/hooks/pre-push.sample", "#!/bin/sh\nexit 1\n");
    write(dir, "src/a.py", "x = 1\n");
    const { ctx, lines } = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(["commit", "--type", "feat", "--subject", "a"], ctx)).toBe(0);
    expect(lines[0]).toMatch(/^git hooks running: pre-commit \(/);
    expect(lines[0]).not.toContain("pre-push");
    expect(lines[1]).toMatch(/^committed \w+ on feature\/77-export: feat\(src\): a \(AB#77\) \(commit hooks took \d+\.\d s\)$/);
  });

  it("prints nothing about hooks when the repository has none", async () => {
    const { dir } = setup(TEAM);
    write(dir, "src/a.py", "x = 1\n");
    const { ctx, lines } = ctxFor(dir, fakeFetch([]).fn);
    await main(["commit", "--type", "feat", "--subject", "a"], ctx);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("hooks");
  });

  it("a failing hook stops the commit with git's message; --no-verify skips it and says so", async () => {
    const { dir } = setup(TEAM);
    hook(dir, "pre-commit", "echo tests failed >&2\nexit 1");
    write(dir, "src/a.py", "x = 1\n");
    const a = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(["commit", "--type", "feat", "--subject", "a"], a.ctx)).toBe(1);
    expect(a.errs.join("\n")).toContain("failed");
    const b = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(["commit", "--type", "feat", "--subject", "a", "--no-verify"], b.ctx)).toBe(0);
    expect(b.lines.join("\n")).not.toContain("git hooks running");
    expect(b.lines.join("\n")).toContain("(hooks skipped at the user's request)");
  });

  it("names the pre-push hook before the push and skips it with --no-verify", async () => {
    const { dir } = setup(TEAM);
    hook(dir, "pre-push", "exit 1");
    write(dir, "src/a.py", "x = 1\n");
    const a = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(["commit", "--type", "feat", "--subject", "a", "--push"], a.ctx)).toBe(1);
    expect(a.lines.join("\n")).toContain("git hooks running on push: pre-push");
    write(dir, "src/b.py", "y = 1\n");
    const b = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(["commit", "--type", "feat", "--subject", "b", "--push", "--no-verify"], b.ctx)).toBe(0);
    expect(b.lines.join("\n")).toContain("and pushed");
  });

  it("--json carries hooks and timing", async () => {
    const { dir } = setup(TEAM);
    hook(dir, "commit-msg", "exit 0");
    write(dir, "src/a.py", "x = 1\n");
    const { ctx, lines } = ctxFor(dir, fakeFetch([]).fn);
    await main(["commit", "--type", "feat", "--subject", "a", "--json"], ctx);
    const j = JSON.parse(lines[0]);
    expect(j.hooks).toEqual(["commit-msg"]);
    expect(typeof j.commitMs).toBe("number");
    expect(j.noVerify).toBe(false);
  });
});
