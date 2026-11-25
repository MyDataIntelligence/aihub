import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sh, write } from "./gitHelpers";

const h = vi.hoisted(() => ({
  cliCalls: [] as { args: string[]; cwd: string }[],
  messages: [] as string[],
  folder: "",
}));

vi.mock("vscode", () => ({
  window: {
    showWarningMessage: async (m: string) => void h.messages.push(m),
    showInformationMessage: async (m: string) => void h.messages.push(m),
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
});
