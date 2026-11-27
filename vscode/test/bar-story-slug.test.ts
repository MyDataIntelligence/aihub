import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nextStoryBranch, openStoryArgs, storyBranchFor } from "../src/bar/storyModel";

describe("Open Story names the branch as the CLI does, never with a dash at the end (persona round 2, N1)", () => {
  it("the title's slug; 'story' when no title is known (by number before the read), never feature/<id>-", () => {
    expect(storyBranchFor({ id: 3751, title: "Gewone titel zonder tekens" })).toBe("feature/3751-gewone-titel-zonder-tekens");
    expect(storyBranchFor({ id: 3752, title: "Café é: a & b/c" })).toBe("feature/3752-cafe-e-a-b-c");
    expect(storyBranchFor({ id: 3756, title: "Straße/Übung: 50% & meer?" })).toBe("feature/3756-strasse-ubung-50-meer");
    expect(storyBranchFor({ id: 3747, title: "" })).toBe("feature/3747-story");
    expect(storyBranchFor({ id: 3747, title: "日本語" })).toBe("feature/3747-story");
    for (const t of ["", "   ", "!!!", "[persona2] …"]) expect(storyBranchFor({ id: 1, title: t })).not.toMatch(/-$/);
  });

  it("a new repository of the set gets that branch; the next one counts on from it", () => {
    expect(openStoryArgs({ id: 3747, title: "" }, [{ repo: "repo-a", path: "/c/repo-a", picked: true, onThisPc: true }])).toEqual(["worktree", "open", "--repos", "/c/repo-a", "--branch", "feature/3747-story", "--branch-for", "repo-a=feature/3747-story", "--story", "3747", "--window", "none"]);
    expect(nextStoryBranch({ id: 3747, title: "" }, ["feature/3747-story"])).toBe("feature/3747-story-2");
  });

  it("by number the title is read first (one read, the one that was already there) and used before anything is named", () => {
    const ui = readFileSync(join(__dirname, "../src/bar/storyUi.ts"), "utf8");
    expect(ui).toMatch(/const read = await vscode\.window\.withProgress\([^\n]*storyRead\(story, picked, cwd\)\)/);
    expect(ui).toMatch(/if \(!story\.title && read\.title\) story = \{ \.\.\.story, title: read\.title \};/);
    // the read comes before the repositories are picked and the CLI is called
    expect(ui.indexOf("storyRead(story, picked, cwd)")).toBeLessThan(ui.indexOf("openStoryArgs(story, ticked)"));
  });
});
