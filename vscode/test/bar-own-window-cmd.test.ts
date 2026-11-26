import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sh, write } from "./gitHelpers";

const h = vi.hoisted(() => ({
  picks: [] as { label: string; description?: string; kind?: number }[][],
  choose: (_rows: { label: string }[]): { label: string } | undefined => undefined,
  input: undefined as string | undefined,
  inputs: [] as { value: string }[],
  commands: [] as unknown[][],
  errors: [] as string[],
  folder: "",
}));

vi.mock("vscode", () => ({
  window: {
    showQuickPick: async (rows: { label: string; description?: string; kind?: number }[]) => (h.picks.push(rows), h.choose(rows)),
    showInputBox: async (o: { value: string }) => (h.inputs.push(o), h.input),
    showErrorMessage: async (m: string) => void h.errors.push(m),
    showWarningMessage: async (m: string) => void h.errors.push(m),
    showInformationMessage: async () => undefined,
    withProgress: async (_o: unknown, f: () => unknown) => f(),
  },
  commands: { executeCommand: async (...a: unknown[]) => void h.commands.push(a) },
  Uri: { file: (p: string) => ({ fsPath: p }) },
  workspace: {
    getConfiguration: () => ({ get: (_k: string, d: unknown) => d }),
    get workspaceFolders() {
      return [{ uri: { fsPath: h.folder } }];
    },
  },
  ProgressLocation: {},
  QuickPickItemKind: { Separator: -1 },
  EventEmitter: class {},
}));

import { registerStoryCommands } from "../src/bar/storyUi";
import { BarEngine } from "../src/bar/engine";

type Handler = (...a: unknown[]) => Promise<unknown>;

/** A bare origin, a clone "Repo With Spaces", and a story set with one worktree of it. */
function world() {
  const root = mkdtempSync(join(tmpdir(), "aihub-own-"));
  const origin = join(root, "origin.git");
  mkdirSync(origin);
  sh(origin, "init", "--bare", "-b", "main");
  const source = join(root, "Repo With Spaces");
  sh(root, "clone", origin, source);
  sh(source, "switch", "-c", "main");
  write(source, "a.txt", "a\n");
  sh(source, "add", "-A");
  sh(source, "commit", "-m", "init");
  sh(source, "push", "-u", "origin", "main");
  sh(source, "branch", "feature/5-x");
  sh(source, "branch", "feature/5-other");
  sh(source, "push", "origin", "feature/5-x", "feature/5-other");
  sh(source, "branch", "-d", "feature/5-other");
  const folder = join(root, "sets", "5-x");
  const wt = join(folder, "Repo With Spaces");
  sh(source, "worktree", "add", wt, "feature/5-x");
  const ws = join(folder, "story-5.code-workspace");
  mkdirSync(folder, { recursive: true });
  writeFileSync(ws, JSON.stringify({ folders: [{ name: "Repo With Spaces (feature/5-x)", path: "Repo With Spaces" }], settings: {} }, null, 2));
  writeFileSync(join(folder, ".aihub-set.json"), JSON.stringify({ story: 5, branch: "feature/5-x", workspace: ws, repos: [{ name: "Repo With Spaces", source, path: wt }] }, null, 2));
  const files = () => [readFileSync(ws), readFileSync(join(folder, ".aihub-set.json"))];
  return { root, source, folder, wt, ws, files };
}

function command() {
  const handlers = new Map<string, Handler>();
  const engine = new BarEngine({ env: { AIHUB_CONFIG_HOME: mkdtempSync(join(tmpdir(), "aihub-cfg-")) } as NodeJS.ProcessEnv, dir: () => h.folder, dirtyOf: async () => 0 });
  registerStoryCommands({ engine, log: () => undefined, changed: () => undefined, reg: (id, f) => void handlers.set(id, f as Handler) });
  return handlers.get("aihub.bar.openInOwnWindow")!;
}

describe("aihub.bar.openInOwnWindow", () => {
  beforeEach(() => {
    h.picks.length = 0;
    h.inputs.length = 0;
    h.commands.length = 0;
    h.errors.length = 0;
    h.input = undefined;
    h.choose = () => undefined;
  });

  it("the pick: new branch first, story and other branches, same folder last; the set's own branch is not listed twice", async () => {
    const w = world();
    h.folder = w.wt;
    h.choose = () => undefined;
    await command()({ repo: "Repo With Spaces", path: w.wt });
    const labels = h.picks[0].map((r) => r.label);
    expect(labels[0]).toBe("New branch from feature/5-x...");
    expect(labels[labels.length - 1]).toBe("Same folder, this branch (feature/5-x)");
    expect(labels).toContain("feature/5-other");
    expect(labels).not.toContain("feature/5-x");
    expect(h.picks[0][labels.length - 1].description).toBe("the same files as in the set");
  });

  it("Escape changes nothing: no window, no worktree, set and workspace file byte for byte", async () => {
    const w = world();
    h.folder = w.wt;
    const before = w.files();
    await command()({ repo: "Repo With Spaces", path: w.wt });
    expect(h.commands).toEqual([]);
    expect(w.files().every((b, i) => b.equals(before[i]))).toBe(true);
  });

  it("this branch (same folder): opens the set's folder in a new window and nothing else", async () => {
    const w = world();
    h.folder = w.wt;
    const before = w.files();
    h.choose = (rows) => rows.find((r) => r.label.startsWith("Same folder"));
    await command()({ repo: "Repo With Spaces", path: w.wt });
    expect(h.commands).toEqual([["vscode.openFolder", { fsPath: w.wt }, { forceNewWindow: true }]]);
    expect(w.files().every((b, i) => b.equals(before[i]))).toBe(true);
  });

  it("another branch without a worktree: a worktree outside the set folder, in a new window; the set is untouched", async () => {
    const w = world();
    h.folder = w.wt;
    const before = w.files();
    h.choose = (rows) => rows.find((r) => r.label === "feature/5-other");
    await command()({ repo: "Repo With Spaces", path: w.wt });
    const target = join(w.root, "Repo With Spaces-worktrees", "feature-5-other");
    expect(h.commands).toEqual([["vscode.openFolder", { fsPath: target }, { forceNewWindow: true }]]);
    expect(sh(target, "branch", "--show-current").trim()).toBe("feature/5-other");
    expect(existsSync(join(w.folder, "Repo With Spaces-worktrees"))).toBe(false);
    expect(sh(w.wt, "branch", "--show-current").trim()).toBe("feature/5-x");
    expect(w.files().every((b, i) => b.equals(before[i]))).toBe(true);
  });

  it("another branch that has a worktree elsewhere: that folder opens, nothing is made or moved, no question", async () => {
    const w = world();
    h.folder = w.wt;
    const elsewhere = join(w.root, "elsewhere", "other-wt");
    sh(w.source, "worktree", "add", elsewhere, "feature/5-other");
    const before = w.files();
    h.choose = (rows) => rows.find((r) => r.label === "feature/5-other");
    await command()({ repo: "Repo With Spaces", path: w.wt });
    expect(h.commands).toEqual([["vscode.openFolder", { fsPath: elsewhere }, { forceNewWindow: true }]]);
    expect(existsSync(join(w.root, "Repo With Spaces-worktrees"))).toBe(false);
    expect(w.files().every((b, i) => b.equals(before[i]))).toBe(true);
  });

  it("new branch: asked with a suggestion, starts at the HEAD of the set's worktree, uncommitted work stays, not pushed", async () => {
    const w = world();
    h.folder = w.wt;
    write(w.wt, "wip.txt", "half done\n");
    const tip = sh(w.wt, "rev-parse", "HEAD").trim();
    const before = w.files();
    h.choose = (rows) => rows.find((r) => r.label.startsWith("New branch from"));
    h.input = "feature/5-x-play";
    await command()({ repo: "Repo With Spaces", path: w.wt });
    expect(h.inputs[0].value).toBe("feature/5-x-copy");
    const target = join(w.root, "Repo With Spaces-worktrees", "feature-5-x-play");
    expect(h.commands).toEqual([["vscode.openFolder", { fsPath: target }, { forceNewWindow: true }]]);
    expect(sh(target, "rev-parse", "HEAD").trim()).toBe(tip);
    expect(existsSync(join(target, "wip.txt"))).toBe(false);
    expect(readFileSync(join(w.wt, "wip.txt"), "utf8")).toBe("half done\n");
    expect(sh(w.source, "branch", "-r").includes("feature/5-x-play")).toBe(false);
    // no upstream: git config --get exits non-zero
    expect(() => sh(w.source, "config", "--get", "branch.feature/5-x-play.remote")).toThrow();
    expect(w.files().every((b, i) => b.equals(before[i]))).toBe(true);
  });

  it("a failure halfway (the target folder exists) says so, opens nothing and leaves the set byte for byte", async () => {
    const w = world();
    h.folder = w.wt;
    mkdirSync(join(w.root, "Repo With Spaces-worktrees", "feature-5-other"), { recursive: true });
    write(join(w.root, "Repo With Spaces-worktrees", "feature-5-other"), "x.txt", "in the way\n");
    const before = w.files();
    h.choose = (rows) => rows.find((r) => r.label === "feature/5-other");
    await command()({ repo: "Repo With Spaces", path: w.wt });
    expect(h.commands).toEqual([]);
    expect(h.errors[0]).toContain("Nothing in the set was changed");
    expect(w.files().every((b, i) => b.equals(before[i]))).toBe(true);
  });

  it("with a branch in the argument there is no pick", async () => {
    const w = world();
    h.folder = w.wt;
    await command()({ repo: "Repo With Spaces", path: w.wt, branch: "feature/5-other" });
    expect(h.picks).toEqual([]);
    expect(h.commands).toHaveLength(1);
  });
});
