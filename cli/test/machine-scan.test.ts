import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commonRoots, configuredClones, machineFolders } from "../src/lib/machineFolders.js";
import { forgetScan, lookInFolders, readLookIn, scanMachine, setById, setOfStory, walk, writeLookIn } from "../src/lib/machineScan.js";
import { forgetUse, formatRecent, MAX_RECENT_USE, readRecentUse, rememberUse, withUse } from "../src/lib/recentUse.js";
import { isClosedState, readSeenStories, rememberStories } from "../src/lib/storyCache.js";

let root: string;
let env: NodeJS.ProcessEnv;

/** A fake clone: only what the scan reads (.git/HEAD and .git/config), no git process. */
function clone(dir: string, branch = "main", remote = "https://user:secret@dev.example/org/proj/_git/repo-a") {
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  writeFileSync(join(dir, ".git", "config"), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
}

/** A fake set folder with one linked worktree per repository. */
function set(folder: string, story: number, branch: string, repos: string[]) {
  mkdirSync(folder, { recursive: true });
  const meta = {
    story,
    branch,
    workspace: join(folder, `story-${story}.code-workspace`),
    repos: repos.map((name) => {
      const path = join(folder, name);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, ".git"), `gitdir: ${join(root, "elsewhere", name)}\n`);
      return { name, source: join(root, "code", name), path };
    }),
  };
  writeFileSync(join(folder, ".aihub-set.json"), JSON.stringify(meta));
  writeFileSync(meta.workspace, "{}");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aihub-scan-"));
  env = { AIHUB_CONFIG_HOME: join(root, "cfg"), AIHUB_COMMON_ROOTS: "" };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("scan of the PC", () => {
  it("finds clones and sets whichever folder is open, with branch and remote read from files", () => {
    clone(join(root, "code", "repo-a"), "feature/7-x");
    clone(join(root, "code", "repo-b"), "main", "git@dev.example:org/proj/repo-b.git");
    set(join(root, "code", "worktrees", "7-x"), 7, "feature/7-x", ["repo-a", "repo-b"]);
    const scan = walk([join(root, "code")]);
    expect(scan.repos.map((r) => [r.name, r.branch])).toEqual([["repo-a", "feature/7-x"], ["repo-b", "main"]]);
    // credentials never leave the config file
    expect(scan.repos[0].remote).toBe("https://dev.example/org/proj/_git/repo-a");
    expect(scan.sets).toHaveLength(1);
    expect(scan.sets[0]).toMatchObject({ story: 7, branch: "feature/7-x", repos: [{ name: "repo-a", exists: true }, { name: "repo-b", exists: true }] });
  });

  it("a linked worktree is no clone of its own, and node_modules, dot folders and deep folders are skipped", () => {
    clone(join(root, "code", "repo-a"));
    clone(join(root, "code", "node_modules", "dep"));
    clone(join(root, "code", ".hidden", "repo-h"));
    clone(join(root, "code", "a", "b", "c", "d", "too-deep"));
    clone(join(root, "code", "a", "b", "ok-depth"));
    mkdirSync(join(root, "code", "wt-like"), { recursive: true });
    writeFileSync(join(root, "code", "wt-like", ".git"), "gitdir: /x/.git/worktrees/wt-like\n");
    expect(walk([join(root, "code")]).repos.map((r) => r.name)).toEqual(["ok-depth", "repo-a"]);
  });

  it("a story's set is found by its story number; several sets in one folder are all listed", () => {
    set(join(root, "w", "9-y"), 9, "feature/9-y", ["repo-a"]);
    const scan = walk([join(root, "w")]);
    expect(setOfStory(scan, 9)?.folder).toBe(join(root, "w", "9-y"));
    expect(setOfStory(scan, 10)).toBeUndefined();
    expect(setById(scan, join(root, "w", "9-y"))?.story).toBe(9);
    expect(setById(scan, join(root, "w", "9-y", "story-9.code-workspace"))?.story).toBe(9);
  });

  it("is cached for the TTL, walked again on refresh, after forgetScan and for other folders", () => {
    clone(join(root, "code", "repo-a"));
    const folders = [join(root, "code")];
    const t0 = 1_000_000;
    expect(scanMachine(env, folders, { now: t0 }).repos).toHaveLength(1);
    clone(join(root, "code", "repo-c"));
    expect(scanMachine(env, folders, { now: t0 + 60_000 }).repos).toHaveLength(1);
    expect(scanMachine(env, folders, { now: t0 + 60_000, refresh: true }).repos).toHaveLength(2);
    clone(join(root, "code", "repo-d"));
    expect(scanMachine(env, folders, { now: t0 + 61_000 }).repos).toHaveLength(2);
    forgetScan(env);
    expect(scanMachine(env, folders, { now: t0 + 62_000 }).repos).toHaveLength(3);
    expect(scanMachine(env, folders, { now: t0 + 62_000 + 10 * 60_000 }).repos).toHaveLength(3);
    expect(scanMachine(env, [join(root, "other")], { now: t0 + 63_000 }).repos).toHaveLength(0);
  });

  it("folders to look in: the personal list wins, else the parents of what is known (never a root)", () => {
    expect(lookInFolders(env, [join(root, "code", "repo-a"), join(root, "code", "repo-b")])).toEqual([join(root, "code")]);
    expect(lookInFolders(env, [join(root, "x").slice(0, 3) + "solo"])).toEqual([]);
    expect(readLookIn(env)).toBeUndefined();
    writeLookIn(env, [join(root, "mine"), join(root, "mine")]);
    expect(readLookIn(env)).toEqual([join(root, "mine")]);
    expect(lookInFolders(env, [join(root, "code", "repo-a")])).toEqual([join(root, "mine")]);
  });
});

describe("recent list", () => {
  it("newest first, one line per item (any case or slash), at most 30, forgotten on request", () => {
    let items = withUse([], { kind: "repo", id: "C:\\code\\repo-a", label: "repo-a" }, 1);
    items = withUse(items, { kind: "set", id: "C:\\w\\7\\story-7.code-workspace", label: "#7 x" }, 2);
    items = withUse(items, { kind: "repo", id: "c:/code/repo-a/", label: "repo-a" }, 3);
    expect(items.map((i) => i.label)).toEqual(["repo-a", "#7 x"]);
    for (let n = 0; n < 40; n++) items = withUse(items, { kind: "repo", id: `/r/${n}`, label: `r${n}` }, 10 + n);
    expect(items).toHaveLength(MAX_RECENT_USE);
    rememberUse(env, { kind: "repo", id: "/r/1", label: "r1" }, 1000);
    rememberUse(env, { kind: "set", id: "/s/1", label: "#1" }, 2000);
    expect(readRecentUse(env).map((i) => i.label)).toEqual(["#1", "r1"]);
    forgetUse(env, "/S/1");
    expect(readRecentUse(env).map((i) => i.label)).toEqual(["r1"]);
    expect(formatRecent(readRecentUse(env), Date.parse("1970-01-01T00:00:01Z") + 3 * 3_600_000)).toContain("r1");
  });

  it("a window that stays open writes nothing: the same top item within a minute is left alone", () => {
    rememberUse(env, { kind: "repo", id: "/r/1", label: "r1" }, 1_000_000);
    const first = readRecentUse(env)[0].lastUsed;
    rememberUse(env, { kind: "repo", id: "/r/1", label: "r1" }, 1_030_000);
    expect(readRecentUse(env)[0].lastUsed).toBe(first);
    rememberUse(env, { kind: "repo", id: "/r/1", label: "r1" }, 1_100_000);
    expect(readRecentUse(env)[0].lastUsed).not.toBe(first);
  });

  it("a broken file is an empty list", () => {
    mkdirSync(env.AIHUB_CONFIG_HOME!, { recursive: true });
    writeFileSync(join(env.AIHUB_CONFIG_HOME!, "recent.json"), "{ not json");
    expect(readRecentUse(env)).toEqual([]);
  });
});

describe("stories seen", () => {
  it("remembers title and state, keeps an earlier state when a read lacks one, knows closed states", () => {
    rememberStories(env, [{ id: 7, title: "Export", state: "Active" }, { id: 8, title: "Old", state: "Closed" }], 1);
    rememberStories(env, [{ id: 7, title: "Export v2" }], 2);
    const s = readSeenStories(env);
    expect(s[7]).toMatchObject({ title: "Export v2", state: "Active" });
    expect(isClosedState(s[8].state)).toBe(true);
    expect(isClosedState(s[7].state)).toBe(false);
    expect(isClosedState(undefined)).toBe(false);
  });
});

describe("where to look when nothing is known yet", () => {
  it("the usual folders that exist, a personal path list replaces them, an empty one means none", () => {
    mkdirSync(join(root, "home", "source", "repos"), { recursive: true });
    mkdirSync(join(root, "home", "git"), { recursive: true });
    expect(commonRoots({}, join(root, "home")).filter((p) => p.startsWith(root))).toEqual([join(root, "home", "source", "repos"), join(root, "home", "git")]);
    expect(commonRoots({ AIHUB_COMMON_ROOTS: join(root, "home", "git") })).toEqual([join(root, "home", "git")]);
    expect(commonRoots({ AIHUB_COMMON_ROOTS: "" })).toEqual([]);
  });

  it("the clones of the config (groups, preferred clones) and a set's workspace file count as known; the folders are their parents, pruned", () => {
    mkdirSync(env.AIHUB_CONFIG_HOME!, { recursive: true });
    writeFileSync(join(env.AIHUB_CONFIG_HOME!, "groups.json"), JSON.stringify({ groups: { pipeline: [{ name: "repo-a", path: join(root, "g", "repo-a") }] } }));
    writeFileSync(join(env.AIHUB_CONFIG_HOME!, "repos.json"), JSON.stringify({ prefer: { "repo-b": join(root, "g", "deep", "repo-b") } }));
    expect(configuredClones(env)).toEqual([join(root, "g", "repo-a"), join(root, "g", "deep", "repo-b")]);
    expect(machineFolders(env, undefined, [])).toEqual([join(root, "g")]);
    expect(machineFolders(env, undefined, [join(root, "w", "7-x", "story-7.code-workspace")])).toEqual([join(root, "g"), join(root, "w")]);
    expect(machineFolders(env, undefined, [], [join(root, "usual")])).toEqual([join(root, "g"), join(root, "usual")]);
  });
});
