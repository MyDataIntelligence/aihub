import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTIONS } from "../src/actions";
import { chatOpenArgs, copilotAgentFiles, copilotAgentInstalled } from "../src/agents";
import { here } from "./helpers";

const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
const c = pkg.contributes;

describe("package.json contributions", () => {
  const declared = new Set<string>(c.commands.map((x: { command: string }) => x.command));

  it("only menus commands that are declared", () => {
    for (const [menu, items] of Object.entries<{ command?: string }[]>(c.menus)) for (const it of items) if (it.command) expect(declared.has(it.command), `${menu}: ${it.command}`).toBe(true);
  });

  it("only references submenus that exist, and has the same four Branch actions as before plus switch", () => {
    const ids = new Set(c.submenus.map((s: { id: string }) => s.id));
    for (const items of Object.values<{ submenu?: string }[]>(c.menus)) for (const it of items) if (it.submenu) expect(ids.has(it.submenu)).toBe(true);
    expect(c.menus["aihub.cm.Branch"].map((x: { command: string }) => x.command)).toEqual(["aihub.git.resetToRef", "aihub.git.checkMergeConflicts", "aihub.git.cleanUpUnrelated", "aihub.git.squash", "aihub.git.switchBranch"]);
  });

  it("puts the Branch menu on the explorer and the SCM menus like the old extension", () => {
    expect(c.menus["explorer/context"][0].submenu).toBe("aihub.cm.Group");
    expect(c.menus["aihub.cm.Group"][0].submenu).toBe("aihub.cm.Branch");
    for (const m of ["scm/title", "scm/resourceState/context", "scm/resourceGroup/context"]) expect(c.menus[m][0].submenu).toBe("aihub.cm.Branch");
  });

  it("has the worktree set commands of the old Worktree Sets view", () => {
    for (const id of ["create", "openSet", "openSetHere", "addRepos", "syncSet", "pushSet", "createPullRequests", "removeSet", "removeRepoFromSet", "cleanup", "revealSet", "saveGroup", "deleteGroup", "refresh"]) expect(declared.has(`aihub.worktrees.${id}`)).toBe(true);
  });
});

describe("chat actions in the menus", () => {
  it("has a command per action, and every action is in a submenu or the bar menu", () => {
    const declared = new Set<string>(c.commands.map((x: { command: string }) => x.command));
    const inMenus = new Set<string>(Object.values<{ command?: string }[]>(c.menus).flat().map((x) => x.command ?? ""));
    for (const a of ACTIONS) {
      expect(declared.has(`aihub.chat.${a.id}`), a.id).toBe(true);
      if (a.id !== "fabric-failures" && a.id !== "pipeline-fix") expect(inMenus.has(`aihub.chat.${a.id}`) || a.id === "commit", a.id).toBe(true);
    }
  });

  it("keeps the old submenu names under AI Context Hub", () => {
    expect(c.submenus.filter((s: { id: string }) => /DevOps|\.Pr$|Pipeline|Wiki|Robot/.test(s.id)).map((s: { label: string }) => s.label).sort()).toEqual(["DevOps", "Pipeline", "Project wiki", "Pull request", "Robot tests"]);
  });
});

describe("chat agent", () => {
  it("selects the aihub agent when it is installed, else the default agent mode", () => {
    expect(chatOpenArgs("/pr", { agentName: "aihub", agentInstalled: true, agentMode: true })).toEqual({ query: "/pr", isPartialQuery: true, mode: "aihub" });
    expect(chatOpenArgs("/pr", { agentName: "aihub", agentInstalled: false, agentMode: true })).toEqual({ query: "/pr", isPartialQuery: true, mode: "agent" });
    expect(chatOpenArgs("/pr", { agentName: "aihub", agentInstalled: false, agentMode: false })).toEqual({ query: "/pr", isPartialQuery: true });
  });

  it("looks for the agent file in the repo and in COPILOT_HOME", () => {
    const files = copilotAgentFiles("aihub", "/r", { COPILOT_HOME: "/h" });
    expect(files[0]).toMatch(/\.github[\\/]agents[\\/]aihub\.agent\.md$/);
    expect(files[1]).toMatch(/[\\/]h[\\/]agents[\\/]aihub\.agent\.md$/);
    expect(copilotAgentInstalled("aihub", "/r", { COPILOT_HOME: "/h" }, (p) => p.includes(".github"))).toBe(true);
    expect(copilotAgentInstalled("aihub", undefined, { COPILOT_HOME: "/h" }, () => false)).toBe(false);
  });
});
