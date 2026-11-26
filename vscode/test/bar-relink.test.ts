import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitRun } from "../src/bar/ownWindow";
import { relinkWorktree } from "../src/bar/relink";
import { sh, write } from "./gitHelpers";

describe("a source clone that was moved (persona 5)", () => {
  it("the worktree is linked to the clone again when its remote fits; another repository's clone is refused", async () => {
    const root = mkdtempSync(join(tmpdir(), "aihub-relink-"));
    const origin = join(root, "repo-a.git");
    mkdirSync(origin);
    sh(origin, "init", "--bare", "-b", "main");
    const source = join(root, "git", "repo-a");
    mkdirSync(join(root, "git"), { recursive: true });
    sh(join(root, "git"), "clone", origin, source);
    sh(source, "switch", "-c", "main");
    write(source, "x.txt", "1");
    sh(source, "add", "-A");
    sh(source, "commit", "-m", "init");
    sh(source, "push", "-u", "origin", "main");
    const set = join(root, "sets", "5-x");
    mkdirSync(set, { recursive: true });
    const wt = join(set, "repo-a");
    sh(source, "worktree", "add", "-b", "feature/5-x", wt);
    writeFileSync(join(set, ".aihub-set.json"), JSON.stringify({ story: 5, branch: "feature/5-x", repos: [{ name: "repo-a", source, path: wt }] }));
    // the clone is moved: the worktree's .git file points at a folder that is gone
    const moved = join(root, "elders", "repo-a");
    mkdirSync(join(root, "elders"), { recursive: true });
    renameSync(source, moved);
    expect(() => sh(wt, "status")).toThrow();
    // another repository: refused, nothing changed
    const bOrigin = join(root, "repo-b.git");
    mkdirSync(bOrigin);
    sh(bOrigin, "init", "--bare", "-b", "main");
    const b = join(root, "git", "repo-b");
    sh(join(root, "git"), "clone", bOrigin, b);
    const refused = await relinkWorktree(gitRun, { setFolder: set, worktree: wt, repo: "repo-a", newSource: b });
    expect(refused.problem).toContain("not of repo-a");
    expect(JSON.parse(readFileSync(join(set, ".aihub-set.json"), "utf8")).repos[0].source).toBe(source);
    // the right clone: repaired, the set file points at it, git works in the worktree again
    expect(await relinkWorktree(gitRun, { setFolder: set, worktree: wt, repo: "repo-a", newSource: moved })).toEqual({});
    expect(sh(wt, "branch", "--show-current").trim()).toBe("feature/5-x");
    expect(JSON.parse(readFileSync(join(set, ".aihub-set.json"), "utf8")).repos[0].source).toBe(moved);
  });
});
