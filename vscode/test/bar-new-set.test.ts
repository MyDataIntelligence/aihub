import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newSetArgs, notOnThisPc, preTicked, reusedInPlace } from "../src/bar/newSet";
import { BAR_COMMANDS } from "../src/bar/types";

describe("New Set… / Open as Set…: a set of repositories the user picks", () => {
  const a = { name: "repo-a", path: "C:\\g\\repo-a", current: "main", branch: "feature/new" };
  const b = { name: "repo-b", path: "C:\\g\\repo-b", current: "feature/new", branch: "feature/new" };

  it("one aihub worktree open --new-set: the repositories that get a worktree first, the one already on the branch (used where it is) last", () => {
    expect(reusedInPlace(a)).toBe(false);
    expect(reusedInPlace(b)).toBe(true);
    expect(newSetArgs([b, a], "feature/new", 4711)).toEqual([
      "worktree", "open", "--repos", "C:\\g\\repo-a,C:\\g\\repo-b", "--branch", "feature/new", "--branch-for", "repo-a=feature/new,repo-b=feature/new", "--story", "4711", "--new-set", "--window", "none", "--json",
    ]);
    expect(newSetArgs([a], "feature/new")).not.toContain("--story");
  });

  it("an existing branch per repository: each on its own, the set's branch is the first one's", () => {
    const x = { ...a, branch: "staging" };
    const y = { ...b, branch: "hotfix/2" };
    expect(newSetArgs([x, y], x.branch)).toEqual(["worktree", "open", "--repos", "C:\\g\\repo-a,C:\\g\\repo-b", "--branch", "staging", "--branch-for", "repo-a=staging,repo-b=hotfix/2", "--new-set", "--window", "none", "--json"]);
  });

  it("Clone from Azure DevOps… offers only the repositories that are not on this PC", () => {
    const remote = [{ name: "repo-z", project: "p" }, { name: "Repo-A", project: "p" }, { name: "repo-m", project: "q" }];
    expect(notOnThisPc(remote, [{ name: "repo-a" }]).map((r) => r.name)).toEqual(["repo-m", "repo-z"]);
  });

  it("Open as Set… ticks the repositories it gets (clone folders), case and trailing slash do not matter", () => {
    expect([...preTicked({ repos: ["C:\\G\\Repo-A\\", "C:\\g\\repo-b", 3] })]).toEqual(["c:\\g\\repo-a", "c:\\g\\repo-b"]);
    expect(preTicked(undefined).size).toBe(0);
    expect(preTicked({ repos: "x" }).size).toBe(0);
  });

  it("the command is in the contract and registered; a story with a set opens that set; the new set opens in a new window after Undo is saved", () => {
    expect(BAR_COMMANDS.newSet).toBe("aihub.bar.newSet");
    const ui = readFileSync(join(__dirname, "../src/bar/storyUi.ts"), "utf8");
    expect(ui).toContain('h.reg("aihub.bar.newSet", (arg?: unknown) => newSet(h, arg));');
    expect(ui).toMatch(/const have = setOfStory\(h\.engine\.scan\(\{ refresh: true \}\), story\.id\);[\s\S]*?executeCommand\("aihub\.bar\.openSet", \{ id: have\.id \}\)/);
    expect(ui).toMatch(/if \(made\) await showOpened\(made, "new"/);
    expect(ui).toContain('tooltip: "Clone from Azure DevOps…"');
  });
});
