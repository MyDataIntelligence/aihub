import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addSet, addStory, emptyRecents, idArg, MAX_RECENTS, mergedMenu, mergedRecents, openMenu, publicRecents, readRecents, removeSet, setFromOpen, when } from "../src/recents";
import { storyBranchSuggestion } from "../src/repoSetModel";
import type { OpenResultJson } from "../src/repoSetModel";

const NOW = Date.parse("2026-11-24T10:00:00Z");
const res = (workspace: string, extra: Partial<OpenResultJson> = {}): OpenResultJson => ({ branch: "feature/7-x", mode: "worktree", folder: "f", workspace, opened: false, repos: [{ repo: "a", ok: true, state: "existing", branch: "feature/7-x", note: "" }, { repo: "b", ok: false, state: "failed", branch: "feature/7-x", note: "" }], ...extra });

describe("the recent list (pure)", () => {
  it("a set from an open: workspace file as id, group, story or the repositories as label; failed repositories left out", () => {
    expect(setFromOpen(res("/s/x.code-workspace", { group: "pipeline" }), NOW)).toEqual({ id: "/s/x.code-workspace", label: "pipeline", branch: "feature/7-x", repos: ["a"], lastOpened: "2026-11-24T10:00:00.000Z" });
    expect(setFromOpen(res("/s/y.code-workspace", { story: 7 }), NOW)?.label).toBe("Story 7");
    expect(setFromOpen(res("/s/z.code-workspace"), NOW)?.label).toBe("a");
    expect(setFromOpen({ ...res("x"), workspace: undefined }, NOW)).toBeUndefined();
  });

  it("newest first, no doubles (same file in another case or slash), at most 10 of each", () => {
    let r = emptyRecents();
    for (let i = 0; i < 12; i++) r = addSet(r, setFromOpen(res(`C:\\s\\${i}.code-workspace`), NOW + i)!);
    r = addSet(r, setFromOpen(res("c:/s/5.code-workspace"), NOW + 99)!);
    expect(r.sets).toHaveLength(MAX_RECENTS);
    expect(r.sets[0].id).toBe("c:/s/5.code-workspace");
    expect(r.sets.filter((s) => s.id.toLowerCase().replace(/\\/g, "/") === "c:/s/5.code-workspace")).toHaveLength(1);
    for (let i = 0; i < 12; i++) r = addStory(r, { id: i + 1, title: `T${i}` }, NOW + i);
    r = addStory(r, { id: 5, title: "" }, NOW + 50);
    expect(r.stories).toHaveLength(MAX_RECENTS);
    expect(r.stories[0]).toMatchObject({ id: 5, title: "T4" });
    expect(removeSet(r, "C:\\S\\5.code-workspace").sets.some((s) => s.id === "c:/s/5.code-workspace")).toBe(false);
  });

  it("the status bar menu: three ways to open, then the recent sets and stories with when they were opened", () => {
    let r = addSet(emptyRecents(), setFromOpen(res("/s/a.code-workspace", { group: "pipeline" }), NOW - 3 * 3_600_000)!);
    r = addStory(r, { id: 7, title: "Export bouwen" }, NOW - 86_400_000);
    const m = openMenu(r, NOW);
    expect(m.slice(0, 3).map((i) => i.value?.command)).toEqual(["aihub.openRepoSet", "aihub.newWorktreeSet", "aihub.openStory"]);
    expect(m.filter((i) => i.separator).map((i) => i.label)).toEqual(["Recent worktree sets", "Recent stories"]);
    expect(m.find((i) => i.value?.command === "aihub.openRecentSet")).toMatchObject({ label: "$(folder-library) pipeline", description: "feature/7-x · 3 h ago", value: { args: { id: "/s/a.code-workspace" } } });
    expect(m.find((i) => i.value?.command === "aihub.openRecentStory")).toMatchObject({ label: "$(book) #7 Export bouwen", description: "yesterday", value: { args: { id: 7 } } });
    expect(openMenu(emptyRecents(), NOW)).toHaveLength(3);
  });

  it("getRecents is plain data; a broken stored value is empty; {id} or a bare id", () => {
    const r = addStory(addSet(emptyRecents(), { ...setFromOpen(res("/s/a.code-workspace", { story: 7 }), NOW)! }), { id: 7, title: "X" }, NOW);
    expect(publicRecents(r)).toEqual({ sets: [{ id: "/s/a.code-workspace", label: "Story 7", branch: "feature/7-x", repos: ["a"], lastOpened: "2026-11-24T10:00:00.000Z" }], stories: [{ id: 7, title: "X", lastOpened: "2026-11-24T10:00:00.000Z" }] });
    expect(readRecents("nonsense")).toEqual(emptyRecents());
    expect(readRecents({ sets: [{ nope: 1 }], stories: [{ id: 3, title: "t", lastOpened: "x" }] }).stories).toHaveLength(1);
    expect(idArg({ id: 4 })).toBe(4);
    expect(idArg("x")).toBe("x");
    expect(when(new Date(NOW - 30_000).toISOString(), NOW)).toBe("just now");
    expect(when(new Date(NOW - 5 * 86_400_000).toISOString(), NOW)).toBe("5 d ago");
  });
});

describe("stories and sets as one list", () => {
  const H = 3_600_000;
  const build = () => {
    let r = emptyRecents();
    r = addSet(r, setFromOpen(res("/s/plain.code-workspace"), NOW - 5 * H)!);
    r = addSet(r, setFromOpen(res("/s/7.code-workspace", { story: 7 }), NOW - 2 * H)!);
    r = addStory(r, { id: 7, title: "Export bouwen" }, NOW - 3 * H);
    r = addSet(r, setFromOpen(res("/s/9.code-workspace", { story: 9 }), NOW - 1 * H)!);
    return r;
  };

  it("a set of a story is that story; rows say '#id title Â· N repos' or 'branch Â· repos'; newest first", () => {
    const m = mergedRecents(build());
    expect(m.map((i) => [i.kind, i.id, i.label, i.detail])).toEqual([
      ["story", 9, "#9", "1 repo"],
      ["story", 7, "#7 Export bouwen", "1 repo"],
      ["set", "/s/plain.code-workspace", "feature/7-x", "a"],
    ]);
    expect(m[1].lastOpened).toBe(new Date(NOW - 2 * H).toISOString());
  });

  it("the menu: New, Open, then Recent with at most 8 and More...", () => {
    let r = build();
    for (let i = 0; i < 10; i++) r = addStory(r, { id: 100 + i, title: `S${i}` }, NOW - (10 + i) * H);
    const m = mergedMenu(r, NOW);
    expect(m.slice(0, 2).map((i) => i.value?.command)).toEqual(["aihub.newWorktreeSet", "aihub.openRepoSet"]);
    const recent = m.filter((i) => i.value?.command === "aihub.openRecent");
    expect(recent).toHaveLength(8);
    expect(recent[0].value?.args).toEqual({ kind: "story", id: 9 });
    expect(m.at(-1)).toMatchObject({ label: "$(ellipsis) More...", value: { command: "aihub.openRepoSet" } });
    expect(mergedMenu(emptyRecents(), NOW)).toHaveLength(2);
  });

  it("a new set for a story gets feature/<id>-<slug>", () => {
    expect(storyBranchSuggestion({ id: 1234, title: "Zoekfunctie bouwen!" })).toBe("feature/1234-zoekfunctie-bouwen");
    expect(storyBranchSuggestion({ id: 5, title: "" })).toBe("feature/5-");
    expect(storyBranchSuggestion(undefined)).toBe("feature/");
  });
});

// ---- the public commands against a fake vscode ----

const h = vi.hoisted(() => ({ cmds: new Map<string, (...a: any[]) => any>(), executed: [] as unknown[][], warnings: [] as string[], folders: [] as unknown[], state: new Map<string, unknown>(), choose: (_labels: string[]) => undefined as string | undefined, seen: [] as string[][], input: undefined as string | undefined }));

vi.mock("vscode", () => ({
  commands: {
    registerCommand: (id: string, f: (...a: any[]) => any) => (h.cmds.set(id, f), { dispose() {} }),
    executeCommand: vi.fn(async (...a: unknown[]) => void h.executed.push(a)),
  },
  window: {
    showWarningMessage: vi.fn(async (m: string) => void h.warnings.push(m)),
    showErrorMessage: vi.fn(async (m: string) => void h.warnings.push(m)),
    showInputBox: vi.fn(async () => h.input),
    createQuickPick: () => {
      const accept: (() => void)[] = [];
      const qp: any = {
        items: [],
        activeItems: [],
        selectedItems: [],
        onDidAccept: (f: () => void) => accept.push(f),
        onDidHide: () => {},
        show() {
          // wait until the stories are appended (busy false), then answer
          const tick = () => {
            if (qp.busy) return void setTimeout(tick, 1);
            const labels = qp.items.filter((i: any) => i.kind !== -1).map((i: any) => i.label);
            h.seen.push(labels);
            const want = h.choose(labels);
            const it = qp.items.find((i: any) => i.label === want);
            if (it) qp.selectedItems = [it];
            accept.forEach((f) => f());
          };
          setTimeout(tick, 1);
        },
        hide() {},
        dispose() {},
      };
      return qp;
    },
  },
  QuickPickItemKind: { Separator: -1 },
  workspace: {
    get workspaceFolders() {
      return h.folders;
    },
  },
  Uri: { file: (p: string) => ({ fsPath: p }) },
}));
vi.mock("../src/repoSetUi", () => ({ pick: vi.fn(), setOpenRecorder: vi.fn((f) => ((h as any).recorder = f)) }));

const { RecentStore, registerRecents, rememberStory } = await import("../src/recentsUi");

describe("the public commands (for the PyCharm-style File menu)", () => {
  let store: InstanceType<typeof RecentStore>;
  const reposet = { open: vi.fn(async () => {}) };
  beforeEach(() => {
    h.cmds.clear();
    h.executed = [];
    h.warnings = [];
    h.folders = [{}];
    h.state.clear();
    store = new RecentStore({ get: (k: string) => h.state.get(k), update: async (k: string, v: unknown) => void h.state.set(k, v), keys: () => [] } as never);
    h.seen = [];
    h.input = undefined;
    registerRecents({ subscriptions: [] } as never, store, reposet as never, () => {}, async () => [{ id: 7, title: "Export bouwen", repos: 2 }, { id: 8, title: "Andere", repos: 1 }]);
  });

  it("registers the ids the other extension calls", () => {
    for (const id of ["aihub.newWorktreeSet", "aihub.openRepoSet", "aihub.openStory", "aihub.openRecent", "aihub.openRecentSet", "aihub.openRecentStory", "aihub.getRecents", "aihub.recent", "aihub.recentSets", "aihub.recentStories", "aihub.reposet.menu"]) expect(h.cmds.has(id), id).toBe(true);
  });

  it("an opened set and story land in the list that getRecents returns", async () => {
    const ws = join(mkdtempSync(join(tmpdir(), "recents-")), "pipeline.code-workspace");
    writeFileSync(ws, "{}");
    await (h as any).recorder(res(ws, { group: "pipeline" }));
    await rememberStory(store, { id: 7, title: "Export bouwen" });
    const r = await h.cmds.get("aihub.getRecents")!();
    expect(r.sets.map((s: { id: string }) => s.id)).toEqual([ws]);
    expect(r.stories.map((s: { id: number }) => s.id)).toEqual([7]);
  });

  it("openRecentSet opens the workspace file in a new window (an empty window is reused); a gone one leaves the list", async () => {
    const ws = join(mkdtempSync(join(tmpdir(), "recents-")), "pipeline.code-workspace");
    writeFileSync(ws, "{}");
    await (h as any).recorder(res(ws, { group: "pipeline" }));
    await h.cmds.get("aihub.openRecentSet")!({ id: ws });
    expect(h.executed[0]).toEqual(["vscode.openFolder", { fsPath: ws }, { forceNewWindow: true }]);
    h.folders = [];
    await h.cmds.get("aihub.openRecentSet")!(ws);
    expect(h.executed[1][2]).toEqual({ forceReuseWindow: true });
    await (h as any).recorder(res("/gone/x.code-workspace"));
    await h.cmds.get("aihub.openRecentSet")!({ id: "/gone/x.code-workspace" });
    expect(h.warnings.join()).toContain("taken off the list");
    expect((await h.cmds.get("aihub.getRecents")!()).sets.map((s: { id: string }) => s.id)).toEqual([ws]);
  });

  it("openRecentStory runs Open Story for that story; newWorktreeSet runs the repo set flow with a new branch", async () => {
    await rememberStory(store, { id: 7, title: "Export bouwen" });
    await h.cmds.get("aihub.openRecentStory")!({ id: 7 });
    expect(h.executed[0]).toEqual(["aihub.stories.open", { kind: "story", story: { id: 7, title: "Export bouwen", state: "", branches: [] } }]);
  });

  it("New Worktree Set asks 'for which story?': none, one of mine (appended when read), or a number", async () => {
    h.choose = (l) => l.find((x) => x.includes("No story"));
    await h.cmds.get("aihub.newWorktreeSet")!();
    expect(reposet.open).toHaveBeenLastCalledWith(undefined, undefined, { newBranch: true, story: undefined });
    expect(h.seen[0]).toEqual(["$(circle-slash) No story", "$(search) Story by number...", "$(book) #7 Export bouwen", "$(book) #8 Andere"]);
    h.choose = (l) => l.find((x) => x.includes("#7"));
    await h.cmds.get("aihub.newWorktreeSet")!();
    expect(reposet.open).toHaveBeenLastCalledWith(undefined, undefined, { newBranch: true, story: { id: 7, title: "Export bouwen", repos: 2 } });
    h.choose = (l) => l.find((x) => x.includes("by number"));
    h.input = "1234";
    await h.cmds.get("aihub.newWorktreeSet")!();
    expect(reposet.open).toHaveBeenLastCalledWith(undefined, undefined, { newBranch: true, story: { id: 1234, title: "" } });
  });

  it("Open Worktree Set: recent first, then my other stories; a story opens its stars", async () => {
    await rememberStory(store, { id: 7, title: "Export bouwen" });
    h.choose = (l) => l.find((x) => x.includes("#8"));
    await h.cmds.get("aihub.openRepoSet")!();
    expect(h.seen[0][0]).toContain("Repositories on a branch");
    expect(h.seen[0].filter((x) => x.includes("#7"))).toHaveLength(1);
    expect(h.executed.at(-1)).toEqual(["aihub.stories.open", { kind: "story", story: { id: 8, title: "Andere", state: "", branches: [] } }]);
  });

  it("getRecents({merged:true}) is one sorted list; openRecent opens by kind", async () => {
    const ws = join(mkdtempSync(join(tmpdir(), "recents-")), "p.code-workspace");
    writeFileSync(ws, "{}");
    await (h as any).recorder(res(ws, { group: "pipeline" }));
    await (h as any).recorder(res(join(ws, "..", "s7.code-workspace"), { story: 7 }), { storyTitle: "Export bouwen" });
    const m = await h.cmds.get("aihub.getRecents")!({ merged: true });
    expect(m.map((i: { kind: string; label: string }) => [i.kind, i.label])).toEqual([
      ["story", "#7 Export bouwen"],
      ["set", "feature/7-x"],
    ]);
    await h.cmds.get("aihub.openRecent")!({ kind: "story", id: 7 });
    expect(h.executed.at(-1)).toEqual(["aihub.openRecentStory", { id: 7 }]);
    await h.cmds.get("aihub.openRecent")!({ kind: "set", id: ws });
    expect(h.executed.at(-1)).toEqual(["aihub.openRecentSet", { id: ws }]);
  });
});
