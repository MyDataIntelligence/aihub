import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkStoryAction, e2eArgs, needsStart, PENDING_FILE, promptSaveCall, removeDir, runStateOf, setOf, slashCommand, STORY_ACTIONS, takePending, writePending } from "../src/bar/e2e";
import { BAR_COMMANDS } from "../src/bar/types";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { contributes: { commands: { command: string }[] } };

describe("Run End to End in the bar: arguments", () => {
  it("one aihub call per read or write", () => {
    expect(e2eArgs.prompt({ id: 4711, action: "/story-run", project: "test-project" })).toEqual(["prompt", "render", "story-run", "--id", "4711", "--json", "--project", "test-project"]);
    expect(e2eArgs.runState({ id: "4711" })).toEqual(["story", "progress", "--id", "4711", "--json"]);
    expect(e2eArgs.criteriaStatus({ id: 4711 })).toEqual(["criteria", "status", "--id", "4711", "--json"]);
    expect(e2eArgs.criteriaApply({ id: 4711, rev: 9, take: [1, "3"] })).toEqual(["criteria", "apply", "--id", "4711", "--rev", "9", "--take", "1,3", "--json"]);
    expect(e2eArgs.open({ id: 4711 })).toEqual(["story", "open", "--id", "4711", "--window", "none", "--existing", "reuse", "--json"]);
    expect(e2eArgs.start({ id: 4711, repos: ["repo-a", "repo-b"] })).toEqual(["stories", "start", "--id", "4711", "--open", "none", "--repos", "repo-a,repo-b"]);
    expect(e2eArgs.yolo("C:/sets/4711", true)).toEqual(["story", "yolo", "--on", "--folder", "C:/sets/4711", "--json"]);
    expect(slashCommand("bug-run", 12)).toBe("/bug-run 12");
    expect(e2eArgs.options(4711, "story-run", { planFirst: true, yolo: true, fabric: false, setActive: true } as never)).toEqual(["story", "progress", "--id", "4711", "--action", "story-run", "--options", "planFirst=true,fabric=false,setActive=true", "--json"]);
    expect(e2eArgs.options(4711, "story-pr", { draft: true })).toEqual(["story", "progress", "--id", "4711", "--action", "story-pr", "--options", "draft=true", "--json"]);
    expect(e2eArgs.options(4711, "story-explain", {})).toEqual(["story", "progress", "--id", "4711", "--action", "story-explain", "--json"]);
    expect(e2eArgs.activate(4711, { project: "test-project" })).toEqual(["stories", "activate", "--id", "4711", "--project", "test-project"]);
    expect(e2eArgs.stop(4711)).toEqual(["story", "progress", "--id", "4711", "--stop", "--json"]);
    expect(STORY_ACTIONS).toEqual(expect.arrayContaining(["story-pr-review", "bug-run"]));
  });

  it("refuses an unknown action, a missing id or an empty apply", () => {
    expect(() => checkStoryAction("story-deploy")).toThrow(/unknown action/);
    expect(STORY_ACTIONS).toContain("story-test-fabric");
    expect(() => e2eArgs.prompt({ action: "story-run" })).toThrow(/id is needed/);
    expect(() => e2eArgs.criteriaApply({ id: 1, rev: 2, take: [] })).toThrow(/take/);
  });

  it("Edit Prompt: the text in a private file, removed after", () => {
    const { args, dir } = promptSaveCall({ id: 4711, action: "story-run", text: "# Mijn prompt" });
    expect(args.slice(0, 5)).toEqual(["prompt", "save", "story-run", "--id", "4711"]);
    expect(readFileSync(args[args.indexOf("--text-file") + 1], "utf8")).toBe("# Mijn prompt");
    removeDir(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it("reads the set from story open and stories start; a story without branches is started first", () => {
    expect(setOf({ folder: "C:/w/4711-x", workspace: "C:/w/4711-x/story-4711.code-workspace" })).toEqual({ folder: "C:/w/4711-x", workspace: "C:/w/4711-x/story-4711.code-workspace" });
    expect(setOf({ story: 4711, set: { folder: "C:/w/4711-x" } })).toEqual({ folder: "C:/w/4711-x" });
    expect(setOf({})).toBeUndefined();
    expect(needsStart("aihub: story 4711 has no branches yet; link one with: ...")).toBe(true);
  });

  it("the run state says when the agent waits for the user, never guessed", () => {
    expect(runStateOf({ id: 1, running: true, waiting: true, waitingFor: "plan", planFile: "C:/p/plan.md" })).toMatchObject({ waiting: true, waitingFor: "plan", planFile: "C:/p/plan.md" });
    const st = runStateOf({ id: 1, running: true, waitingFor: "input" });
    expect(st.waiting).toBe(false);
    expect("waitingFor" in st).toBe(false);
  });

  it("the run state for the badge", () => {
    expect(runStateOf({ id: 4711, running: true, step: 2, total: 4, label: "Bouwen", stepsView: [{ label: "Plan", state: "done" }], updatedAt: "t", stateFile: "f" })).toEqual({ id: 4711, running: true, step: 2, total: 4, label: "Bouwen", steps: [{ label: "Plan", state: "done" }], updatedAt: "t", stateFile: "f", waiting: false });
  });
});

describe("Run End to End: a set that opens in another window", () => {
  it("the pending action is taken once, only while it is fresh and well formed", () => {
    const dir = mkdtempSync(join(tmpdir(), "aihub-set-"));
    writePending(dir, { id: 4711, action: "story-run", command: "/story-run 4711", at: 1000 });
    expect(takePending(dir, 1000 + 60_000)).toMatchObject({ command: "/story-run 4711" });
    expect(existsSync(join(dir, PENDING_FILE))).toBe(false);
    expect(takePending(dir, 0)).toBeUndefined();
    writePending(dir, { id: 4711, action: "story-run", command: "/story-run 4711", at: 0 });
    expect(takePending(dir, 3 * 60_000)).toBeUndefined();
    writeFileSync(join(dir, PENDING_FILE), JSON.stringify({ id: 1, action: "story-run", command: "rm -rf / ; /story-run 1", at: 0 }));
    expect(takePending(dir, 0)).toBeUndefined();
    expect(takePending(undefined, 0)).toBeUndefined();
  });

  it("every command is in BAR_COMMANDS and contributed", () => {
    const contributed = new Set(pkg.contributes.commands.map((c) => c.command));
    for (const k of ["storyAction", "storyPrompt", "storyPromptSave", "storyPromptReset", "storyPrompts", "storyRunState", "criteriaStatus", "criteriaProposal", "criteriaApply"] as const) {
      expect(BAR_COMMANDS[k]).toBe(`aihub.bar.${k}`);
      expect(contributed.has(BAR_COMMANDS[k])).toBe(true);
    }
  });
});
