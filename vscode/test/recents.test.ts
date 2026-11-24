import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addSet, addStory, emptyRecents, idArg, MAX_RECENTS, openMenu, publicRecents, readRecents, removeSet, setFromOpen, when } from "../src/recents";
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

// ---- the public commands against a fake vscode ----

const h = vi.hoisted(() => ({ cmds: new Map<string, (...a: any[]) => any>(), executed: [] as unknown[][], warnings: [] as string[], folders: [] as unknown[], state: new Map<string, unknown>() }));

vi.mock("vscode", () => ({
  commands: {
    registerCommand: (id: string, f: (...a: any[]) => any) => (h.cmds.set(id, f), { dispose() {} }),
    executeCommand: vi.fn(async (...a: unknown[]) => void h.executed.push(a)),
  },
  window: { showWarningMessage: vi.fn(async (m: string) => void h.warnings.push(m)), showErrorMessage: vi.fn(async (m: string) => void h.warnings.push(m)) },
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
    registerRecents({ subscriptions: [] } as never, store, reposet as never, () => {});
  });

  it("registers the ids the other extension calls", () => {
    for (const id of ["aihub.newWorktreeSet", "aihub.openRepoSet", "aihub.openStory", "aihub.openRecentSet", "aihub.openRecentStory", "aihub.getRecents", "aihub.recentSets", "aihub.recentStories", "aihub.reposet.menu"]) expect(h.cmds.has(id), id).toBe(true);
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
    await h.cmds.get("aihub.newWorktreeSet")!();
    expect(reposet.open).toHaveBeenCalledWith(undefined, undefined, { newBranch: true });
  });
});
