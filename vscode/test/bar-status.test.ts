import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildState } from "../src/bar/state";
import { gitRun } from "../src/bar/ownWindow";
import { BehindMemo, gitStatusOf, isStoryBranch, prOfBranch, prStateOf, PrMemo, type GitRepoLike, type PrRow } from "../src/bar/repoStatus";
import { sh, write } from "./gitHelpers";

const repo = (path: string, o: Partial<GitRepoLike["state"]> = {}): GitRepoLike => ({ rootUri: { fsPath: path }, state: { workingTreeChanges: [], indexChanges: [], mergeChanges: [], ...o } });
const f = (p: string) => ({ uri: { fsPath: p } });

describe("changes and ahead from the git extension", () => {
  it("a file staged and changed again counts once; ahead from HEAD; paths in any case or slash", () => {
    const r = repo("C:\\Work\\Repo A", { workingTreeChanges: [f("C:\\Work\\Repo A\\a.txt"), f("C:\\Work\\Repo A\\b.txt")], indexChanges: [f("c:/work/repo a/a.txt")], mergeChanges: [], HEAD: { ahead: 3 } });
    expect(gitStatusOf([r], "c:/work/repo a/")).toEqual({ changes: 2, ahead: 3 });
    expect(gitStatusOf([r], "C:/other")).toBeUndefined();
    expect(gitStatusOf([repo("C:/x")], "C:/x")).toEqual({ changes: 0, ahead: 0 });
  });
});

describe("behind the target: one git call after a HEAD change, then remembered", () => {
  it("counts from the refs that are there, asks git once per repository, again only after forget()", async () => {
    const root = mkdtempSync(join(tmpdir(), "aihub-behind-"));
    const origin = join(root, "origin.git");
    mkdirSync(origin);
    sh(origin, "init", "--bare", "-b", "main");
    const a = join(root, "Repo A");
    sh(root, "clone", origin, a);
    sh(a, "switch", "-c", "main");
    write(a, "x.txt", "1\n");
    sh(a, "add", "-A");
    sh(a, "commit", "-m", "one");
    sh(a, "push", "-u", "origin", "main");
    sh(a, "switch", "-c", "feature/5-x");
    // somebody else puts two commits on main
    const b = join(root, "other");
    sh(root, "clone", origin, b);
    for (const n of ["2", "3"]) {
      write(b, `${n}.txt`, n);
      sh(b, "add", "-A");
      sh(b, "commit", "-m", n);
    }
    sh(b, "push", "origin", "HEAD:main");
    sh(a, "fetch", "origin");
    let calls = 0;
    const memo = new BehindMemo(async (cwd, args) => (calls++, gitRun(cwd, args)));
    expect(await memo.behind(a, "Repo A")).toBe(2);
    expect(await memo.behind(a, "Repo A")).toBe(2);
    expect(calls).toBe(1);
    memo.forget(a);
    await memo.behind(a, "Repo A");
    expect(calls).toBe(2);
    // not a repository: unknown, not an error
    expect(await memo.behind(join(root, "nowhere"), "x")).toBeUndefined();
  });
});

const row = (o: Partial<PrRow> = {}): PrRow => ({ id: 812, repo: "repo-a", source: "feature/5-x", status: "active", url: "https://x/pr/812", reviewers: [], ...o });

describe("the pull request of a branch", () => {
  it("merged, approved, failed, active; abandoned is none", () => {
    expect(prStateOf(row({ status: "completed" }))).toBe("merged");
    expect(prStateOf(row({ status: "abandoned" }))).toBeUndefined();
    expect(prStateOf(row())).toBe("active");
    expect(prStateOf(row({ reviewers: [{ vote: 10, required: true }, { vote: 0, required: false }] }))).toBe("approved");
    expect(prStateOf(row({ reviewers: [{ vote: 10, required: false }, { vote: 0, required: true }] }))).toBe("active");
    expect(prStateOf(row({ reviewers: [{ vote: -5, required: false }] }))).toBe("failed");
    expect(prStateOf(row({ mergeStatus: "conflicts" }))).toBe("failed");
  });

  it("an open one before a merged one; repository names in any case; none for another branch", () => {
    const rows = [row({ id: 1, status: "completed" }), row({ id: 2 }), row({ id: 3, source: "feature/other" })];
    expect(prOfBranch(rows, "REPO-A", "feature/5-x")).toEqual({ id: 2, status: "active", url: "https://x/pr/812" });
    expect(prOfBranch(rows, "repo-a", "feature/none")).toBeUndefined();
    expect(prOfBranch([row({ status: "abandoned" })], "repo-a", "feature/5-x")).toBeUndefined();
  });

  it("one read for the set, remembered for minutes; a failed read is remembered too; force and concurrent calls", async () => {
    let t = 1000;
    let calls = 0;
    let fail = false;
    const memo = new PrMemo(async () => {
      calls++;
      if (fail) throw new Error("not signed in");
      return [row()];
    }, () => t);
    await Promise.all([memo.refresh(), memo.refresh()]);
    expect(calls).toBe(1);
    expect(memo.get()).toHaveLength(1);
    t += 4 * 60_000;
    await memo.refresh();
    expect(calls).toBe(1);
    t += 2 * 60_000;
    fail = true;
    await memo.refresh();
    expect(calls).toBe(2);
    // the failed read is remembered: no retry on every event; the old answer stays
    await memo.refresh();
    await memo.refresh();
    expect(calls).toBe(2);
    expect(memo.get()).toHaveLength(1);
    await memo.refresh(true);
    expect(calls).toBe(3);
  });
});

describe("BarState.repos[]", () => {
  const open = { dir: "C:/s/a", set: { folder: "C:/s", story: 5, branch: "feature/5-x", repos: [{ name: "repo-a", path: "C:/s/a", branch: "feature/5-x" }, { name: "repo-b", path: "C:/s/b", branch: "main" }] } };
  const base = { open, scan: { at: 1, folders: [], repos: [], sets: [] }, recents: [], lookIn: [], stories: {}, exists: () => true };

  it("changes, ahead, behindTarget, pr and storyBranch are there; the old fields stay", () => {
    const s = buildState({
      ...base,
      dirty: () => 9,
      status: (p) => (p === "C:/s/a" ? { changes: 2, ahead: 1, behindTarget: 4 } : undefined),
      pr: (repo, branch) => (repo === "repo-a" && branch === "feature/5-x" ? { id: 812, status: "approved", url: "https://x/pr/812" } : undefined),
      storyBranch: (_p, b) => b === "feature/5-x",
    });
    expect(s.repos[0]).toEqual({ name: "repo-a", path: "C:/s/a", branch: "feature/5-x", dirty: 2, changes: 2, ahead: 1, behindTarget: 4, pr: { id: 812, status: "approved", url: "https://x/pr/812" }, storyBranch: true });
    // unknown stays absent; storyBranch is a plain false
    expect(s.repos[1]).toEqual({ name: "repo-b", path: "C:/s/b", branch: "main", dirty: 9, changes: 9, storyBranch: false });
  });

  it("a set without a story has no story branches; a single repository has the fields it knows", () => {
    expect(buildState({ ...base, open: { ...open, set: { ...open.set, story: 0 } }, storyBranch: () => true }).repos.every((r) => r.storyBranch === false)).toBe(true);
    const one = buildState({ ...base, open: { dir: "C:/r", repo: { name: "r", path: "C:/r", branch: "main" } }, status: () => ({ changes: 1, ahead: 0, behindTarget: 0 }) });
    expect(one.repos[0]).toMatchObject({ changes: 1, ahead: 0, behindTarget: 0, storyBranch: false });
  });

  it("a branch is a story branch when linked or when its name starts with the story number", () => {
    expect(isStoryBranch(5, "feature/5-x", [])).toBe(true);
    expect(isStoryBranch(5, "feature/other", ["feature/other"])).toBe(true);
    expect(isStoryBranch(5, "feature/50-x", [])).toBe(false);
    expect(isStoryBranch(0, "feature/5-x", [])).toBe(false);
  });
});
