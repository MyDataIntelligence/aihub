import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { linkBranch, readStoryWorktrees, storyWorktreesFile, updateStoryWorktrees, emptyStoryWorktrees } from "../../cli/src/lib/storyWorktrees";
import { branchFacts, itemView, lastReflog, overlay, starQuestion, storyChildren, windowSet, type StoryJson } from "../src/storyModel";

const story: StoryJson = {
  id: 7,
  title: "Export bouwen",
  state: "Doing",
  branches: [
    { repo: "developers", branch: "feature/7-export", linked: "both", status: "current", local: true, pushed: true, ahead: 0, dirty: false },
    { repo: "developers", branch: "feature/7-export-v2", linked: "ado", status: "parked", local: true, pushed: false, ahead: 0, dirty: true, worktree: "/wt/7-export/developers--export-v2" },
    { repo: "pipelines", branch: "feature/7-export", linked: "local", status: "current", local: true, pushed: true, ahead: 2, dirty: false, pr: { id: 41, draft: true, status: "active" } },
  ],
};

describe("My Stories: the tree", () => {
  it("story -> repository -> branches, the star first and an old branch dimmed", () => {
    const repos = storyChildren({ kind: "story", story }, [story]);
    expect(repos.map((r) => (r.kind === "repo" ? r.repo : ""))).toEqual(["developers", "pipelines"]);
    const local = { developers: { "feature/7-export-v2": { storyId: 7, branch: "feature/7-export-v2", status: "current" as const, created: "x", label: "second try" }, "feature/7-export": { storyId: 7, branch: "feature/7-export", status: "old" as const, created: "x" } } };
    const s2 = overlay([story], local)[0];
    const rows = storyChildren(storyChildren({ kind: "story", story: s2 }, [s2])[0], [s2]);
    const views = rows.map(itemView);
    expect(views.map((v) => v.label)).toEqual(["★ feature/7-export-v2", "feature/7-export"]);
    expect(views[0].description).toBe("“second try” · uncommitted work · local only");
    expect(views[1]).toMatchObject({ dim: true, icon: "history", contextValue: "aihubStoryBranch-old" });
    expect(views[0].contextValue).toBe("aihubStoryBranch-current-wt");
  });

  it("says what matters about a branch in a few words", () => {
    expect(branchFacts(story.branches[2])).toBe("2 to push · PR !41 draft · not linked in Azure DevOps");
    expect(itemView({ kind: "story", story }).label).toBe("#7 Export bouwen");
  });
});

describe("the status bar after opening a set", () => {
  it("reads aihub.set from the workspace file, also for switched checkouts", () => {
    expect(windowSet({ story: 7, branch: "feature/7-export", mode: "switch", repos: [{ name: "a", branch: "feature/7-export" }, { name: "b", branch: "feature/7-export" }] })).toEqual({ story: 7, group: undefined, branch: "feature/7-export", total: 2, repos: ["a", "b"] });
    expect(windowSet(undefined)).toBeNull();
    expect(windowSet({ branch: "x", repos: [] })).toBeNull();
  });
});

describe("commits and checkouts from the reflog", () => {
  it("tells a commit, a checkout and the rest apart", () => {
    expect(lastReflog("a b T <t@example.invalid> 1 +0100\tcommit: fix")).toEqual({ kind: "commit" });
    expect(lastReflog("a b T <t@example.invalid> 1 +0100\tcommit (amend): fix")).toEqual({ kind: "commit" });
    expect(lastReflog("a b T <t@example.invalid> 1 +0100\tcheckout: moving from main to feature/7-export-v2")).toEqual({ kind: "checkout", to: "feature/7-export-v2" });
    expect(lastReflog("a b T <t@example.invalid> 1 +0100\treset: moving to HEAD~1")).toEqual({ kind: "other" });
  });

  it("asks in plain words", () => {
    expect(starQuestion({ storyId: 7, branch: "feature/7-export-v2", current: "feature/7-export", reason: "most activity", score: 12 })).toBe("You mostly work in feature/7-export-v2. Mark it as the current ★ for story 7?");
  });
});

// ---- the tracker against a fake vscode: simulated saves -> one question -> the answer lands in the file ----

const h = vi.hoisted(() => ({
  setting: "ask" as string,
  answers: [] as (string | undefined)[],
  infos: [] as string[],
  folders: [] as { uri: { fsPath: string; scheme: string } }[],
  listeners: {} as Record<string, (e: any) => void>,
}));

vi.mock("vscode", () => {
  const on = (name: string) => (f: (e: any) => void) => ((h.listeners[name] = f), { dispose() {} });
  return {
    workspace: {
      getConfiguration: () => ({ get: (k: string, d: unknown) => (k === "storyWorktrees.autoMarkCurrent" ? h.setting : d) }),
      get workspaceFolders() {
        return h.folders;
      },
      getWorkspaceFolder: (u: { fsPath: string }) => h.folders.find((f) => u.fsPath.startsWith(f.uri.fsPath)),
      onDidSaveTextDocument: on("save"),
      onDidChangeTextDocument: on("change"),
      onDidChangeWorkspaceFolders: on("folders"),
      createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, dispose() {} }),
    },
    window: {
      state: { focused: false },
      activeTextEditor: undefined,
      onDidChangeWindowState: on("window"),
      onDidChangeActiveTextEditor: on("editor"),
      showInformationMessage: vi.fn(async (m: string) => (h.infos.push(m), h.answers.shift())),
    },
    Uri: { file: (p: string) => ({ fsPath: p, scheme: "file" }) },
    RelativePattern: class {},
    EventEmitter: class {
      event = () => ({ dispose() {} });
      fire() {}
    },
  };
});

vi.mock("../src/cli", () => ({ makeRunner: () => async () => "{}", readJson: async () => ({}) }));

const { StarTracker } = await import("../src/storyUi");

function worktree(branch: string) {
  const root = mkdtempSync(join(tmpdir(), "story-ui-"));
  const common = join(root, "repo", ".git");
  mkdirSync(join(common, "worktrees", "wt"), { recursive: true });
  const dir = join(root, "wt");
  mkdirSync(dir);
  writeFileSync(join(dir, ".git"), `gitdir: ${join(common, "worktrees", "wt")}\n`);
  writeFileSync(join(common, "worktrees", "wt", "commondir"), "../..\n");
  writeFileSync(join(common, "worktrees", "wt", "HEAD"), `ref: refs/heads/${branch}\n`);
  return { dir, file: storyWorktreesFile(common) };
}

describe("the star follows where you work (tracker, simulated events)", () => {
  let t = Date.parse("2026-11-20T09:00:00Z");
  beforeEach(() => {
    h.answers = [];
    h.infos = [];
    h.setting = "ask";
  });

  const setup = () => {
    const w = worktree("feature/7-export-v2");
    updateStoryWorktrees(w.file, (d) => linkBranch(linkBranch(d, { storyId: 7, branch: "feature/7-export", current: true }, t - 5 * 86_400_000), { storyId: 7, branch: "feature/7-export-v2" }, t - 5 * 86_400_000));
    h.folders = [{ uri: { fsPath: w.dir, scheme: "file" } }];
    const tracker = new StarTracker({ cwd: () => w.dir, log: () => {} }, () => t);
    tracker.start();
    const saves = (n: number) => {
      for (let i = 0; i < n; i++) {
        t += 60_000;
        h.listeners.save({ uri: { fsPath: join(w.dir, "a.ts"), scheme: "file" } });
      }
    };
    return { w, tracker, saves };
  };

  it("ask: one question; Yes moves the star in the shared file", async () => {
    const { w, tracker, saves } = setup();
    h.answers.push("Yes");
    saves(12);
    tracker.flush();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.infos).toEqual(["You mostly work in feature/7-export-v2. Mark it as the current ★ for story 7?"]);
    const d = readStoryWorktrees(w.file);
    expect(d.branches["feature/7-export-v2"].status).toBe("current");
    expect(d.branches["feature/7-export"].status).toBe("old");
    tracker.dispose();
  });

  it("No is remembered: no new question until the pattern is clearly stronger", async () => {
    const { w, tracker, saves } = setup();
    h.answers.push("No");
    saves(12);
    tracker.flush();
    await new Promise((r) => setTimeout(r, 10));
    expect(readStoryWorktrees(w.file).branches["feature/7-export-v2"].declinedScore).toBeGreaterThan(8);
    saves(2);
    tracker.flush();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.infos).toHaveLength(1);
    tracker.dispose();
  });

  it("auto: moves the star itself and says so with Undo; off: never", async () => {
    const a = setup();
    h.setting = "auto";
    a.saves(12);
    a.tracker.flush();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.infos[0]).toContain("★ moved to feature/7-export-v2");
    expect(readStoryWorktrees(a.w.file).branches["feature/7-export-v2"].status).toBe("current");
    a.tracker.dispose();
    h.infos = [];
    const b = setup();
    h.setting = "off";
    b.saves(30);
    b.tracker.flush();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.infos).toEqual([]);
    expect(readStoryWorktrees(b.w.file).branches["feature/7-export"].status).toBe("current");
    b.tracker.dispose();
  });

  it("writes nothing for a branch that is not linked to a story", async () => {
    const w = worktree("main");
    h.folders = [{ uri: { fsPath: w.dir, scheme: "file" } }];
    const tracker = new StarTracker({ cwd: () => w.dir, log: () => {} }, () => t);
    tracker.start();
    h.listeners.save({ uri: { fsPath: join(w.dir, "a.ts"), scheme: "file" } });
    tracker.flush();
    expect(readStoryWorktrees(w.file)).toEqual(emptyStoryWorktrees());
    tracker.dispose();
  });
});
