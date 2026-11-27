import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { removeStoryFiles, sectionsText, storyArgs, storyCommandId, STORY_SUBS, type StoryCommand } from "../src/bar/stories";
import { BAR_COMMANDS } from "../src/bar/types";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { contributes: { commands: { command: string }[] } };

describe("story browser in the bar: arguments", () => {
  it("builds one aihub stories call per command, flags from the keys", () => {
    expect(storyArgs("list", { view: "sprint", types: ["User Story", "Bug"], search: "export", project: "test-project", team: "Team A", refresh: true }).args).toEqual([
      "stories", "list", "--view", "sprint", "--types", "User Story,Bug", "--search", "export", "--project", "test-project", "--team", "Team A", "--refresh",
    ]);
    expect(storyArgs("saveSettings", { project: "test-project", team: "Team A", areaPath: "test-project\\Team A" }).args).toEqual(["stories", "settings", "--save", "--project", "test-project", "--team", "Team A", "--area", "test-project\\Team A"]);
    expect(storyArgs("move", { id: 101, to: "Active", rev: 4 }).args).toEqual(["stories", "move", "--id", "101", "--to", "Active", "--rev", "4"]);
    expect(storyArgs("task", { id: 202, done: false }).args).toEqual(["stories", "task", "--undone", "--id", "202"]);
    expect(storyArgs("start", { id: 101, repos: ["repo-a", "repo-b"], assignToMe: false, open: "new" }).args).toEqual(["stories", "start", "--no-assign", "--id", "101", "--repos", "repo-a,repo-b", "--open", "new"]);
    expect(storyArgs("refineApply", { id: 101, rev: 5, parts: ["criteria", "tasks"] }).args).toEqual(["stories", "refine-apply", "--id", "101", "--rev", "5", "--parts", "criteria,tasks"]);
    expect(storyArgs("edit", { id: 1, rev: 2, tags: ["a", "b"], iterationPath: "p\\S3" }).args).toEqual(["stories", "edit", "--id", "1", "--rev", "2", "--tags", "a;b", "--iteration", "p\\S3"]);
    expect(storyArgs("draft", { draftFile: "x.md" }).args).toEqual(["stories", "draft", "--draft-file", "x.md"]);
  });

  it("text goes in private files that are removed after", () => {
    const { args, dir } = storyArgs("edit", { id: 1, rev: 2, sections: [{ heading: "Description", markdown: "A" }, { heading: "Acceptance criteria", markdown: "- [ ] B" }], systemInfo: "synthetic" });
    expect(readFileSync(args[args.indexOf("--sections-file") + 1], "utf8")).toBe("## Description\n\nA\n\n## Acceptance criteria\n\n- [ ] B\n");
    expect(readFileSync(args[args.indexOf("--system-info-file") + 1], "utf8")).toBe("synthetic");
    const c = storyArgs("comment", { id: 1, markdown: "ok" });
    expect(readFileSync(c.args[c.args.indexOf("--text-file") + 1], "utf8")).toBe("ok");
    removeStoryFiles(dir);
    expect(existsSync(dir!)).toBe(false);
    expect(sectionsText("## X\n")).toBe("## X\n");
  });

  it("refuses a call without its required arguments", () => {
    expect(() => storyArgs("move", { id: 1, to: "Active" })).toThrow(/rev/);
    expect(() => storyArgs("move", { id: 1, rev: 2 })).toThrow(/to or column/);
    expect(storyArgs("move", { id: 1, column: "Review", board: "Stories", rev: 2 }).args).toEqual(["stories", "move", "--id", "1", "--column", "Review", "--board", "Stories", "--rev", "2"]);
    expect(() => storyArgs("list", {})).toThrow(/view/);
    expect(() => storyArgs("comment", { id: 1, markdown: " " })).toThrow(/markdown/);
  });

  it("every command is in BAR_COMMANDS and contributed", () => {
    const contributed = new Set(pkg.contributes.commands.map((c) => c.command));
    for (const c of Object.keys(STORY_SUBS) as StoryCommand[]) {
      expect(Object.values(BAR_COMMANDS)).toContain(storyCommandId(c));
      expect(contributed.has(storyCommandId(c))).toBe(true);
    }
    expect(contributed.has(BAR_COMMANDS.storyRetryNow)).toBe(true);
  });
});
