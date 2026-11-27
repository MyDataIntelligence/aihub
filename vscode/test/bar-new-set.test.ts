import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { notOnThisPc, openReposArgOf, preTicked } from "../src/bar/newSet";
import { parseOpenRepos } from "../src/bar/openReposAsSet";
import { BAR_COMMANDS } from "../src/bar/types";

describe("New Set… / Open as Set…: the questions; the work is aihub.bar.openReposAsSet", () => {
  const local = { name: "repo-a", path: "C:\\g\\repo-a" };
  const toClone = { name: "repo-z", project: "Orders", remoteUrl: "https://dev.azure.com/o/Orders/_git/repo-z" };

  it("one new branch for all: the shared newBranch, the story, a new window; a repository to clone keeps its remote url", () => {
    const arg = openReposArgOf([local, toClone], { all: "feature/set-demo" }, 4711);
    expect(arg).toEqual({ repos: [{ name: "repo-a" }, { name: "repo-z", project: "Orders", remoteUrl: "https://dev.azure.com/o/Orders/_git/repo-z" }], newBranch: "feature/set-demo", story: 4711, window: "new" });
    // the engine accepts it as it is
    expect("problem" in parseOpenRepos(arg)).toBe(false);
  });

  it("an existing branch per repository, by name; no story", () => {
    const arg = openReposArgOf([local, toClone], { branches: { "repo-a": "staging", "repo-z": "main" } });
    expect(arg).toEqual({ repos: [{ name: "repo-a", branch: "staging" }, { name: "repo-z", project: "Orders", remoteUrl: "https://dev.azure.com/o/Orders/_git/repo-z", branch: "main" }], window: "new" });
    expect("problem" in parseOpenRepos(arg)).toBe(false);
  });

  it("Clone from Azure DevOps… offers only the repositories that are not on this PC", () => {
    const remote = [{ name: "repo-z", project: "p" }, { name: "Repo-A", project: "p" }, { name: "repo-m", project: "q" }];
    expect(notOnThisPc(remote, [{ name: "repo-a" }]).map((r) => r.name)).toEqual(["repo-m", "repo-z"]);
  });

  it("Open as Set… ticks the repositories it gets (clone folders), case and trailing slash do not matter", () => {
    expect([...preTicked({ repos: ["C:\\G\\Repo-A\\", "C:\\g\\repo-b", 3] })]).toEqual(["c:\\g\\repo-a", "c:\\g\\repo-b"]);
    expect(preTicked(undefined).size).toBe(0);
  });

  it("the command asks the questions and hands the set to openReposAsSet (no worktree call of its own)", () => {
    expect(BAR_COMMANDS.newSet).toBe("aihub.bar.newSet");
    const ui = readFileSync(join(__dirname, "../src/bar/storyUi.ts"), "utf8");
    const flow = ui.slice(ui.indexOf("async function newSet("), ui.indexOf("async function defaultTarget("));
    expect(flow).toMatch(/executeCommand\(BAR_COMMANDS\.openReposAsSet, arg2\)/);
    expect(flow).not.toMatch(/"worktree", "open"|newSetArgs|withUndo\(/);
    expect(flow).toContain('title: "Link to a story?"');
    expect(ui).toContain('h.reg("aihub.bar.newSet", (arg?: unknown) => newSet(h, arg));');
  });
});
