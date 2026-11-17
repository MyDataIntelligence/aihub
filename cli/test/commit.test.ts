import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { formatCommit, inferScope } from "../src/lib/commit.js";
import { ctxFor, fakeFetch, makeRepo, sh, write } from "./helpers.js";

function setup(team: string) {
  const { dir, bare } = makeRepo();
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
