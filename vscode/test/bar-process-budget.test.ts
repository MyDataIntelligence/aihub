import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const c = vi.hoisted(() => ({ n: 0, calls: [] as string[] }));
vi.mock("node:child_process", async (orig) => {
  const m = await orig<typeof import("node:child_process")>();
  return { ...m, execFile: ((...a: unknown[]) => (c.n++, c.calls.push(`${String(a[0])} ${(a[1] as string[]).join(" ")}`), (m.execFile as (...x: unknown[]) => unknown)(...a))) as typeof m.execFile };
});

import { BehindMemo, PrMemo } from "../src/bar/repoStatus";
import { BehindManager, type BehindUi } from "../src/bar/behindRun";
import { BarEngine } from "../src/bar/engine";
import { gitRaw, gitRun } from "../src/bar/ownWindow";
import { SizeMemo } from "../src/bar/setSize";
import { syncRepoName } from "../../cli/src/lib/workspaceNames";
import { sh, write } from "./gitHelpers";

/** Process starts of this extension per phase, for a set of 5 repositories (2 of them behind staging). The shim counts every execFile of the code under test; the test's own git set-up is not counted. */
function world() {
  const root = mkdtempSync(join(tmpdir(), "aihub-budget-"));
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
  // two repositories are behind staging
  for (const r of repos.slice(0, 2)) {
    const other = join(root, `${r.name}-other`);
    sh(root, "clone", origin(r), other);
    sh(other, "switch", "staging");
    write(other, "new.txt", "n\n");
    sh(other, "add", "-A");
    sh(other, "commit", "-m", "more");
    sh(other, "push", "origin", "staging");
  }
  const ws = join(folder, "story-5.code-workspace");
  writeFileSync(ws, JSON.stringify({ folders: repos.map((r) => ({ name: `${r.name} (feature/5-x)`, path: r.path })) }));
  writeFileSync(join(folder, ".aihub-set.json"), JSON.stringify({ story: 5, branch: "feature/5-x", workspace: ws, repos: repos.map((r) => ({ name: r.name, source: r.source, path: r.path })) }));
  return { root, folder, ws, repos };
}
const origin = (r: { origin: string }) => r.origin;

describe("process starts per phase, a set of 5 repositories", () => {
  it("rest, typing, saving and the left menu start nothing; one branch switch starts one; the menus start at most one", async () => {
    const w = world();
    const cfg = mkdtempSync(join(tmpdir(), "aihub-budget-cfg-"));
    const behind = new BehindMemo(gitRun);
    const aihub: string[] = [];
    const prs = new PrMemo(async () => (aihub.push("aihub pr list"), []));
    const ui: BehindUi & { focused: () => boolean } = { mode: () => "ask", setAuto: async () => undefined, focused: () => state.focused, repos: () => w.repos.map((r) => ({ name: r.name, path: r.path, branch: sh(r.path, "branch", "--show-current").trim(), changes: 0 })), ask: async () => undefined, said: () => undefined, changed: (p) => behind.forget(p) };
    const state = { focused: true };
    const mgr = new BehindManager({ git: gitRun, raw: gitRaw, cli: async () => "", ui, count: (p, n) => behind.behind(p, n) });
    const engine = new BarEngine({
      env: { AIHUB_CONFIG_HOME: cfg, AIHUB_COMMON_ROOTS: "" } as NodeJS.ProcessEnv,
      dir: () => w.repos[0].path,
      dirtyOf: async () => 0,
      statusOf: async (path, name) => ({ changes: 0, ahead: 0, ...(mgr.gate.has(path) ? await behind.behind(path, name).then((n) => (n === undefined ? {} : { behindTarget: n })) : {}) }),
      sizes: new SizeMemo(async () => 1),
    });
    const phase = async (label: string, run: () => Promise<void>) => {
      const before = c.n;
      const calls = c.calls.length;
      await run();
      return { label, starts: c.n - before, aihub: aihub.length, calls: c.calls.slice(calls) };
    };
    const rows: { label: string; git: number; aihub: number }[] = [];
    const record = (r: Awaited<ReturnType<typeof phase>>) => (rows.push({ label: r.label, git: r.starts, aihub: r.aihub }), (aihub.length = 0), r);

    // the window opens: the state once, the pull requests once, the look at the target branch once
    const open = record(await phase("open the window", async () => (await engine.state(), await prs.refresh(), void (await mgr.run("open")))));
    expect(open.aihub).toBe(1);
    // 5 x fetch, 5 x rev-list (one count, shared by the state and the look), and for each of the 2 repositories behind a merge-tree (the commits are read from files, no status without uncommitted work)
    expect(open.starts).toBe(5 + 5 + 2);

    // 60 s rest with focus: nothing runs by itself; what a repeated state or a focus event would do is nothing
    const rest = record(await phase("60 s rest, with focus", async () => (await engine.state(), void (await mgr.run("focus")))));
    expect(rest.starts).toBe(0);
    // 60 s rest without focus: nothing, not even a look
    state.focused = false;
    const away = record(await phase("60 s rest, without focus", async () => void (await mgr.run("focus"), await mgr.run("menu"), await engine.state())));
    expect(away.starts).toBe(0);
    state.focused = true;
    // typing and saving: nothing of ours runs; the name follower reads files only
    const save = record(await phase("typing and saving a file", async () => void syncRepoName({ setFolder: w.folder, workspaceFile: w.ws, repoPath: w.repos[2].path })));
    expect(save.starts).toBe(0);
    // one branch switch (the switch itself is git's, not counted): the follower forgets that repository, the next state asks once
    sh(w.repos[2].path, "switch", "feature/5-y");
    const sw = record(await phase("one branch switch", async () => {
      behind.forget(w.repos[2].path);
      syncRepoName({ setFolder: w.folder, workspaceFile: w.ws, repoPath: w.repos[2].path });
      await engine.state();
    }));
    expect(sw.starts).toBe(1);
    // the left menu: the state is remembered, the sizes are measured from files
    const left = record(await phase("left menu opens", async () => (await engine.state(), await engine.measureSets(() => undefined))));
    expect(left.starts).toBe(0);
    // the overview menu: one aihub call for the pull requests; the look at the target is skipped while the last fetch is under 5 minutes old
    const over = record(await phase("overview menu opens", async () => (await prs.refresh(true), void (await mgr.run("menu")))));
    expect(over.starts + over.aihub).toBeLessThanOrEqual(1);
    console.log(["phase".padEnd(28) + "git".padStart(5) + "aihub".padStart(7), ...rows.map((r) => r.label.padEnd(28) + String(r.git).padStart(5) + String(r.aihub).padStart(7))].join("\n"));
  });
});

describe("process starts with 10 sets on the PC, and for one action and its Undo", () => {
  it("opening the left menu starts nothing on the way; the background check is at most 8 worktrees, once per 5 minutes; an action and its Undo are counted", async () => {
    const { rememberStories } = await import("../../cli/src/lib/storyCache");
    const { takeSnapshot, planUndo, runUndo } = await import("../src/bar/undo");
    const w = world();
    const cfg = mkdtempSync(join(tmpdir(), "aihub-budget-cfg-"));
    const env = { AIHUB_CONFIG_HOME: cfg, AIHUB_COMMON_ROOTS: join(w.root, "other-sets") } as NodeJS.ProcessEnv;
    // 10 more sets of closed stories, each with a worktree of repository a and b on a pushed branch, all with a merged pull request
    const stories: { id: number; title: string; state: string }[] = [];
    for (let i = 1; i <= 10; i++) {
      const folder = join(w.root, "other-sets", `${100 + i}-x`);
      mkdirSync(folder, { recursive: true });
      const rows = w.repos.slice(0, 2).map((r) => {
        const branch = `feature/${100 + i}-x`;
        const path = join(folder, r.name);
        sh(r.source, "worktree", "add", "-b", branch, path, "main");
        sh(r.source, "push", "origin", branch);
        return { name: r.name, source: r.source, path, branch };
      });
      writeFileSync(join(folder, ".aihub-set.json"), JSON.stringify({ story: 100 + i, branch: `feature/${100 + i}-x`, repos: rows.map(({ name, source, path }) => ({ name, source, path })) }));
      stories.push({ id: 100 + i, title: `Old ${i}`, state: "Closed" });
    }
    rememberStories(env, stories);
    const merged = { id: 1, status: "merged" as const, url: "u" };
    // the same memory as the extension's dirtyCounter: one git status per worktree, remembered 20 seconds
    const memo = new Map<string, Promise<number | undefined>>();
    const dirtyMemo = (p: string) => memo.get(p) ?? (memo.set(p, gitRun(p, ["status", "--porcelain"]).then((o) => o.split("\n").filter(Boolean).length, () => undefined)), memo.get(p)!);
    const engine = new BarEngine({
      env,
      dir: () => w.repos[0].path,
      dirtyOf: dirtyMemo,
      unpushedOf: async (p) => Number((await gitRun(p, ["rev-list", "--count", "HEAD", "--not", "--remotes"])).trim()),
      prOf: (_repo, branch) => (/feature\/1\d\d-x/.test(branch) ? merged : undefined),
      sizes: new SizeMemo(async () => 1),
    });
    const count = async (run: () => Promise<unknown>) => {
      const before = c.n;
      await run();
      return c.n - before;
    };
    await engine.state();
    // the left menu: the state itself starts nothing; the background check looks at no more than 8 worktrees
    const critical = await count(() => engine.state());
    expect(critical).toBe(0);
    // measureSets (the sizes, the unpushed of the other sets from the files) is part of opening the left menu: no process at all
    const background = await count(() => engine.measureSets(() => undefined));
    expect(background).toBe(0);
    // the clean-up dialog asks for the uncommitted work of the sets that can be removed: at most 8 worktrees
    const dialog = await count(() => engine.checkClean(() => undefined));
    expect(dialog).toBeLessThanOrEqual(8);
    const again = await count(async () => (await engine.state(), await engine.measureSets(() => undefined), await engine.checkClean(() => undefined)));
    // the next opening of the menu within 5 minutes: the sizes and the 8 worktrees are remembered; only the worktrees not yet looked at (the 20 are looked at 8 at a time)
    expect(again).toBeLessThanOrEqual(8);
    const st = await engine.state();
    expect(st.sets.filter((s) => s.sizeBytes !== undefined).length).toBeGreaterThan(0);
    // one action and its Undo: a snapshot before (the worktree list and the branches of each clone, the commit of each worktree), the plan and the steps of the Undo
    const snap = await (async () => {
      let s!: Awaited<ReturnType<typeof takeSnapshot>>;
      const n = await count(async () => void (s = await takeSnapshot(gitRun, w.folder, "Switch a")));
      rowsExtra.push(["action: the snapshot before it", n]);
      return s;
    })();
    sh(w.repos[0].path, "switch", "feature/5-y");
    const undoStarts = await count(async () => {
      const plan = await planUndo(gitRun, snap);
      expect(plan.problem).toBeUndefined();
      await runUndo(plan);
    });
    rowsExtra.push(["one Undo (plan and steps)", undoStarts]);
    rowsExtra.push(["left menu, 10 sets: the state", critical]);
    rowsExtra.push(["left menu, 10 sets: measureSets", background]);
    rowsExtra.push(["clean-up dialog (checkClean)", dialog]);
    rowsExtra.push(["clean-up dialog again", again]);
    console.log(rowsExtra.map(([l, n]) => `${String(l).padEnd(36)}${String(n).padStart(4)}`).join("\n"));
  });
});
const rowsExtra: [string, number][] = [];

describe("the look at the target branch blocks nothing", () => {
  it("a fetch that hangs does not hold up the state: a menu that opens meanwhile gets the old stand", async () => {
    const w = world();
    const cfg = mkdtempSync(join(tmpdir(), "aihub-budget-cfg-"));
    let release!: () => void;
    const stalled = new Promise<void>((r) => (release = r));
    const git = async (cwd: string, args: string[]) => (args[0] === "fetch" ? (await stalled, "") : gitRun(cwd, args));
    const ui: BehindUi = { mode: () => "ask", setAuto: async () => undefined, focused: () => true, repos: () => w.repos.map((r) => ({ name: r.name, path: r.path, branch: "feature/5-x", changes: 0 })), ask: async () => undefined, said: () => undefined, changed: () => undefined };
    const mgr = new BehindManager({ git, raw: gitRaw, cli: async () => "", ui });
    const engine = new BarEngine({ env: { AIHUB_CONFIG_HOME: cfg, AIHUB_COMMON_ROOTS: "" } as NodeJS.ProcessEnv, dir: () => w.repos[0].path, dirtyOf: async () => 0 });
    const running = mgr.run("open");
    const state = await Promise.race([engine.state(), new Promise<"blocked">((r) => setTimeout(() => r("blocked"), 3000))]);
    expect(state).not.toBe("blocked");
    release();
    await running;
  });
});
