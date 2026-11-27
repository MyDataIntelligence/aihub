import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSetFile } from "../../cli/src/lib/setFile";
import { openFacts, setWorkspaceDirSource } from "../src/bar/engine";
import { addable, branchChoices, singleToSetArgs, validBranchName } from "../src/bar/singleToSet";

const here = { name: "repo-a", path: "C:\\w\\repo-a", branch: "feature/7-x" };

describe("Add Repository… in the window of a single repository: the window becomes a set", () => {
  it("every other repository on this PC can be added; not the one of this window (by folder or name)", () => {
    const all = [here, { name: "repo-b", path: "C:\\w\\repo-b", branch: "main" }, { name: "REPO-A", path: "C:\\copy\\repo-a", branch: "dev" }, { name: "repo-c", path: "C:\\w\\repo-c\\", branch: "staging" }];
    expect(addable(all, here).map((r) => r.name)).toEqual(["repo-b", "repo-c"]);
  });

  it("the branch choices: the window's branch first (one branch for the set), then its target, then a new one; each gives a worktree", () => {
    const c = branchChoices("feature/7-x", { name: "repo-b", path: "C:\\w\\repo-b", branch: "hotfix/1" }, "staging");
    expect(c.map((x) => [x.kind, x.branch])).toEqual([["same", "feature/7-x"], ["target", "staging"], ["new", undefined]]);
    expect(branchChoices("staging", { name: "b", path: "p", branch: "staging" }, "staging").map((x) => x.kind)).toEqual(["same", "new"]);
  });

  it("one aihub worktree open: the added repositories first (inside the set folder), this repository last on its own branch, the story when chosen", () => {
    expect(singleToSetArgs(here, [{ name: "repo-b", path: "C:\\w\\repo-b", branch: "feature/7-x" }, { name: "repo-c", path: "C:\\w\\repo-c", branch: "staging" }], 7)).toEqual([
      "worktree", "open", "--repos", "C:\\w\\repo-b,C:\\w\\repo-c,C:\\w\\repo-a", "--branch", "feature/7-x", "--branch-for", "repo-b=feature/7-x,repo-c=staging,repo-a=feature/7-x", "--story", "7", "--window", "none", "--json",
    ]);
    expect(singleToSetArgs(here, [{ name: "repo-b", path: "C:\\w\\repo-b", branch: "x" }])).not.toContain("--story");
  });

  it("a new branch name is checked before anything runs", () => {
    for (const ok of ["feature/7-y", "bugfix/a_b"]) expect(validBranchName(ok)).toBe(true);
    for (const bad of ["", " ", "a b", "x..y", "-x", "x/", "x.", "a:b", "a~1"]) expect(validBranchName(bad)).toBe(false);
  });

  it("a set whose first folder lies outside the set folder is still found, from the set file next to the workspace file", () => {
    const root = mkdtempSync(join(tmpdir(), "aihub-single-set-"));
    const outside = join(root, "git", "repo-a");
    const setFolder = join(root, "git", "worktrees", "7-x");
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(setFolder, "repo-b"), { recursive: true });
    writeSetFile(setFolder, "aihub", { story: 7, branch: "feature/7-x", repos: [{ name: "repo-a", source: outside, path: outside }, { name: "repo-b", source: join(root, "git", "repo-b"), path: join(setFolder, "repo-b") }] } as never);
    setWorkspaceDirSource(() => undefined);
    expect(openFacts(outside).set).toBeUndefined();
    setWorkspaceDirSource(() => setFolder);
    const facts = openFacts(outside);
    expect(facts.set?.folder).toBe(setFolder);
    expect(facts.set?.repos.map((r) => r.name)).toEqual(["repo-a", "repo-b"]);
    setWorkspaceDirSource(() => undefined);
  });

  it("the command: no set in the window goes to the single-repository flow; the set opens in this window only after Undo is saved", () => {
    const ui = readFileSync(join(__dirname, "../src/bar/storyUi.ts"), "utf8");
    expect(ui).toMatch(/if \(!set\) return addToSingleRepository\(h\);/);
    expect(ui).toContain('title: "Link to a story?"');
    expect(ui).toMatch(/const made = await withUndo\(/);
    expect(ui).toMatch(/if \(made\) await showOpened\(made, "this", h\.log/);
    expect(readFileSync(join(__dirname, "../src/bar/register.ts"), "utf8")).toMatch(/setWorkspaceDirSource\(\(\) => \{/);
  });
});
