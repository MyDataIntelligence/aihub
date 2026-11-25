import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderBody, renderError } from "../src/html";
import { buildModel } from "../src/model";
import { popupFor } from "../src/popups";
import { branchItems, branchesArgs, groupItems, openArgs, openTarget, openWays, preferredBranch, prItems, setChip, stepTitle, summarizeOpen, type OpenResultJson } from "../src/repoSetModel";
import { fx, here } from "./helpers";

describe("the first chip of the bar", () => {
  const m = buildModel({ status: fx("status") });

  it("is the visible 'Worktree Sets' chip, before the main chat button, and it is not a chat action", () => {
    const h = renderBody(m, 2000);
    const chip = h.indexOf('data-id="reposet"');
    expect(chip).toBeGreaterThan(-1);
    expect(chip).toBeLessThan(h.indexOf('data-act="chat"'));
    expect(h).toContain("Worktree Sets");
    expect(h).toContain("codicon-repo-forked");
  });

  it("is also there when the status cannot be read (a local action, no Azure DevOps remote needed)", () => {
    const h = renderError({ kind: "failed", message: "remote is not an Azure DevOps remote" });
    expect(h).toContain('data-id="reposet"');
    expect(h.indexOf('data-id="reposet"')).toBeLessThan(h.indexOf("not an Azure DevOps"));
  });

  it("shows 'Set: <group> · 3/3 op <branch>' only in a window that is a set", () => {
    expect(renderBody(m, 2000)).not.toContain("Set: ");
    const inSet = buildModel({ status: { ...fx("status"), set: { story: 0, group: "pipeline", branch: "feature/x", total: 3, repos: ["a", "b", "c"] } } });
    expect(renderBody(inSet, 2000)).toContain("Set: pipeline · 3/3 op feature/x");
    expect(setChip({ story: 5, branch: "feature/5-y", repos: ["a", "b"], total: 3 })?.label).toBe("Set: story 5 · 2/3 op feature/5-y");
    expect(popupFor("set", inSet).items.map((i) => i.label)).toContain("Open repositories on another branch...");
  });
});

describe("the quick-pick flow", () => {
  it("step 1 lists saved groups first and 'Choose repositories...' last", () => {
    const items = groupItems([{ name: "pipeline", repos: [{ name: "a", path: "x" }, { name: "b", path: "y" }], missing: ["b"] }]);
    expect(items[0].label).toContain("pipeline");
    expect(items[0].detail).toContain("not on this PC: b");
    expect(items.at(-1)?.label).toContain("Choose repositories");
  });

  it("step 2 says where a branch exists and where it will be created", () => {
    const items = branchItems(
      [
        { name: "feature/shared", in: ["a", "b"], missing: ["c"] },
        { name: "main", in: ["a", "b", "c"], missing: [] },
      ],
      3,
    );
    expect(items.slice(0, 3).map((i) => i.value?.kind)).toEqual(["new-story", "pr", "typed"]);
    const shared = items.find((i) => i.label.includes("feature/shared"))!;
    expect(shared.description).toBe("exists in 2/3");
    expect(shared.detail).toBe("will be created in c from its target branch");
    expect(items.find((i) => i.label.includes("main"))?.description).toBe("exists in 3/3");
    expect(prItems([{ id: 42, title: "Search", repo: "a", source: "feature/42-search", target: "staging" }])[0].detail).toBe("feature/42-search -> staging");
  });

  it("step 2 puts the current branch of the project on top, focused, so it is one Enter", () => {
    const rows = [
      { name: "main", in: ["a", "b", "c"], missing: [] },
      { name: "develop", in: ["a", "b", "c"], missing: [] },
      { name: "feature/7", in: ["a", "b"], missing: ["c"] },
    ];
    // the window's own repository wins; else the branch most repositories are on
    expect(preferredBranch(rows, { a: "feature/7", b: "develop", c: "develop" }, "a")).toBe("feature/7");
    expect(preferredBranch(rows, { a: "feature/7", b: "develop", c: "develop" }, "elsewhere")).toBe("develop");
    expect(preferredBranch(rows, {}, "a")).toBeUndefined();
    // a detached HEAD (empty) is no branch to offer
    expect(preferredBranch(rows, { a: "" }, "a")).toBeUndefined();
    const items = branchItems(rows, 3, "develop");
    expect(items[0]).toMatchObject({ value: { kind: "existing", branch: "develop" }, description: "current branch · exists in 3/3" });
    expect(items.filter((i) => i.value?.kind === "existing" && i.value.branch === "develop")).toHaveLength(1);
    expect(items.slice(1, 4).map((i) => i.value?.kind)).toEqual(["new-story", "pr", "typed"]);
  });

  it("every step says 'stap n/3' and what was already chosen", () => {
    expect(stepTitle(1, [])).toBe("Open Repo Set · stap 1/3");
    expect(stepTitle(2, ["pipeline"])).toBe("Open Repo Set · stap 2/3 · pipeline");
    expect(stepTitle(3, ["pipeline", "feature/7"])).toBe("Open Repo Set · stap 3/3 · pipeline · feature/7");
  });

  it("step 3 is one choice of how and where, worktrees first", () => {
    const ways = openWays();
    expect(ways[0].label).toContain("recommended");
    expect(ways.map((w) => w.value)).toEqual([
      { mode: "worktree", window: "new" },
      { mode: "worktree", window: "this" },
      { mode: "switch", window: "this" },
      { mode: "switch", window: "new" },
    ]);
  });

  it("builds exactly the CLI command lines; the extension opens the window itself (--window none)", () => {
    expect(openArgs({ group: "pipeline", branch: "feature/x", mode: "worktree" })).toEqual(["worktree", "open", "--group", "pipeline", "--branch", "feature/x", "--mode", "worktree", "--window", "none"]);
    expect(openArgs({ repos: ["/r/a", "/r/b"], branch: "feature/7", from: "staging", mode: "switch" })).toEqual(["worktree", "open", "--repos", "/r/a,/r/b", "--branch", "feature/7", "--mode", "switch", "--window", "none", "--from", "staging"]);
    expect(branchesArgs({ group: "pipeline" })).toEqual(["worktree", "branches", "--group", "pipeline"]);
  });

  it("opens the workspace file in this window or a new one, and says so when there is nothing to open", () => {
    const res: OpenResultJson = { branch: "b", mode: "worktree", folder: "/s/b", workspace: "/s/b/pipeline.code-workspace", opened: false, repos: [{ repo: "a", ok: true, state: "existing", branch: "b", note: "worktree", path: "/s/b/a" }] };
    expect(openTarget(res, "this")).toEqual({ file: "/s/b/pipeline.code-workspace", options: { forceReuseWindow: true } });
    expect(openTarget(res, "new")).toEqual({ file: "/s/b/pipeline.code-workspace", options: { forceNewWindow: true } });
    expect(openTarget({ ...res, workspace: undefined, repos: [{ ...res.repos[0], ok: false }] }, "this")).toEqual({ error: "No repository could be opened on b, so the window was not changed." });
  });

  it("opens nothing when the CLI switched repositories inside the set this window already shows", () => {
    const res: OpenResultJson = { branch: "b", mode: "switch", folder: "/s/x", workspace: "/s/x/story-1.code-workspace", opened: false, stays: "the window stays as it is: 3 repositories, a now on b", repos: [{ repo: "a", ok: true, state: "switched", branch: "b", note: "switched", path: "/s/x/a" }] };
    expect(openTarget(res, "new")).toEqual({ stays: "the window stays as it is: 3 repositories, a now on b" });
    expect(openTarget(res, "this")).toEqual({ stays: "the window stays as it is: 3 repositories, a now on b" });
  });

  it("summarizes the result: all open, or which repositories need attention", () => {
    const ok: OpenResultJson = { branch: "b", mode: "worktree", folder: "f", workspace: "w", opened: true, repos: [{ repo: "a", ok: true, state: "existing", branch: "b", note: "worktree" }] };
    expect(summarizeOpen(ok)).toMatchObject({ ok: true, failed: 0 });
    const bad: OpenResultJson = { ...ok, repos: [...ok.repos, { repo: "c", ok: false, state: "skipped", branch: "b", note: "uncommitted changes" }] };
    const s = summarizeOpen(bad);
    expect(s.ok).toBe(false);
    expect(s.title).toContain("1 of 2 repositories are open on b; 1 need attention");
    expect(s.lines[1]).toBe("FAIL  c: skipped - uncommitted changes");
  });
});

describe("package.json", () => {
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
  it("has the commands and the Worktree Sets button per group", () => {
    const declared = pkg.contributes.commands.map((c: { command: string }) => c.command);
    expect(declared).toContain("aihub.reposet.open");
    expect(declared).toContain("aihub.reposet.openGroup");
    const menu = pkg.contributes.menus["view/item/context"].filter((x: { command: string }) => x.command === "aihub.reposet.openGroup");
    expect(menu.some((x: { when: string }) => x.when.includes("aihubGroup"))).toBe(true);
  });
});

describe("the status bar item and the other entries", () => {
  it("shows the entry, or the set's branch and repo count with a per-repo tooltip", async () => {
    const { reposetStatus } = await import("../src/repoSetModel");
    expect(reposetStatus(null).text).toBe("$(repo-forked) Worktree Sets");
    const s = reposetStatus({ story: 0, group: "pipeline", branch: "feature/x", total: 3, repos: ["a", "b", "c"] });
    expect(s.text).toBe("$(repo-forked) feature/x · 3 repos");
    expect(s.tooltip).toContain("- b: feature/x");
  });

  it("names a repository's own branch when it is not the set's (repos[].branch)", async () => {
    const { reposetStatus, setFromMeta } = await import("../src/repoSetModel");
    const m = setFromMeta({ story: 0, branch: "feature/x", repos: [{ name: "a", path: "/s/a" }, { name: "b", path: "/s/b", branch: "feature/y" }] }, () => true);
    expect(m).toMatchObject({ repos: ["a", "b"], branches: { b: "feature/y" } });
    const s = reposetStatus(m);
    expect(s.tooltip).toContain("- a: feature/x");
    expect(s.tooltip).toContain("- b: feature/y");
  });

  it("is in the Source Control title, the editor title and has a keybinding", () => {
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
    const m = pkg.contributes.menus;
    expect(m["scm/title"].some((x: { command?: string }) => x.command === "aihub.reposet.open")).toBe(true);
    expect(m["editor/title"].some((x: { command?: string; group: string }) => x.command === "aihub.reposet.open" && x.group.startsWith("navigation"))).toBe(true);
    expect(pkg.contributes.keybindings.some((k: { command: string; key: string }) => k.command === "aihub.reposet.open" && k.key === "ctrl+alt+b")).toBe(true);
  });
});

describe("a branch that already has a worktree elsewhere", () => {
  it("reads the CLI's question and turns a choice into the same arguments as its ready command", async () => {
    const { needsChoiceOf, choiceArgs } = await import("../src/repoSetModel");
    const q = {
      question: "worktree for feature/x already exists: /w/a (2 uncommitted files). choose: ...",
      existing: [{ repo: "repo-a", branch: "feature/x", path: "/w/a", target: "/s/a", state: "2 uncommitted files", dirty: 2, unpushed: 0 }],
      choices: [
        { choice: "move", label: "move it into this set (recommended; work and branch go along)", command: "aihub worktree open --repos repo-a --branch feature/x --existing move" },
        { choice: "reuse", label: "reuse it where it is", command: "aihub worktree open --repos repo-a --branch feature/x --existing reuse" },
        { choice: "recreate", label: "recreate it", command: "aihub worktree open --repos repo-a --branch feature/x --existing recreate --discard-local-work" },
      ],
    };
    const parsed = needsChoiceOf(JSON.stringify({ needsChoice: q }));
    expect(parsed?.choices.map((c) => c.choice)).toEqual(["move", "reuse", "recreate"]);
    expect(choiceArgs(parsed!.choices[0])).toEqual(["--existing", "move"]);
    expect(choiceArgs(parsed!.choices[2])).toEqual(["--existing", "recreate", "--discard-local-work"]);
    expect(needsChoiceOf(JSON.stringify({ branch: "b", repos: [] }))).toBeUndefined();
  });
});
