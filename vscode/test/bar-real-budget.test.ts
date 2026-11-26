import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { sh, write } from "./gitHelpers";

/**
 * The honest count: the real registerBar (the real engine, watchers, git hook, undo, the behind manager) on temporary git
 * repositories, with EVERY child process that any code under test starts counted (spawn, spawnSync, execFile, execFileSync,
 * exec, execSync, fork), also through cli/src/lib. The windows API is a small fake; the watchers are captured so the test
 * can fire them like VS Code does. `aihub` itself is not run: each call is counted as one start.
 */
const h = vi.hoisted(() => ({
  on: false,
  starts: [] as string[],
  aihub: [] as string[],
  watchers: [] as { base: string; glob: string; change: (() => void)[]; create: (() => void)[] }[],
  gitListeners: new Map<string, (() => void)[]>(),
  commands: new Map<string, (...a: unknown[]) => unknown>(),
  folders: [] as string[],
  repoPaths: [] as string[],
  focused: true,
  fired: 0,
  gitChanges: {} as Record<string, number>,
  openListeners: [] as (() => void)[],
  focusListeners: [] as ((s: { focused: boolean }) => void)[],
}));

vi.mock("node:child_process", async (orig) => {
  const m = await orig<typeof import("node:child_process")>();
  const count = (kind: string, a: unknown[]) => {
    if (!h.on) return;
    const args = Array.isArray(a[1]) ? (a[1] as string[]).join(" ") : "";
    h.starts.push(`${kind} ${String(a[0])} ${args}`.trim());
  };
  const wrap = <T extends (...a: any[]) => unknown>(kind: string, f: T): T => ((...a: unknown[]) => (count(kind, a), f(...a))) as unknown as T;
  const execFile = ((...a: unknown[]) => (count("execFile", a), (m.execFile as never as (...x: unknown[]) => unknown)(...a))) as unknown as typeof m.execFile;
  // promisify(execFile) must still resolve { stdout, stderr }, and count once
  const plain = (...a: unknown[]) => new Promise((res, rej) => (m.execFile as never as (...x: unknown[]) => void)(...a, (e: Error | null, stdout: string, stderr: string) => (e ? rej(e) : res({ stdout, stderr }))));
  Object.defineProperty(execFile, promisify.custom, { value: (...a: unknown[]) => (count("execFile", a), plain(...a)) });
  return { ...m, execFile, execFileSync: wrap("execFileSync", m.execFileSync as never), spawn: wrap("spawn", m.spawn as never), spawnSync: wrap("spawnSync", m.spawnSync as never), exec: wrap("exec", m.exec as never), execSync: wrap("execSync", m.execSync as never), fork: wrap("fork", m.fork as never) };
});

// the old status bar reads `aihub bar` (one node process, which itself starts 9 git: measured on a repository with an Azure DevOps remote); counted as one aihub start
vi.mock("../src/cli", async (orig) => {
  const m = await orig<typeof import("../src/cli")>();
  return {
    ...m,
    makeRunner: () => async (args: string[]) => {
      if (h.on) h.aihub.push(`aihub(old status bar) ${args.join(" ")}`);
      return args[0] === "--version" ? "99.0.0" : args[0] === "bar" ? JSON.stringify({ status: { branch: "feature/5-y", signedIn: true, pr: null }, checks: null, watching: false, events: [] }) : "{}";
    },
  };
});

vi.mock("../src/bar/runner", () => ({
  cli: async (args: string[]) => (h.on && h.aihub.push(`aihub ${args.join(" ")}`), "[]"),
  runner: () => async (args: string[]) => (h.on && h.aihub.push(`aihub ${args.join(" ")}`), "[]"),
  jsonOf: (t: string) => JSON.parse(t.slice(t.indexOf("{"))),
}));

vi.mock("vscode", () => {
  class EventEmitter {
    private l: (() => void)[] = [];
    event = (f: () => void) => (this.l.push(f), { dispose: () => undefined });
    fire() {
      h.fired++;
      this.l.slice().forEach((f) => f());
    }
    dispose() {}
  }
  const none = () => ({ dispose: () => undefined });
  return {
    EventEmitter,
    Uri: { file: (p: string) => ({ fsPath: p, scheme: "file" }), joinPath: (u: { fsPath: string }, ...p: string[]) => ({ fsPath: [u.fsPath, ...p].join("/") }) },
    RelativePattern: class {
      constructor(public base: { fsPath: string } | string, public pattern: string) {}
    },
    ProgressLocation: { Notification: 15 },
    ConfigurationTarget: { Global: 1 },
    QuickPickItemKind: { Separator: -1 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ThemeColor: class {},
    MarkdownString: class {},
    window: {
      createOutputChannel: () => ({ appendLine: () => undefined, dispose: () => undefined }),
      createStatusBarItem: () => ({ show: () => undefined, hide: () => undefined, dispose: () => undefined }),
      registerWebviewViewProvider: none,
      onDidChangeActiveTextEditor: none,
      activeTextEditor: undefined,
      get state() {
        return { focused: h.focused };
      },
      onDidChangeWindowState: (f: (s: { focused: boolean }) => void) => (h.focusListeners.push(f), { dispose: () => undefined }),
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined,
      withProgress: async (_o: unknown, f: () => unknown) => f(),
    },
    commands: { registerCommand: (id: string, f: (...a: unknown[]) => unknown) => (h.commands.set(id, f), { dispose: () => undefined }), executeCommand: async () => undefined },
    extensions: {
      getExtension: () => ({
        isActive: true,
        exports: {
          getAPI: () => ({
            onDidOpenRepository: (l: () => void) => (h.openListeners.push(l), { dispose: () => undefined }),
            repositories: h.repoPaths.map((p) => ({
              rootUri: { fsPath: p },
              state: {
                workingTreeChanges: Array.from({ length: h.gitChanges[p] ?? 0 }, (_x, i) => ({ uri: { fsPath: `${p}/f${i}.txt` } })),
                indexChanges: [],
                mergeChanges: [],
                HEAD: { ahead: 0 },
                onDidChange: (l: () => void) => (h.gitListeners.set(p, [...(h.gitListeners.get(p) ?? []), l]), { dispose: () => undefined }),
              },
            })),
          }),
        },
      }),
    },
    workspace: {
      get workspaceFolders() {
        return h.folders.map((f) => ({ uri: { fsPath: f, scheme: "file" } }));
      },
      workspaceFile: undefined,
      getConfiguration: () => ({ get: (_k: string, d: unknown) => d, update: async () => undefined }),
      onDidChangeWorkspaceFolders: none,
      onDidChangeConfiguration: none,
      getWorkspaceFolder: () => undefined,
      createFileSystemWatcher: (p: { base: { fsPath: string } | string; pattern: string }) => {
        const w = { base: typeof p.base === "string" ? p.base : p.base.fsPath, glob: p.pattern, change: [] as (() => void)[], create: [] as (() => void)[] };
        h.watchers.push(w);
        return { onDidChange: (f: () => void) => (w.change.push(f), none()), onDidCreate: (f: () => void) => (w.create.push(f), none()), onDidDelete: none, dispose: () => undefined };
      },
    },
    env: { clipboard: { writeText: async () => undefined } },
  };
});

import { registerBar } from "../src/bar/register";
import { Bar } from "../src/extension";
import { undoLast, withUndo } from "../src/bar/undoUi";

function world() {
  const root = mkdtempSync(join(tmpdir(), "aihub-real-budget-"));
  const folder = join(root, "sets", "5-x");
  mkdirSync(folder, { recursive: true });
  const repos = ["a", "b", "c", "d", "e"].map((n) => {
    const origin = join(root, `${n}.git`);
    mkdirSync(origin);
    sh(origin, "init", "--bare", "-b", "main");
    const source = join(root, n);
    sh(root, "clone", origin, source);
    sh(source, "switch", "-c", "main");
    write(source, "x.txt", "1\n");
    sh(source, "add", "-A");
    sh(source, "commit", "-m", "init");
    sh(source, "push", "-u", "origin", "main");
    sh(source, "switch", "-c", "staging");
    sh(source, "push", "-u", "origin", "staging");
    sh(source, "branch", "feature/5-x");
    sh(source, "branch", "feature/5-y");
    const path = join(folder, n);
    sh(source, "worktree", "add", path, "feature/5-x");
    return { name: n, source, path, origin };
  });
  const ws = join(folder, "story-5.code-workspace");
  writeFileSync(ws, JSON.stringify({ folders: repos.map((r) => ({ name: `${r.name} (feature/5-x)`, path: r.path })) }));
  writeFileSync(join(folder, ".aihub-set.json"), JSON.stringify({ story: 5, branch: "feature/5-x", workspace: ws, repos: repos.map((r) => ({ name: r.name, source: r.source, path: r.path })) }));
  return { root, folder, repos };
}

const real = { setTimeout: globalThis.setTimeout };
const wait = (ms: number) => new Promise((r) => real.setTimeout(r, ms));

describe("the real bar, every process counted (review: the measured 66 starts per branch switch)", () => {
  it("one branch switch of one repository of five, and the other phases", async () => {
    const w = world();
    const cfg = mkdtempSync(join(tmpdir(), "aihub-real-budget-cfg-"));
    Object.assign(process.env, { AIHUB_CONFIG_HOME: cfg, AIHUB_COMMON_ROOTS: "" });
    h.folders = w.repos.map((r) => r.path);
    h.repoPaths = w.repos.map((r) => r.path);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const subs: { dispose(): unknown }[] = [];
    const bar = registerBar({ subscriptions: subs } as never, { log: () => undefined } as never);
    const rows: { phase: string; git: number; aihub: number; detail: string; events: number }[] = [];
    const phase = async (name: string, run: () => Promise<void>) => {
      h.starts.length = 0;
      h.aihub.length = 0;
      h.on = true;
      const fired = h.fired;
      await run();
      await wait(600);
      h.on = false;
      const git = h.starts.filter((s) => / git( |$)/.test(s) || s.startsWith("spawn git") || s.startsWith("execFile git"));
      const by = new Map<string, number>();
      for (const s of h.starts) {
        const k = s.split(" ").slice(0, 3).join(" ");
        by.set(k, (by.get(k) ?? 0) + 1);
      }
      rows.push({ phase: name, git: h.starts.length, aihub: h.aihub.length, events: h.fired - fired, detail: [...by].map(([k, n]) => `${k} x${n}`).join(", ") });
      return git;
    };
    // what the title bar does: read the state again on every change
    bar.api.onDidChangeState(() => void bar.api.getState());
    // the old status bar of the extension, on its own refresher (it reads `aihub bar`)
    const old = new Bar({ subscriptions: subs, globalState: { get: () => undefined, update: async () => undefined }, extensionUri: { fsPath: "" } } as never);
    old.start();
    const focus = (on: boolean) => {
      h.focused = on;
      h.focusListeners.forEach((f) => f({ focused: on }));
    };
    const advance = async (ms: number) => {
      for (let t = 0; t < ms; t += 250) {
        await vi.advanceTimersByTimeAsync(250);
        await wait(40);
      }
    };

    await phase("open the window (30 s)", async () => {
      await bar.api.getState();
      await advance(30_000);
      await wait(2500);
    });
    await phase("60 s rest, with focus", async () => advance(60_000));
    focus(false);
    await phase("60 s rest, without focus", async () => advance(60_000));
    focus(true);

    // one repository changes branch outside the window (git checkout in a terminal): the watchers fire like VS Code's
    sh(w.repos[0].path, "switch", "feature/5-y");
    await phase("one repository changes branch", async () => {
      for (const x of h.watchers) if (/HEAD$/.test(x.glob) && x.base.includes(join(w.repos[0].source, ".git"))) x.change.forEach((f) => f());
      for (const f of h.gitListeners.get(w.repos[0].path) ?? []) f();
      await advance(5_000);
      await wait(1500);
    });
    // the same stand again (a saved file, a status event): nothing
    await phase("a saved file (git state event, no HEAD change)", async () => {
      for (const f of h.gitListeners.get(w.repos[0].path) ?? []) f();
      await advance(3_000);
    });
    // one action through the bar, with its Undo snapshot, on the repository that switches; the switch itself is git's and not counted
    const hooks = { changed: () => undefined, log: () => undefined, afterGit: () => undefined };
    await phase("one action: the snapshot of one repository, the switch", async () => {
      await withUndo(hooks, "Switch c to feature/5-y", w.folder, async () => {
        h.on = false;
        sh(w.repos[2].path, "switch", "feature/5-y");
        h.on = true;
        return true;
      }, { only: ["c"], message: () => "c is now on feature/5-y" });
      await advance(2_000);
    });
    await phase("Undo of that action", async () => {
      await undoLast(hooks);
      await advance(2_000);
    });
    await phase("left menu opens", async () => {
      await bar.api.getState();
      await h.commands.get("aihub.bar.measureSets")?.();
      await advance(1_000);
    });
    await phase("overview menu opens", async () => {
      await h.commands.get("aihub.bar.refreshStatus")?.();
      await advance(1_000);
    });
    console.log(["phase".padEnd(52) + "start".padStart(6) + "aihub".padStart(7) + "events".padStart(8), ...rows.map((r) => r.phase.padEnd(52) + String(r.git).padStart(6) + String(r.aihub).padStart(7) + String(r.events).padStart(8) + "   " + r.detail)].join("\n"));
    const get = (p: string) => rows.find((r) => r.phase.startsWith(p))!;
    expect(get("60 s rest").git).toBe(0);
    expect(get("a saved file").git).toBe(0);
    // the engine starts 1 git; the old status bar starts one `aihub bar` (9 git inside, measured separately): about 11 in all
    expect(get("one repository changes branch").git + get("one repository changes branch").aihub * 10).toBeLessThanOrEqual(12);
    expect(get("one repository changes branch").aihub).toBe(1);
    expect(get("60 s rest, with focus").aihub + get("60 s rest, without focus").aihub).toBe(0);
    expect(get("a saved file").aihub).toBe(0);
    expect(get("one repository changes branch").events).toBeLessThanOrEqual(2);
    expect(get("60 s rest").events).toBe(0);
    expect(get("one action").git).toBeLessThanOrEqual(2);
    expect(get("Undo of").git).toBeLessThanOrEqual(8);
    subs.forEach((s) => s.dispose());
    vi.useRealTimers();
  }, 180_000);
});

describe("a window that never has the focus (the real window of the persona test)", () => {
  it("shows how far behind the target each repository is from the refs that are there, and the right folder names, at the first state", async () => {
    const w = world();
    // two repositories are behind staging by one commit (their origin has it, fetched earlier by hand)
    for (const r of w.repos.slice(0, 2)) {
      const other = join(w.root, `${r.name}-other`);
      sh(w.root, "clone", r.origin, other);
      sh(other, "switch", "staging");
      write(other, "new.txt", "n");
      sh(other, "add", "-A");
      sh(other, "commit", "-m", "more");
      sh(other, "push", "origin", "staging");
      sh(r.source, "fetch", "origin");
    }
    // the workspace file has plain folder names (a set that was opened, never switched)
    const ws = join(w.folder, "story-5.code-workspace");
    writeFileSync(ws, JSON.stringify({ folders: w.repos.map((r) => ({ name: r.name, path: r.path })) }));
    const cfg = mkdtempSync(join(tmpdir(), "aihub-real-budget-cfg-"));
    Object.assign(process.env, { AIHUB_CONFIG_HOME: cfg, AIHUB_COMMON_ROOTS: "" });
    h.folders = w.repos.map((r) => r.path);
    h.repoPaths = w.repos.map((r) => r.path);
    h.focused = false;
    h.watchers.length = 0;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const subs: { dispose(): unknown }[] = [];
    const bar = registerBar({ subscriptions: subs } as never, { log: () => undefined } as never);
    const state = await bar.api.getState();
    expect(state.handlesBehindTarget).toBe(true);
    expect(state.repos.map((r) => [r.name, r.behindTarget])).toEqual([["a", 1], ["b", 1], ["c", 0], ["d", 0], ["e", 0]]);
    await vi.advanceTimersByTimeAsync(1_000);
    await wait(500);
    const names = (JSON.parse(readFileSync(ws, "utf8")) as { folders: { name: string }[] }).folders.map((f) => f.name);
    expect(names).toEqual(w.repos.map((r) => `${r.name} (feature/5-x)`));
    subs.forEach((s) => s.dispose());
    vi.useRealTimers();
  }, 120_000);
});

describe("the state follows the git extension of VS Code (review: the overview stayed at none yet)", () => {
  it("a repository the git extension opens later, and a change of changed files or commits ahead, reach the buttons as one event each; a saved file with the same numbers none", async () => {
    const w = world();
    const cfg = mkdtempSync(join(tmpdir(), "aihub-real-budget-cfg-"));
    Object.assign(process.env, { AIHUB_CONFIG_HOME: cfg, AIHUB_COMMON_ROOTS: "" });
    h.folders = w.repos.map((r) => r.path);
    h.repoPaths = [];
    h.gitChanges = {};
    h.gitListeners.clear();
    h.openListeners.length = 0;
    h.focused = false;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const subs: { dispose(): unknown }[] = [];
    const bar = registerBar({ subscriptions: subs } as never, { log: () => undefined } as never);
    const read = async () => (await bar.api.getState()).repos.find((r) => r.name === "a")!;
    // the git extension has no repository yet: the count comes from our one git status (the extension's numbers are not there)
    expect((await read()).changes).toBe(0);
    h.repoPaths = w.repos.map((r) => r.path);
    h.gitChanges[w.repos[0].path] = 2;
    h.openListeners.forEach((f) => f());
    bar.api.onDidChangeState(() => void read());
    const fired0 = h.fired;
    await advanceBy(1_000);
    expect(h.fired - fired0).toBe(1);
    expect((await read()).changes).toBe(2);
    // the same numbers again (a saved file): nothing
    const fired1 = h.fired;
    for (const f of h.gitListeners.get(w.repos[0].path) ?? []) f();
    await advanceBy(1_000);
    expect(h.fired - fired1).toBe(0);
    // a new uncommitted file: one event, and the number is there
    h.gitChanges[w.repos[0].path] = 3;
    for (const f of h.gitListeners.get(w.repos[0].path) ?? []) f();
    await advanceBy(1_000);
    expect(h.fired - fired1).toBe(1);
    expect((await read()).changes).toBe(3);
    subs.forEach((s) => s.dispose());
    vi.useRealTimers();
  }, 120_000);
});

async function advanceBy(ms: number) {
  for (let t = 0; t < ms; t += 250) {
    await vi.advanceTimersByTimeAsync(250);
    await wait(40);
  }
}
