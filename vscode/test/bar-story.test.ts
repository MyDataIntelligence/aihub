import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { divergenceKey, divergenceMessage, divergences, markDivergenceSeen, seenDivergence, type LinkedRow } from "../../cli/src/lib/setDivergence";
import { nextStoryBranch, openStoryArgs, rowDescription, storyBranchCandidates, storyBranchPerRepo, storyNumberOf, storyPickRows, storyRepoRows } from "../src/bar/storyModel";
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

  it("a branch known only locally is a candidate: linked in one repository, local only in another", () => {
    const per = storyBranchCandidates([row("repo-a", "feature/4711-x", { linked: "ado" }), row("repo-b", "feature/4711-z", { linked: "local", pushed: false })]);
    expect([...per.keys()]).toEqual(["repo-a", "repo-b"]);
    expect(per.get("repo-a")).toMatchObject({ linked: true, others: 0 });
    expect(per.get("repo-b")).toMatchObject({ linked: false, others: 0 });
    expect(per.get("repo-b")?.row.branch).toBe("feature/4711-z");
  });

  it("two candidates in one repository: linked in Azure DevOps first, then the star, then the most recently active; the rest is counted", () => {
    const per = storyBranchCandidates([
      row("repo-a", "feature/4711-a", { linked: "local", status: "current", pushed: false }),
      row("repo-a", "feature/4711-b", { linked: "ado", status: "parked", lastActive: "2026-11-01" }),
      row("repo-a", "feature/4711-c", { linked: "ado", status: "parked", lastActive: "2026-11-20" }),
      row("repo-b", "feature/4711-x", { linked: "local", status: "parked", pushed: false, lastActive: "2026-11-01" }),
      row("repo-b", "feature/4711-y", { linked: "local", status: "current", pushed: false, lastActive: "2026-10-01" }),
      row("repo-b", "feature/4711-z", { linked: "local", status: "current", pushed: false, lastActive: "2026-11-15" }),
    ]);
    // linked in Azure DevOps wins over the local star; between two linked ones the latest
    expect(per.get("repo-a")?.row.branch).toBe("feature/4711-c");
    expect(per.get("repo-a")?.others).toBe(2);
    // nothing linked: the star, and between two stars the latest
    expect(per.get("repo-b")?.row.branch).toBe("feature/4711-z");
    expect(per.get("repo-b")?.others).toBe(2);
  });

  it("a branch that is only on the remote counts; a repository with none gets a new branch", () => {
    const { rows: out } = storyRepoRows(
      [row("repo-a", "feature/4711-r", { linked: "ado", local: false, pushed: true }), row("repo-b", "feature/4711-gone", { linked: "ado", local: false, pushed: false })],
      [{ name: "repo-a", path: "/c/repo-a" }, { name: "repo-b", path: "/c/repo-b" }],
    );
    expect(out.map((r) => [r.repo, r.branch ?? "new", r.picked])).toEqual([["repo-a", "feature/4711-r", true], ["repo-b", "new", false]]);
  });

  it("an existing branch without a link is shown, ticked, and linked after opening; N other is information only", () => {
    const { rows: out } = storyRepoRows(
      [row("repo-a", "feature/4711-x", { linked: "ado" }), row("repo-b", "feature/4711-z", { linked: "local" }), row("repo-b", "feature/4711-w", { linked: "local", status: "old" })],
      [{ name: "repo-a", path: "/c/repo-a" }, { name: "repo-b", path: "/c/repo-b" }, { name: "repo-c", path: "/c/repo-c" }],
    );
    expect(out.map((r) => [r.repo, r.branch ?? "new", r.picked, r.linked, r.others])).toEqual([
      ["repo-a", "feature/4711-x", true, true, undefined],
      ["repo-b", "feature/4711-z", true, false, 1],
      ["repo-c", "new", false, undefined, undefined],
    ]);
    expect(out.map(rowDescription)).toEqual(["feature/4711-x", "feature/4711-z · 1 other", "new branch from the target"]);
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
    expect(args).toEqual(["worktree", "open", "--repos", "/c/repo-a,/c/repo-b,/c/repo-c,/c/repo-d", "--branch", "feature/4711-x-2", "--branch-for", "repo-a=feature/4711-x-2,repo-b=feature/4711-y,repo-c=feature/4711-order-export,repo-d=feature/4711-order-export", "--story", "4711", "--from", "staging", "--window", "none"]);
    // nothing linked: every repository gets the new branch
    expect(openStoryArgs({ id: 4711, title: "Order export" }, [{ repo: "repo-d", path: "/c/repo-d", picked: true, onThisPc: true }])).toEqual(["worktree", "open", "--repos", "/c/repo-d", "--branch", "feature/4711-order-export", "--branch-for", "repo-d=feature/4711-order-export", "--story", "4711", "--window", "none"]);
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

describe("Open Story with branches known only by their name", () => {
  it("a repository whose only branch of the story is found by name shows it (ticked), not new branch; linked and local links go first", () => {
    const { rows: out } = storyRepoRows(
      [
        row("repo-a", "feature/4711-x", { linked: "ado" }),
        row("repo-b", "feature/4711-by-name", { linked: "name", status: "parked", pushed: false }),
        row("repo-c", "feature/4711-local", { linked: "local", status: "parked", pushed: false }),
        row("repo-c", "feature/4711-by-name", { linked: "name", status: "current", pushed: false }),
        row("repo-d", "feature/4711-remote", { linked: "name", local: false, pushed: true }),
      ],
      [{ name: "repo-a", path: "/c/a" }, { name: "repo-b", path: "/c/b" }, { name: "repo-c", path: "/c/c" }, { name: "repo-d", path: "/c/d" }, { name: "repo-e", path: "/c/e" }],
    );
    expect(out.map((r) => [r.repo, r.branch ?? "new", r.picked, r.linked, r.others])).toEqual([
      ["repo-a", "feature/4711-x", true, true, undefined],
      ["repo-b", "feature/4711-by-name", true, false, undefined],
      ["repo-c", "feature/4711-local", true, false, 1],
      ["repo-d", "feature/4711-remote", true, false, undefined],
      ["repo-e", "new", false, undefined, undefined],
    ]);
  });
});
