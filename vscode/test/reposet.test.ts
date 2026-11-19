import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderBody, renderError } from "../src/html";
import { buildModel } from "../src/model";
import { popupFor } from "../src/popups";
import { branchItems, branchesArgs, groupItems, howItems, openArgs, prItems, setChip, summarizeOpen, type OpenResultJson } from "../src/repoSetModel";
import { fx, here } from "./helpers";

describe("the first chip of the bar", () => {
  const m = buildModel({ status: fx("status") });

  it("is the visible 'Repos op branch openen' chip, before the main chat button, and it is not a chat action", () => {
    const h = renderBody(m, 2000);
    const chip = h.indexOf('data-id="reposet"');
    expect(chip).toBeGreaterThan(-1);
    expect(chip).toBeLessThan(h.indexOf('data-act="chat"'));
    expect(h).toContain("Repos op branch openen");
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

  it("step 3 recommends worktrees", () => {
    expect(howItems()[0].label).toContain("recommended");
    expect(howItems().map((h) => h.value)).toEqual(["worktree", "switch"]);
  });

  it("builds exactly the CLI command lines", () => {
    expect(openArgs({ group: "pipeline", branch: "feature/x", mode: "worktree", window: "new" })).toEqual(["worktree", "open", "--group", "pipeline", "--branch", "feature/x", "--mode", "worktree", "--window", "new"]);
    expect(openArgs({ repos: ["/r/a", "/r/b"], branch: "feature/7", from: "staging", mode: "switch", window: "this" })).toEqual(["worktree", "open", "--repos", "/r/a,/r/b", "--branch", "feature/7", "--mode", "switch", "--window", "this", "--from", "staging"]);
    expect(branchesArgs({ group: "pipeline" })).toEqual(["worktree", "branches", "--group", "pipeline"]);
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
    expect(reposetStatus(null).text).toBe("$(repo-forked) Repos op branch openen");
    const s = reposetStatus({ story: 0, group: "pipeline", branch: "feature/x", total: 3, repos: ["a", "b", "c"] });
    expect(s.text).toBe("$(repo-forked) feature/x · 3 repos");
    expect(s.tooltip).toContain("- b: feature/x");
  });

  it("is in the Source Control title, the editor title and has a keybinding", () => {
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
    const m = pkg.contributes.menus;
    expect(m["scm/title"].some((x: { command?: string }) => x.command === "aihub.reposet.open")).toBe(true);
    expect(m["editor/title"].some((x: { command?: string; group: string }) => x.command === "aihub.reposet.open" && x.group.startsWith("navigation"))).toBe(true);
    expect(pkg.contributes.keybindings.some((k: { command: string; key: string }) => k.command === "aihub.reposet.open" && k.key === "ctrl+alt+b")).toBe(true);
  });
});
