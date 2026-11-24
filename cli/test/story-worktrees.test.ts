import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACTIVITY,
  emptyStoryWorktrees,
  gitCommonDir,
  linkBranch,
  markStatus,
  readStoryWorktrees,
  recordActivity,
  scoreAt,
  storyIdFromBranch,
  storyWorktreesFile,
  suggestCurrent,
  updateStoryWorktrees,
  worktreePathFor,
  misplacedWorktrees,
  type StoryWorktrees,
} from "../src/lib/storyWorktrees.js";
import { sh, tmp } from "./helpers.js";

const DAY = 86_400_000;
const T0 = Date.parse("2026-11-20T09:00:00Z");

describe("story-worktrees.json: where and how it is kept", () => {
  it("lives in the git common dir, also when asked from a worktree, and is written atomically with a schema version", () => {
    const parent = tmp();
    const main = join(parent, "repo-a");
    mkdirSync(main);
    sh(main, ["init", "-q", "-b", "main"]);
    sh(main, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "init"]);
    sh(main, ["worktree", "add", "-q", "-b", "feature/7-x", join(parent, "wt")]);
    const common = gitCommonDir(join(parent, "wt"))!;
    expect(common.replace(/\\/g, "/").toLowerCase()).toBe(join(main, ".git").replace(/\\/g, "/").toLowerCase());
    expect(gitCommonDir(join(main, "sub", "deeper"))?.toLowerCase()).toBe(common.toLowerCase());
    const file = storyWorktreesFile(common);
    updateStoryWorktrees(file, (d) => linkBranch(d, { storyId: 7, branch: "feature/7-x", worktree: join(parent, "wt"), current: true }, T0));
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw.version).toBe(1);
    expect(raw.branches["feature/7-x"]).toMatchObject({ storyId: 7, status: "current" });
    expect(readStoryWorktrees(file).branches["feature/7-x"].created).toBe(new Date(T0).toISOString());
  });

  it("an unreadable or newer file is never overwritten silently", () => {
    const dir = tmp();
    const file = join(dir, "story-worktrees.json");
    writeFileSync(file, JSON.stringify({ version: 99, branches: {} }));
    expect(() => updateStoryWorktrees(file, (d) => d)).toThrow(/newer version/);
    writeFileSync(file, "{ broken");
    expect(() => updateStoryWorktrees(file, (d) => d)).toThrow(/cannot be read/);
    expect(readFileSync(file, "utf8")).toBe("{ broken");
  });
});

describe("one star per story per repository", () => {
  it("marking a branch current makes the previous current one old; old, parked and labels change with one call", () => {
    let d: StoryWorktrees = emptyStoryWorktrees();
    d = linkBranch(d, { storyId: 7, branch: "feature/7-export", current: true }, T0);
    d = linkBranch(d, { storyId: 7, branch: "feature/7-export-v2" }, T0);
    d = linkBranch(d, { storyId: 8, branch: "feature/8-other", current: true }, T0);
    expect(d.branches["feature/7-export-v2"].status).toBe("parked");
    d = markStatus(d, "feature/7-export-v2", "current", T0 + 1);
    expect(d.branches["feature/7-export-v2"].status).toBe("current");
    expect(d.branches["feature/7-export"].status).toBe("old");
    // another story keeps its own star
    expect(d.branches["feature/8-other"].status).toBe("current");
    d = markStatus(d, "feature/7-export", "parked", T0 + 2, "spike, keep for the demo");
    expect(d.branches["feature/7-export"]).toMatchObject({ status: "parked", label: "spike, keep for the demo" });
    expect(() => markStatus(d, "nope", "old", T0)).toThrow(/not linked/);
  });
});

describe("the story id in a branch name", () => {
  it("is found in the usual shapes, and a team pattern wins", () => {
    expect(storyIdFromBranch("feature/1234-search")).toBe(1234);
    expect(storyIdFromBranch("1234-search")).toBe(1234);
    expect(storyIdFromBranch("bugfix/US-77_typo")).toBe(77);
    expect(storyIdFromBranch("users/dev/feature/4321")).toBe(4321);
    expect(storyIdFromBranch("main")).toBeUndefined();
    expect(storyIdFromBranch("release/2026.11")).toBeUndefined();
    expect(storyIdFromBranch("story/7_een-ding", "^story/(\\d+)_")).toBe(7);
    expect(storyIdFromBranch("feature/1234-x", "^story/(\\d+)_")).toBeUndefined();
  });
});

describe("the folder layout <root>/<storyId>-<slug>/<repo>[--variant]", () => {
  const root = "/wt";
  it("puts the first worktree of a repository in the story folder, a second one as a variant", () => {
    expect(worktreePathFor({ root, storyId: 1234, slug: "search", repo: "developers", branch: "feature/1234-search", storyFolders: [], exists: () => false })).toBe("/wt/1234-search/developers");
    const taken = new Set(["/wt/1234-search/developers"]);
    expect(worktreePathFor({ root, storyId: 1234, slug: "other-slug", repo: "developers", branch: "feature/1234-search-v2", storyFolders: ["1234-search"], exists: (p) => taken.has(p) })).toBe("/wt/1234-search/developers--search-v2");
  });

  it("uses the existing story folder whatever its slug, and numbers a clashing variant", () => {
    const taken = new Set(["/wt/1234-search/developers", "/wt/1234-search/developers--v2"]);
    expect(worktreePathFor({ root, storyId: 1234, repo: "developers", branch: "feature/1234-v2", storyFolders: ["12345-other", "1234-search"], exists: (p) => taken.has(p) })).toBe("/wt/1234-search/developers--v2-2");
  });

  it("without a story it goes to _no-story/<repo>--<branch>", () => {
    expect(worktreePathFor({ root, repo: "developers", branch: "spike/try this", storyFolders: [], exists: () => false })).toBe("/wt/_no-story/developers--spike-try-this");
  });

  it("finds the worktrees that are not in their story folder", () => {
    const list = [
      { path: "/wt/1234-search/developers", branch: "feature/1234-search", repo: "developers" },
      { path: "/old/place/dev-1234", branch: "feature/1234-search-v2", repo: "developers" },
      { path: "/elsewhere/x", branch: "main", repo: "developers" },
    ];
    const m = misplacedWorktrees(list, { root, storyFolders: ["1234-search"], exists: (p) => p === "/wt/1234-search/developers" });
    expect(m).toEqual([{ path: "/old/place/dev-1234", branch: "feature/1234-search-v2", repo: "developers", storyId: 1234, target: "/wt/1234-search/developers--search-v2" }]);
  });
});

describe("the star follows where you really work", () => {
  const base = () => {
    let d = emptyStoryWorktrees();
    d = linkBranch(d, { storyId: 7, branch: "feature/7-export", current: true }, T0 - 5 * DAY);
    d = linkBranch(d, { storyId: 7, branch: "feature/7-export-v2" }, T0 - 5 * DAY);
    return d;
  };

  it("the score decays: half after two days", () => {
    let d = base();
    d = recordActivity(d, "feature/7-export", "commit", T0);
    expect(scoreAt(d.branches["feature/7-export"], T0)).toBeCloseTo(ACTIVITY.commit, 5);
    expect(scoreAt(d.branches["feature/7-export"], T0 + 2 * DAY)).toBeCloseTo(ACTIVITY.commit / 2, 5);
  });

  it("asks when most of the activity of the last two days is in a branch that is not the star", () => {
    let d = base();
    d = recordActivity(d, "feature/7-export", "save", T0 - DAY);
    expect(suggestCurrent(d, 7, T0)).toBeUndefined();
    for (let i = 0; i < 12; i++) d = recordActivity(d, "feature/7-export-v2", "save", T0 + i * 60_000);
    expect(suggestCurrent(d, 7, T0 + DAY / 2)).toMatchObject({ branch: "feature/7-export-v2", reason: "most activity" });
  });

  it("asks after three sessions in a row in the same other branch", () => {
    let d = base();
    for (let s = 0; s < 3; s++) d = recordActivity(d, "feature/7-export-v2", "focus", T0 + s * 3 * 3_600_000, 1);
    d = recordActivity(d, "feature/7-export", "save", T0 + 10 * 3_600_000 - 1000);
    // the star had the last save, but v2 has three sessions in a row before it: no, the run is broken
    expect(suggestCurrent(d, 7, T0 + 10 * 3_600_000)?.reason).not.toBe("three sessions in a row");
    let e = base();
    for (let s = 0; s < 3; s++) e = recordActivity(e, "feature/7-export-v2", "focus", T0 + s * 3 * 3_600_000, 1);
    expect(suggestCurrent(e, 7, T0 + 10 * 3_600_000)).toMatchObject({ branch: "feature/7-export-v2", reason: "three sessions in a row" });
  });

  it("asks on a commit while the star has been quiet for days", () => {
    let d = base();
    d = recordActivity(d, "feature/7-export", "save", T0 - 4 * DAY);
    d = recordActivity(d, "feature/7-export-v2", "commit", T0);
    expect(suggestCurrent(d, 7, T0)).toMatchObject({ branch: "feature/7-export-v2", reason: "commit while the star is quiet" });
  });

  it("after No it asks again only when the pattern is clearly stronger; never-ask stops it for the story", () => {
    let d = base();
    for (let i = 0; i < 12; i++) d = recordActivity(d, "feature/7-export-v2", "save", T0 + i * 60_000);
    const s = suggestCurrent(d, 7, T0 + 3_600_000)!;
    d = { ...d, branches: { ...d.branches, "feature/7-export-v2": { ...d.branches["feature/7-export-v2"], declinedScore: s.score } } };
    for (let i = 0; i < 3; i++) d = recordActivity(d, "feature/7-export-v2", "save", T0 + 2 * 3_600_000 + i * 60_000);
    expect(suggestCurrent(d, 7, T0 + 3 * 3_600_000)).toBeUndefined();
    for (let i = 0; i < 20; i++) d = recordActivity(d, "feature/7-export-v2", "save", T0 + 4 * 3_600_000 + i * 60_000);
    expect(suggestCurrent(d, 7, T0 + 5 * 3_600_000)?.branch).toBe("feature/7-export-v2");
    d = { ...d, stories: { "7": { neverAsk: true } } };
    expect(suggestCurrent(d, 7, T0 + 5 * 3_600_000)).toBeUndefined();
  });
});
