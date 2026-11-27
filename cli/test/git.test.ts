import { describe, expect, it } from "vitest";
import { commitsSince, currentBranch, mergeBase, originDefaultBranch, pushIfNeeded, remoteUrl, showFile, workItemFromBranch } from "../src/lib/git.js";
import { ADO_URL, makeRepo, sh, write } from "./helpers.js";

describe("git helpers", () => {
  it("reads the raw remote url and the default branch", () => {
    const { dir } = makeRepo();
    expect(remoteUrl(dir)).toBe(ADO_URL);
    expect(originDefaultBranch(dir)).toBe("main");
  });

  it("finds the merge-base and lists commits oldest first", () => {
    const { dir } = makeRepo();
    sh(dir, ["checkout", "-b", "feature/1234-zoeken"]);
    write(dir, "a.txt", "1");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "feat: eerste (ë)"]);
    write(dir, "b.txt", "2");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "feat: tweede"]);
    // main moves on after the branch point
    sh(dir, ["checkout", "main"]);
    write(dir, "c.txt", "3");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "main moves"]);
    sh(dir, ["push", "origin", "main"]);
    sh(dir, ["checkout", "feature/1234-zoeken"]);

    expect(currentBranch(dir)).toBe("feature/1234-zoeken");
    const base = mergeBase(dir, "main");
    expect(base).toBe(sh(dir, ["rev-parse", "main~1"]));
    expect(commitsSince(dir, base).map((c) => c.subject)).toEqual(["feat: eerste (ë)", "feat: tweede"]);
  });

  it("pushes only when origin lacks the commit", () => {
    const { dir, bare } = makeRepo();
    sh(dir, ["checkout", "-b", "feature/9-x"]);
    write(dir, "a.txt", "1");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "x"]);
    expect(pushIfNeeded(dir, "feature/9-x")).toBe(true);
    expect(sh(bare, ["rev-parse", "feature/9-x"])).toBe(sh(dir, ["rev-parse", "HEAD"]));
    expect(pushIfNeeded(dir, "feature/9-x")).toBe(false);
    write(dir, "b.txt", "2");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "y"]);
    expect(pushIfNeeded(dir, "feature/9-x")).toBe(true);
  });

  it("a branch already on origin but tracking its base gets origin/<branch> as upstream, so it no longer shows 1 to push", () => {
    // the persona case: feature/3749- cut from origin/main (tracking it), pushed earlier, then Create Pull Requests
    const { dir } = makeRepo();
    sh(dir, ["checkout", "-b", "feature/3749-", "--track", "origin/main"]);
    write(dir, "a.txt", "1");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "x"]);
    sh(dir, ["push", "origin", "HEAD:refs/heads/feature/3749-"]);
    expect(sh(dir, ["rev-parse", "--abbrev-ref", "@{u}"])).toBe("origin/main");
    expect(pushIfNeeded(dir, "feature/3749-")).toBe(false);
    expect(sh(dir, ["rev-parse", "--abbrev-ref", "@{u}"])).toBe("origin/feature/3749-");
    expect(sh(dir, ["rev-list", "--count", "@{u}..HEAD"])).toBe("0");
    // the right upstream already: nothing is run again
    expect(pushIfNeeded(dir, "feature/3749-")).toBe(false);
  });

  it("shows a file at origin/<branch>", () => {
    const { dir } = makeRepo();
    expect(showFile(dir, "main", "README.md")).toBe("x\n");
    expect(showFile(dir, "main", "missing.md")).toBeUndefined();
    expect(showFile(dir, "nobranch", "README.md")).toBeUndefined();
  });

  it("takes the work item from the branch name", () => {
    expect(workItemFromBranch("feature/1234-zoeken")).toBe(1234);
    expect(workItemFromBranch("bugfix/77_fix")).toBe(77);
    expect(workItemFromBranch("1234-x")).toBe(1234);
    expect(workItemFromBranch("feature/zoeken")).toBeUndefined();
    expect(workItemFromBranch("release/2.0")).toBeUndefined();
  });
});
