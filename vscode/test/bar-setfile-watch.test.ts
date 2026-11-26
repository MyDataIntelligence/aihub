import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sh, write } from "./gitHelpers";

const h = vi.hoisted(() => ({
  cliCalls: [] as { args: string[]; cwd: string }[],
  delay: 0,
  messages: [] as string[],
  buttons: [] as string[][],
  answer: undefined as string | undefined,
  folder: "",
}));

vi.mock("vscode", () => ({
  window: {
    showWarningMessage: async (m: string, _o?: unknown, ...b: string[]) => (h.messages.push(m), h.answer ? b.find((x) => x.startsWith(h.answer!)) : undefined),
    showInformationMessage: async (m: string, ...b: string[]) => void (h.messages.push(m), h.buttons.push(b)),
    showErrorMessage: async (m: string) => void h.messages.push(m),
  },
  commands: { executeCommand: async () => undefined },
  Uri: { file: (p: string) => ({ fsPath: p, scheme: "file" }) },
  RelativePattern: class {},
  workspace: {
    createFileSystemWatcher: () => ({ onDidChange: () => undefined, onDidCreate: () => undefined, dispose: () => undefined }),
    workspaceFile: undefined,
    get workspaceFolders() {
      return [{ uri: { fsPath: h.folder } }];
    },
    getConfiguration: () => ({ get: (_k: string, d: unknown) => d }),
  },
  ProgressLocation: {},
  EventEmitter: class {},
}));

// aihub itself is not run: every call is recorded and answered like a switch that stayed in this window
vi.mock("../src/bar/runner", () => ({
  cli: async (args: string[], cwd: string) => {
    h.cliCalls.push({ args, cwd });
    if (h.delay) await new Promise((r) => setTimeout(r, h.delay));
    return JSON.stringify({ branch: "x", mode: "worktree", folder: "f", repos: [{ repo: args[args.indexOf("--repo") + 1], ok: true, state: "switched", branch: args[args.indexOf("--branch") + 1], note: "" }], opened: false, stays: "ok" });
  },
  runner: () => async () => "",
  jsonOf: (t: string) => JSON.parse(t.slice(t.indexOf("{"))),
}));

import { SetFileWatcher } from "../src/bar/setOps";

function world() {
  const root = mkdtempSync(join(tmpdir(), "aihub-watch-"));
  const origin = (n: string) => {
    const o = join(root, `${n}.git`);
    mkdirSync(o);
    sh(o, "init", "--bare", "-b", "main");
    const src = join(root, n);
    sh(root, "clone", o, src);
    sh(src, "switch", "-c", "main");
    write(src, "a.txt", "a\n");
    sh(src, "add", "-A");
    sh(src, "commit", "-m", "init");
    sh(src, "push", "-u", "origin", "main");
    for (const b of ["feature/5-x", "feature/5-x-2", "feature/5-y"]) sh(src, "branch", b);
    return src;
  };
  const folder = join(root, "sets", "5-x");
  mkdirSync(folder, { recursive: true });
  const repos = ["repo-a", "repo-b"].map((n) => {
    const src = origin(n);
    const wt = join(folder, n);
    sh(src, "worktree", "add", wt, "feature/5-x");
    return { name: n, source: src, path: wt };
  });
  const setFile = join(folder, ".aihub-set.json");
  const write2 = (rows: { name: string; branch?: string }[]) =>
    writeFileSync(setFile, JSON.stringify({ story: 5, branch: "feature/5-x", repos: repos.map((r) => ({ ...r, ...(rows.find((x) => x.name === r.name)?.branch ? { branch: rows.find((x) => x.name === r.name)!.branch } : {}) })) }, null, 2));
  write2([]);
  const read = () => JSON.parse(readFileSync(setFile, "utf8")) as { repos: { name: string; branch?: string }[] };
  h.folder = repos[0].path;
  return { repos, folder, write2, read };
}

describe("the set file watcher acts only on what changed in the file", () => {
  beforeEach(() => {
    h.cliCalls.length = 0;
    h.messages.length = 0;
    h.buttons.length = 0;
  });

  it("repo-b switched outside aihub, then repo-a switched through aihub: repo-b stays where it is, the file follows it", async () => {
    const w = world();
    const watcher = new SetFileWatcher({ log: () => undefined, changed: () => undefined });
    watcher.aim();
    // git switch in a terminal: the file still says feature/5-x for repo-b
    sh(w.repos[1].path, "switch", "feature/5-y");
    // aihub.bar.switchBranch on repo-a: HEAD moved and aihub wrote the file
    sh(w.repos[0].path, "switch", "feature/5-x-2");
    w.write2([{ name: "repo-a", branch: "feature/5-x-2" }]);
    await watcher.apply();
    expect(h.cliCalls).toEqual([]);
    expect(sh(w.repos[1].path, "branch", "--show-current").trim()).toBe("feature/5-y");
    expect(w.read().repos.find((r) => r.name === "repo-b")?.branch).toBe("feature/5-y");
    expect(w.read().repos.find((r) => r.name === "repo-a")?.branch).toBe("feature/5-x-2");
    // its own write starts nothing: reading again changes nothing and calls nothing
    const bytes = readFileSync(join(w.folder, ".aihub-set.json"));
    await watcher.apply();
    expect(h.cliCalls).toEqual([]);
    expect(readFileSync(join(w.folder, ".aihub-set.json")).equals(bytes)).toBe(true);
    watcher.dispose();
  });

  it("the user changes repo-a in the file: only repo-a is switched, never repo-b, even when repo-b differs from the file", async () => {
    const w = world();
    const watcher = new SetFileWatcher({ log: () => undefined, changed: () => undefined });
    watcher.aim();
    sh(w.repos[1].path, "switch", "feature/5-y");
    w.write2([{ name: "repo-a", branch: "feature/5-x-2" }]);
    await watcher.apply();
    expect(h.cliCalls.map((c) => c.args.slice(0, 5))).toEqual([["branch", "switch", "--repo", "repo-a", "--branch"]]);
    expect(h.cliCalls[0].args).toContain("feature/5-x-2");
    expect(w.read().repos.find((r) => r.name === "repo-b")?.branch).toBe("feature/5-y");
    watcher.dispose();
  });
  it("one action gives one message: what was done in plain words, with Undo (review L)", async () => {
    const w = world();
    const watcher = new SetFileWatcher({ log: () => undefined, changed: () => undefined });
    watcher.aim();
    h.messages.length = 0;
    w.write2([{ name: "repo-a", branch: "feature/5-x-2" }]);
    await watcher.apply();
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]).toContain("repo-a switched to feature/5-x-2");
    expect(h.buttons[0]).toContain("Undo");
    watcher.dispose();
  });

  it("the window was closed while repo-b was switched: the first change in the file afterwards does not switch it back", async () => {
    const w = world();
    // closed window: nobody watched; git switch in a terminal
    sh(w.repos[1].path, "switch", "feature/5-y");
    const watcher = new SetFileWatcher({ log: () => undefined, changed: () => undefined });
    watcher.aim();
    sh(w.repos[0].path, "switch", "feature/5-x-2");
    w.write2([{ name: "repo-a", branch: "feature/5-x-2" }]);
    await watcher.apply();
    expect(h.cliCalls).toEqual([]);
    expect(sh(w.repos[1].path, "branch", "--show-current").trim()).toBe("feature/5-y");
    expect(w.read().repos.find((r) => r.name === "repo-b")?.branch).toBe("feature/5-y");
    watcher.dispose();
  });

  it("the other order: repo-a through aihub first, then repo-b outside aihub, then any other change of the file", async () => {
    const w = world();
    const watcher = new SetFileWatcher({ log: () => undefined, changed: () => undefined });
    watcher.aim();
    sh(w.repos[0].path, "switch", "feature/5-x-2");
    w.write2([{ name: "repo-a", branch: "feature/5-x-2" }]);
    await watcher.apply();
    sh(w.repos[1].path, "switch", "feature/5-y");
    // the story title is stamped into the file: a change of the file that is no order for anybody
    const j = JSON.parse(readFileSync(join(w.folder, ".aihub-set.json"), "utf8"));
    writeFileSync(join(w.folder, ".aihub-set.json"), JSON.stringify({ ...j, storyTitle: "Export" }, null, 2));
    await watcher.apply();
    expect(h.cliCalls).toEqual([]);
    expect(sh(w.repos[1].path, "branch", "--show-current").trim()).toBe("feature/5-y");
    watcher.dispose();
  });
});

describe("a change of the file while an apply is running is not lost (review G)", () => {
  it("the second edit is read again when the first apply is done", async () => {
    const w = world();
    h.cliCalls.length = 0;
    const watcher = new SetFileWatcher({ log: () => undefined, changed: () => undefined });
    watcher.aim();
    h.delay = 300;
    w.write2([{ name: "repo-a", branch: "feature/5-x-2" }]);
    const first = watcher.apply();
    // while the switch of repo-a runs, the user edits repo-b in the file
    await new Promise((r) => setTimeout(r, 50));
    w.write2([{ name: "repo-a", branch: "feature/5-x-2" }, { name: "repo-b", branch: "feature/5-y" }]);
    await watcher.apply();
    await first;
    await new Promise((r) => setTimeout(r, 1200));
    h.delay = 0;
    expect(h.cliCalls.map((c) => c.args[3])).toEqual(["repo-a", "repo-b"]);
    watcher.dispose();
  });
});

import { removedText } from "../src/bar/setOps";
describe("the sentence after Remove Set is never empty (persona test)", () => {
  it("the last line with words, what is kept, or a plain sentence", () => {
    expect(removedText({ lines: ["removed repo-a", "removed repo-b", ""], kept: [] })).toBe("removed repo-b");
    expect(removedText({ lines: ["  ", ""], kept: [] })).toBe("the set is removed");
    expect(removedText({ lines: [], kept: ["repo-a"] })).toBe("the set stays, repo-a hold work");
  });
});

import { openFacts } from "../src/bar/engine";
describe("an unreadable set file keeps the set (persona 4)", () => {
  it("the last good set stays with a problem flag, and a state event goes out when the file is readable again", async () => {
    const w = world();
    let changed = 0;
    const watcher = new SetFileWatcher({ log: () => undefined, changed: () => void changed++ });
    watcher.aim();
    const dir = w.repos[0].path;
    expect(openFacts(dir).set?.repos).toHaveLength(2);
    expect(openFacts(dir).setFileProblem).toBeUndefined();
    const good = readFileSync(join(w.folder, ".aihub-set.json"), "utf8");
    // the user (or a tool) leaves half a file
    writeFileSync(join(w.folder, ".aihub-set.json"), good.slice(0, 40));
    const broken = openFacts(dir);
    expect(broken.set?.repos.map((r) => r.name)).toEqual(["repo-a", "repo-b"]);
    expect(broken.repo).toBeUndefined();
    expect(broken.setFileProblem).toBe("not valid JSON");
    const before = changed;
    await watcher.apply();
    expect(changed).toBeGreaterThan(before);
    // readable again: no problem, and one more event
    writeFileSync(join(w.folder, ".aihub-set.json"), good);
    const mid = changed;
    await watcher.apply();
    expect(changed).toBeGreaterThan(mid);
    expect(openFacts(dir).setFileProblem).toBeUndefined();
    watcher.dispose();
  });
});

describe("a branch typed by hand that git does not have (persona 4)", () => {
  it("one question; Escape or Put the File Back keeps the repository where it is and puts only that line back; Create runs the switch; a remote branch is just switched to", async () => {
    const w = world();
    const watcher = new SetFileWatcher({ log: () => undefined, changed: () => undefined });
    watcher.aim();
    h.cliCalls.length = 0;
    h.messages.length = 0;
    h.answer = undefined;
    w.write2([{ name: "repo-a", branch: "feature/5-typo" }]);
    await watcher.apply();
    expect(h.messages.some((m) => m.includes("feature/5-typo does not exist in repo-a"))).toBe(true);
    expect(h.cliCalls).toEqual([]);
    expect(sh(w.repos[0].path, "branch", "--show-current").trim()).toBe("feature/5-x");
    expect(w.read().repos.find((r) => r.name === "repo-a")?.branch ?? "feature/5-x").toBe("feature/5-x");
    // Create It: the switch runs
    h.answer = "Create It";
    w.write2([{ name: "repo-a", branch: "feature/5-typo" }]);
    await watcher.apply();
    expect(h.cliCalls.map((c) => c.args[3])).toEqual(["repo-a"]);
    // a branch only the remote has: no question
    h.answer = undefined;
    h.cliCalls.length = 0;
    h.messages.length = 0;
    sh(w.repos[1].source, "push", "origin", "feature/5-y:refs/heads/only-remote");
    sh(w.repos[1].source, "fetch", "origin");
    w.write2([{ name: "repo-a" }, { name: "repo-b", branch: "only-remote" }]);
    await watcher.apply();
    expect(h.messages.some((m) => m.includes("does not exist"))).toBe(false);
    expect(h.cliCalls.map((c) => c.args[3])).toEqual(["repo-b"]);
    watcher.dispose();
  });
});
