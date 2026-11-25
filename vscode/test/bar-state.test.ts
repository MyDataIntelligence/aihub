import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeLookIn } from "../../cli/src/lib/machineScan";
import { readRecentUse, rememberUse } from "../../cli/src/lib/recentUse";
import { rememberStories } from "../../cli/src/lib/storyCache";
import { updateStoryWorktrees, linkBranch, storyWorktreesFile } from "../../cli/src/lib/storyWorktrees";
import { BarEngine, prune } from "../src/bar/engine";

let root: string;
let env: NodeJS.ProcessEnv;

function clone(dir: string, branch = "main") {
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
}

/** A set folder: its worktrees are linked checkouts (a .git file) whose HEAD is in the main clone's worktrees folder. */
function set(story: number, branch: string, repos: string[], where = join(root, "code", "worktrees", `${story}-x`)) {
  mkdirSync(where, { recursive: true });
  const workspace = join(where, `story-${story}.code-workspace`);
  const meta = {
    story,
    branch,
    workspace,
    repos: repos.map((name) => {
      const path = join(where, name);
      const gitdir = join(root, "code", name, ".git", "worktrees", `${story}-${name}`);
      mkdirSync(gitdir, { recursive: true });
      writeFileSync(join(gitdir, "HEAD"), `ref: refs/heads/${branch}\n`);
      writeFileSync(join(gitdir, "commondir"), "../..");
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, ".git"), `gitdir: ${gitdir}\n`);
      return { name, source: join(root, "code", name), path };
    }),
  };
  writeFileSync(join(where, ".aihub-set.json"), JSON.stringify(meta));
  writeFileSync(workspace, "{}");
  return { where, workspace, meta };
}

const engineFor = (dir: string | undefined, extra: Partial<ConstructorParameters<typeof BarEngine>[0]> = {}) => new BarEngine({ env, dir: () => dir, dirtyOf: async () => 0, ...extra });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aihub-bar-"));
  env = { AIHUB_CONFIG_HOME: join(root, "cfg"), AIHUB_COMMON_ROOTS: "" };
  clone(join(root, "code", "repo-a"));
  clone(join(root, "code", "repo-b"), "develop");
  writeLookIn(env, [join(root, "code")]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("BarState in the three modes", () => {
  it("empty: no folder open; every repository and set on the PC is still there, and the recent list", async () => {
    const s7 = set(7, "feature/7-x", ["repo-a", "repo-b"]);
    rememberUse(env, { kind: "set", id: s7.workspace, label: "#7 Export", detail: "repo-a, repo-b" }, 1000);
    rememberUse(env, { kind: "repo", id: join(root, "gone"), label: "gone" }, 2000);
    const st = await engineFor(undefined).state();
    expect(st.mode).toBe("empty");
    expect(st.repos).toEqual([]);
    expect(st.story).toBeUndefined();
    expect(st.repositories.map((r) => [r.name, r.branch])).toEqual([["repo-a", "main"], ["repo-b", "develop"]]);
    expect(st.sets).toEqual([{ id: s7.workspace, story: 7, label: "#7", repos: 2, open: false }]);
    // a recent item whose folder is gone is not offered
    expect(st.recents.map((r) => r.label)).toEqual(["#7 Export"]);
    expect(st.lookIn).toEqual([join(root, "code")]);
  });

  it("repo: a plain repository is just a repository, with its branch from HEAD and no story", async () => {
    const st = await engineFor(join(root, "code", "repo-b"), { dirtyOf: async () => 3 }).state();
    expect(st.mode).toBe("repo");
    expect(st.story).toBeUndefined();
    expect(st.setFolder).toBeUndefined();
    expect(st.repos).toEqual([{ name: "repo-b", path: join(root, "code", "repo-b"), branch: "develop", dirty: 3 }]);
    expect(st.sets).toEqual([]);
  });

  it("repo: a subfolder of a repository counts as that repository", async () => {
    mkdirSync(join(root, "code", "repo-a", "src"), { recursive: true });
    const st = await engineFor(join(root, "code", "repo-a", "src")).state();
    expect(st.mode).toBe("repo");
    expect(st.repos[0].name).toBe("repo-a");
  });

  it("set: the story, the folder, each repository's own branch (from its HEAD), changed files and the story's branches", async () => {
    rememberStories(env, [{ id: 7, title: "Export", state: "Active" }]);
    const s7 = set(7, "feature/7-x", ["repo-a", "repo-b"]);
    // repo-b was switched to another branch: the window shows it
    writeFileSync(join(root, "code", "repo-b", ".git", "worktrees", "7-repo-b", "HEAD"), "ref: refs/heads/feature/7-y\n");
    const file = storyWorktreesFile(join(root, "code", "repo-a", ".git"));
    updateStoryWorktrees(file, (d) => linkBranch(d, { storyId: 7, branch: "feature/7-x", current: true }, 1));
    const st = await engineFor(join(s7.where, "repo-a"), { dirtyOf: async (p) => (p.endsWith("repo-b") ? 2 : 0), linkedOf: (_s, repo, b) => repo === "repo-a" && b === "feature/7-x" }).state();
    expect(st.mode).toBe("set");
    expect(st.story).toEqual({ id: 7, title: "Export", state: "Active" });
    expect(st.setFolder).toBe(s7.where);
    expect(st.repos.map((r) => [r.name, r.branch, r.dirty, r.linked])).toEqual([["repo-a", "feature/7-x", 0, true], ["repo-b", "feature/7-y", 2, false]]);
    expect(st.repos[0].storyBranches).toEqual([{ name: "feature/7-x", status: "current" }]);
    expect(st.repos[1].storyBranches).toBeUndefined();
    expect(st.sets).toEqual([{ id: s7.workspace, story: 7, label: "#7 Export", repos: 2, open: true, done: false }]);
  });

  it("a story this PC never read from Azure DevOps is still named, from the title the repositories remember", async () => {
    const s7 = set(7, "feature/7-x", ["repo-a"]);
    const file = storyWorktreesFile(join(root, "code", "repo-a", ".git"));
    updateStoryWorktrees(file, (d) => ({ ...linkBranch(d, { storyId: 7, branch: "feature/7-x", current: true }, 1), stories: { "7": { title: "Order export" } } }));
    const st = await engineFor(join(s7.where, "repo-a")).state();
    expect(st.story?.title).toBe("Order export");
    expect(st.sets[0].label).toBe("#7 Order export");
    engineFor(join(s7.where, "repo-a")).noteOpen();
    expect(readRecentUse(env)[0].label).toBe("#7 Order export");
  });

  it("set: this window's set is listed even when it lies outside the folders to look in", async () => {
    const s = set(9, "feature/9-z", ["repo-a"], join(root, "elsewhere", "9-z"));
    const st = await engineFor(join(s.where, "repo-a")).state();
    expect(st.mode).toBe("set");
    expect(st.sets.map((x) => [x.story, x.open])).toEqual([[9, true]]);
  });

  it("sets of closed stories carry done, and clean only when no worktree has changes", async () => {
    rememberStories(env, [{ id: 7, title: "Old", state: "Closed" }, { id: 8, title: "Fresh", state: "Closed" }, { id: 9, title: "Going", state: "Active" }]);
    set(7, "feature/7-x", ["repo-a"]);
    set(8, "feature/8-x", ["repo-b"]);
    set(9, "feature/9-x", ["repo-a"]);
    const st = await engineFor(undefined, { dirtyOf: async (p) => (p.includes("8-x") ? 4 : 0) }).state();
    const by = Object.fromEntries(st.sets.map((x) => [x.story, x]));
    expect(by[7]).toMatchObject({ done: true, clean: true });
    expect(by[8]).toMatchObject({ done: true, clean: false });
    expect(by[9].done).toBe(false);
    expect(by[9].clean).toBeUndefined();
  });

  it("clean stays unknown when git cannot say", async () => {
    rememberStories(env, [{ id: 7, title: "Old", state: "Done" }]);
    set(7, "feature/7-x", ["repo-a"]);
    const st = await engineFor(undefined, { dirtyOf: async () => undefined }).state();
    expect(st.sets[0]).toMatchObject({ done: true });
    expect(st.sets[0].clean).toBeUndefined();
  });
});

describe("one repository is one line", () => {
  it("clones of one remote are one entry with otherClones; the most recently used wins", async () => {
    const remote = "https://dev.example/org/proj/_git/repo-z";
    for (const dir of [join(root, "code", "repo-z"), join(root, "code", "old", "repo-z")]) {
      clone(dir);
      writeFileSync(join(dir, ".git", "config"), `[remote "origin"]
	url = ${remote}
`);
    }
    // the second clone is the one in use: its files were written later (explicit times: the file system's clock may tick coarsely)
    const hourAgo = new Date(Date.now() - 3_600_000);
    for (const f of ["HEAD", "config"]) utimesSync(join(root, "code", "repo-z", ".git", f), hourAgo, hourAgo);
    writeFileSync(join(root, "code", "old", "repo-z", ".git", "index"), "x");
    const st = await engineFor(undefined).state();
    const z = st.repositories.filter((r) => r.name === "repo-z");
    expect(z).toHaveLength(1);
    expect(z[0]).toMatchObject({ path: join(root, "code", "old", "repo-z"), otherClones: 1 });
    expect(st.repositories.find((r) => r.name === "repo-a")?.otherClones).toBeUndefined();
  });
});

describe("what a window remembers", () => {
  it("a set window is remembered by its workspace file, a repository window by its folder, newest first", () => {
    const s = set(7, "feature/7-x", ["repo-a"]);
    rememberStories(env, [{ id: 7, title: "Export" }]);
    engineFor(join(s.where, "repo-a"), { }).noteOpen();
    expect(readRecentUse(env)).toMatchObject([{ kind: "set", id: s.workspace, label: "#7 Export", detail: "repo-a", story: 7 }]);
    engineFor(join(root, "code", "repo-b")).noteOpen();
    expect(readRecentUse(env).map((r) => [r.kind, r.label, r.detail])).toEqual([["repo", "repo-b", "develop"], ["set", "#7 Export", "repo-a"]]);
  });

  it("a set window writes the story title into its set file, once, so a label needs no guessing", () => {
    const s = set(7, "feature/7-x", ["repo-a"]);
    rememberStories(env, [{ id: 7, title: "Export" }]);
    engineFor(join(s.where, "repo-a")).noteOpen();
    const read = () => JSON.parse(readFileSync(join(s.where, ".aihub-set.json"), "utf8"));
    expect(read()).toMatchObject({ story: 7, storyTitle: "Export", branch: "feature/7-x" });
    engineFor(join(s.where, "repo-a")).noteOpen();
    expect(read().storyTitle).toBe("Export");
  });

  it("an empty window or a folder without git remembers nothing", () => {
    mkdirSync(join(root, "plain"), { recursive: true });
    engineFor(undefined).noteOpen();
    engineFor(join(root, "plain")).noteOpen();
    expect(readRecentUse(env)).toEqual([]);
  });
});

describe("default folders to look in", () => {
  it("without a personal list: the parents of the open folder and the recent items, nested ones covered by their parent", async () => {
    rmSync(join(env.AIHUB_CONFIG_HOME!, "lookin.json"));
    const s = set(7, "feature/7-x", ["repo-a"]);
    engineFor(join(s.where, "repo-a")).noteOpen();
    const st = await engineFor(join(s.where, "repo-a")).state();
    expect(st.lookIn).toEqual([join(root, "code")]);
    expect(st.repositories.map((r) => r.name)).toEqual(["repo-a", "repo-b"]);
    expect(prune(["/a", "/a/b", "/a/b/c/d/e", "/z"])).toEqual(["/a", "/a/b/c/d/e", "/z"]);
  });
});
