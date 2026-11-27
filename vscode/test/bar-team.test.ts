import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { teamArgs } from "../src/bar/team";
import { removePushFiles } from "../src/bar/browse";
import { BAR_COMMANDS } from "../src/bar/types";

describe("team settings in the bar: arguments", () => {
  it("builds one aihub team call per command", () => {
    expect(teamArgs.show().args).toEqual(["team", "show", "--json", "--no-detect"]);
    expect(teamArgs.show({ repo: "repo-a", refresh: true }).args).toEqual(["team", "show", "--json", "--no-detect", "--repo", "repo-a", "--refresh"]);
    expect(teamArgs.schema().args).toEqual(["team", "validate", "--schema"]);
    expect(teamArgs.validate().args).toEqual(["team", "validate", "--json"]);
    expect(teamArgs.preview({ template: "pr", repo: "repo-b" }).args).toEqual(["team", "preview", "--json", "--template", "pr", "--repo", "repo-b"]);
    expect(teamArgs.edit({ template: "story" }).args).toEqual(["team", "edit", "--json", "--template", "story"]);
    expect(teamArgs.init({ mode: "pack", repo: "repo-c" }).args).toEqual(["team", "init", "--json", "--from-pack", "--repo", "repo-c"]);
    expect(teamArgs.init({ mode: "teamRepo", teamRepo: "orders/team-config", everywhere: true }).args).toEqual(["team", "init", "--json", "--team-repo", "orders/team-config", "--everywhere"]);
  });

  it("puts the edited text in a private file that is removed after", () => {
    const v = teamArgs.validate({ content: "version: 1\n" });
    const f = v.args[v.args.indexOf("--file") + 1];
    expect(readFileSync(f, "utf8")).toBe("version: 1\n");
    removePushFiles(v.dir);
    expect(existsSync(f)).toBe(false);
    const e = teamArgs.edit({ content: "x: 1\n", branch: "feature/bench-abc123-team", title: "Team: x", baseCommit: "1".repeat(40), story: 4711 });
    expect(e.args.slice(0, 3)).toEqual(["team", "edit", "--json"]);
    expect(e.args).toEqual(expect.arrayContaining(["--branch", "feature/bench-abc123-team", "--title", "Team: x", "--story", "4711"]));
    expect(e.args.join(" ")).not.toContain("x: 1");
    removePushFiles(e.dir);
  });

  it("refuses a call without its required arguments", () => {
    expect(() => teamArgs.preview({ template: "wiki" as never })).toThrow(/pr \| story \| bug \| commit/);
    expect(() => teamArgs.edit({ content: "x" })).toThrow(/branch/);
    expect(() => teamArgs.init({ mode: "teamRepo" })).toThrow(/teamRepo/);
    expect(() => teamArgs.init({} as never)).toThrow(/mode/);
  });

  it("contributes every team command, hidden from the palette", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
    const ids = ["teamShow", "teamSchema", "teamValidate", "teamPreview", "teamEdit", "teamInit"].map((k) => (BAR_COMMANDS as Record<string, string>)[k]);
    for (const id of ids) {
      expect(id).toMatch(/^aihub\.bar\.team/);
      expect(pkg.contributes.commands.some((c: { command: string }) => c.command === id)).toBe(true);
      expect(pkg.contributes.menus.commandPalette.some((c: { command: string; when: string }) => c.command === id && c.when === "false")).toBe(true);
    }
  });
});
