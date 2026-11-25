import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { divergenceKey, divergenceMessage, divergences, markDivergenceSeen, seenDivergence, type LinkedRow } from "../../cli/src/lib/setDivergence";
import { nextStoryBranch, openStoryArgs, storyBranchPerRepo, storyNumberOf, storyPickRows, storyRepoRows } from "../src/bar/storyModel";
import type { BranchRowJson } from "../src/storyModel";

const row = (repo: string, branch: string, o: Partial<BranchRowJson> = {}): BranchRowJson => ({ repo, branch, linked: "ado", status: "parked", local: true, pushed: true, ahead: 0, dirty: false, ...o });

describe("Open Story: which repositories are ticked", () => {
  const rows = [
    row("repo-a", "feature/4711-x", { status: "old" }),
    row("repo-a", "feature/4711-x-2", { status: "current" }),
    row("repo-b", "feature/4711-x", { lastActive: "2026-11-01" }),
    row("repo-b", "feature/4711-y", { lastActive: "2026-11-20" }),
    row("repo-c", "feature/4711-x", { linked: "ado", local: false, pushed: false }),
    row("repo-gone", "feature/4711-x"),
  ];
  const clones = [{ name: "repo-a", path: "/c/repo-a" }, { name: "repo-b", path: "/c/repo-b" }, { name: "repo-c", path: "/c/repo-c" }, { name: "repo-d", path: "/c/repo-d" }, { name: "REPO-A", path: "/other/REPO-A" }];

  it("one branch per repository: the star, else the latest; a branch that exists nowhere is not offered", () => {
    const per = storyBranchPerRepo(rows);
    expect(per.get("repo-a")?.branch).toBe("feature/4711-x-2");
    expect(per.get("repo-b")?.branch).toBe("feature/4711-y");
    expect(per.has("repo-c")).toBe(false);
  });

  it("a branch known only locally does not count when the story links others in Azure DevOps", () => {
    const per = storyBranchPerRepo([row("repo-a", "feature/4711-x", { linked: "ado" }), row("repo-b", "feature/4711-z", { linked: "local" })]);
    expect([...per.keys()]).toEqual(["repo-a"]);
    expect([...storyBranchPerRepo([row("repo-b", "feature/4711-z", { linked: "local" })]).keys()]).toEqual(["repo-b"]);
  });

  it("linked repositories ticked first, every other clone on this PC unticked, repositories not cloned named", () => {
    const { rows: out, notOnThisPc } = storyRepoRows(rows, clones);
    expect(out.map((r) => [r.repo, r.branch ?? "new", r.picked])).toEqual([["repo-a", "feature/4711-x-2", true], ["repo-b", "feature/4711-y", true], ["repo-c", "new", false], ["repo-d", "new", false]]);
    expect(notOnThisPc).toEqual(["repo-gone"]);
    expect(out[0].path).toBe("/c/repo-a");
  });

  it("the command: linked ones on their branch, the new ones on feature/<id>-<slug>, the set on the first linked branch, no window", () => {
    const { rows: out } = storyRepoRows(rows, clones);
    const args = openStoryArgs({ id: 4711, title: "Order export" }, out, "staging");
    expect(args).toEqual(["worktree", "open", "--repos", "repo-a,repo-b,repo-c,repo-d", "--branch", "feature/4711-x-2", "--branch-for", "repo-a=feature/4711-x-2,repo-b=feature/4711-y,repo-c=feature/4711-order-export,repo-d=feature/4711-order-export", "--story", "4711", "--from", "staging", "--window", "none"]);
    // nothing linked: every repository gets the new branch
    expect(openStoryArgs({ id: 4711, title: "Order export" }, [{ repo: "repo-d", path: "/c/repo-d", picked: true, onThisPc: true }])).toEqual(["worktree", "open", "--repos", "repo-d", "--branch", "feature/4711-order-export", "--branch-for", "repo-d=feature/4711-order-export", "--story", "4711", "--window", "none"]);
  });
});

describe("names and numbers", () => {
  it("the next branch of a story is numbered from 2 and never reuses a number", () => {
    const s = { id: 4711, title: "Order export" };
    expect(nextStoryBranch(s, [])).toBe("feature/4711-order-export-2");
    expect(nextStoryBranch(s, ["feature/4711-order-export"])).toBe("feature/4711-order-export-2");
    expect(nextStoryBranch(s, ["feature/4711-order-export", "feature/4711-order-export-2"])).toBe("feature/4711-order-export-3");
    expect(nextStoryBranch(s, ["feature/4711-order-export-2", "feature/4711-order-export-4"])).toBe("feature/4711-order-export-3");
  });

  it("a story number can be typed as 4711, #4711 or AB#4711", () => {
    expect([storyNumberOf("4711"), storyNumberOf(" #4711 "), storyNumberOf("ab#12"), storyNumberOf("order"), storyNumberOf("12 34")]).toEqual([4711, 4711, 12, undefined, undefined]);
  });

  it("the story list: fresh stories first, seen ones after, closed ones last", () => {
    const rows = storyPickRows(
      [{ id: 1, title: "Seen only", at: 1 }, { id: 2, title: "Old", state: "Closed", at: 1 }, { id: 3, title: "Both", at: 1 }],
      [{ id: 3, title: "Both v2", state: "Active" }, { id: 4, title: "Fresh", state: "Active" }],
    );
    expect(rows.map((r) => r.id)).toEqual([3, 4, 1, 2]);
    expect(rows[0].title).toBe("Both v2");
    expect(storyPickRows([{ id: 5, title: "Only seen", at: 1 }], undefined).map((r) => r.id)).toEqual([5]);
  });
});

describe("the story links another branch", () => {
  const set = [{ name: "repo-a", branch: "feature/4711-x-2" }, { name: "repo-b", branch: "feature/4711-x" }, { name: "repo-c", branch: "main" }];
  const rows: LinkedRow[] = [
    { repo: "repo-a", branch: "feature/4711-x", linked: "ado", status: "current" },
    { repo: "repo-a", branch: "feature/4711-old", linked: "both", status: "old" },
    { repo: "repo-b", branch: "feature/4711-x", linked: "both" },
    { repo: "repo-c", branch: "feature/4711-local", linked: "local" },
  ];

  it("only a repository whose set branch the story does not link, while it links another there", () => {
    expect(divergences(set, rows)).toEqual([{ repo: "repo-a", current: "feature/4711-x-2", linked: "feature/4711-x" }]);
  });

  it("a repository without any link in Azure DevOps is no divergence (a read-along repository)", () => {
    expect(divergences([{ name: "repo-c", branch: "main" }], rows)).toEqual([]);
    expect(divergences(set, [])).toEqual([]);
  });

  it("names the story, the repository and both branches; one key per divergence, told once", () => {
    const d = divergences(set, rows);
    expect(divergenceMessage(4711, d)).toBe("Story #4711 links another branch: repo-a is on feature/4711-x-2. The story links feature/4711-x.");
    expect(divergenceMessage(4711, [...d, { repo: "repo-b", current: "b1", linked: "b2" }])).toContain("repo-b is on b1 (the story links b2)");
    const dir = mkdtempSync(join(tmpdir(), "aihub-div-"));
    try {
      const env = { AIHUB_CONFIG_HOME: dir };
      const key = divergenceKey(4711, d);
      expect(seenDivergence(env, key)).toBe(false);
      markDivergenceSeen(env, key);
      markDivergenceSeen(env, key);
      expect(seenDivergence(env, key)).toBe(true);
      // another divergence (the set moved on) is a new one
      expect(seenDivergence(env, divergenceKey(4711, [{ repo: "repo-a", current: "feature/4711-x-3", linked: "feature/4711-x" }]))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
