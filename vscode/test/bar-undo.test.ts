import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { patchOfWork } from "../../cli/src/lib/workBackup";
import { gitRun } from "../src/bar/ownWindow";
import { finishSnapshot, newBackups, planUndo, runUndo, takeSnapshot } from "../src/bar/undo";
import { sh, write } from "./gitHelpers";

const NAMES = ["Repo A", "Repo B"];

function world() {
  const root = mkdtempSync(join(tmpdir(), "aihub-undo-"));
  const folder = join(root, "sets", "5-x");
  mkdirSync(folder, { recursive: true });
  const repos = NAMES.map((n) => {
    const origin = join(root, `${n}.git`);
    mkdirSync(origin);
    sh(origin, "init", "--bare", "-b", "main");
    const source = join(root, n);
    sh(root, "clone", origin, source);
    sh(source, "switch", "-c", "main");
    write(source, "a.txt", "a\n");
    write(source, ".gitignore", ".env\n");
    sh(source, "add", "-A");
    sh(source, "commit", "-m", "init");
    sh(source, "push", "-u", "origin", "main");
    for (const b of ["feature/5-x", "feature/5-y"]) sh(source, "branch", b);
    const path = join(folder, n);
    sh(source, "worktree", "add", path, "feature/5-x");
    return { name: n, source, path };
  });
  const setFile = join(folder, ".aihub-set.json");
  const ws = join(folder, "story-5.code-workspace");
  const writeSet = (rows: { name: string; source: string; path: string; branch?: string }[], wsNames?: string[]) => {
    writeFileSync(setFile, JSON.stringify({ story: 5, branch: "feature/5-x", workspace: ws, repos: rows }, null, 2));
    writeFileSync(ws, JSON.stringify({ folders: rows.map((r, i) => ({ name: wsNames?.[i] ?? `${r.name} (${r.branch ?? "feature/5-x"})`, path: r.path })) }, null, 2));
  };
  writeSet(repos);
  return { root, folder, repos, setFile, ws, writeSet };
}
type W = ReturnType<typeof world>;

/** Everything Undo promises to put back: the two files, per worktree the status and the HEAD, the worktree list and the branches of every clone. */
function fingerprint(w: W, extra: string[] = []) {
  const wt = [...w.repos.map((r) => r.path), ...extra].filter((p) => existsSync(join(p, ".git")));
  return {
    files: [w.setFile, w.ws].map((f) => (existsSync(f) ? readFileSync(f).toString("base64") : null)),
    worktrees: wt.map((p) => [p, sh(p, "status", "--porcelain").trim(), sh(p, "branch", "--show-current").trim(), existsSync(join(p, ".env")) ? readFileSync(join(p, ".env"), "utf8") : null]),
    lists: w.repos.map((r) => sh(r.source, "worktree", "list", "--porcelain").replace(/\r/g, "").split("\n").filter((l) => l.startsWith("worktree ") || l.startsWith("branch ")).sort()),
    branches: w.repos.map((r) => sh(r.source, "for-each-ref", "--format=%(refname)=%(objectname)", "refs/heads").split("\n").filter(Boolean).sort()),
  };
}

async function undo(snap: Awaited<ReturnType<typeof takeSnapshot>>) {
  finishSnapshot(snap);
  const plan = await planUndo(gitRun, snap);
  expect(plan.problem).toBeUndefined();
  const res = await runUndo(plan);
  expect(res.lines.join("\n")).not.toContain("stopped");
  expect(res.ok).toBe(true);
}

describe("Undo puts the set back exactly", () => {
  it("switch: the branch of one repository, the set file, the workspace file", async () => {
    const w = world();
    const before = fingerprint(w);
    const snap = await takeSnapshot(gitRun, w.folder, "Switch Repo A to feature/5-y");
    sh(w.repos[0].path, "switch", "feature/5-y");
    w.writeSet([{ ...w.repos[0], branch: "feature/5-y" }, w.repos[1]]);
    expect(fingerprint(w)).not.toEqual(before);
    await undo(snap);
    expect(fingerprint(w)).toEqual(before);
  });

  it("switch to a new branch: the branch it made is gone again", async () => {
    const w = world();
    const before = fingerprint(w);
    const snap = await takeSnapshot(gitRun, w.folder, "Switch Repo B to feature/5-new");
    sh(w.repos[1].path, "switch", "-c", "feature/5-new");
    w.writeSet([w.repos[0], { ...w.repos[1], branch: "feature/5-new" }]);
    await undo(snap);
    expect(fingerprint(w)).toEqual(before);
  });

  it("move: a worktree that was elsewhere goes back where it was", async () => {
    const w = world();
    const elsewhere = join(w.root, "elsewhere", "Repo A-y");
    sh(w.repos[0].source, "worktree", "add", elsewhere, "feature/5-y");
    write(elsewhere, "wip.txt", "half done\n");
    const before = fingerprint(w, [elsewhere]);
    const snap = await takeSnapshot(gitRun, w.folder, "Move Repo A--y into the set");
    const inSet = join(w.folder, "Repo A--y");
    sh(w.repos[0].source, "worktree", "move", elsewhere, inSet);
    w.writeSet([...w.repos, { name: "Repo A--y", source: w.repos[0].source, path: inSet, branch: "feature/5-y" }]);
    await undo(snap);
    expect(fingerprint(w, [elsewhere])).toEqual(before);
    expect(existsSync(inSet)).toBe(false);
  });

  it("reuse: only the files change, and come back", async () => {
    const w = world();
    const elsewhere = join(w.root, "elsewhere", "Repo A-y");
    sh(w.repos[0].source, "worktree", "add", elsewhere, "feature/5-y");
    const before = fingerprint(w, [elsewhere]);
    const snap = await takeSnapshot(gitRun, w.folder, "Reuse Repo A-y in the set");
    w.writeSet([...w.repos, { name: "Repo A-y", source: w.repos[0].source, path: elsewhere, branch: "feature/5-y" }]);
    await undo(snap);
    expect(fingerprint(w, [elsewhere])).toEqual(before);
  });

  it("recreate: the old worktree is back with its uncommitted work, untracked files and ignored files; the new one is gone", async () => {
    const w = world();
    const elsewhere = join(w.root, "elsewhere", "Repo A-y");
    sh(w.repos[0].source, "worktree", "add", elsewhere, "feature/5-y");
    write(elsewhere, "a.txt", "changed\n");
    write(elsewhere, "new.txt", "untracked\n");
    write(elsewhere, ".env", "KEY=1\n");
    const before = fingerprint(w, [elsewhere]);
    const snap = await takeSnapshot(gitRun, w.folder, "Recreate Repo A-y in the set");
    // what aihub recreate does: a patch of the work, the ignored files copied, the old worktree removed, a new one in the set
    const common = join(w.repos[0].source, ".git", "aihub", "backup");
    mkdirSync(common, { recursive: true });
    const patch = patchOfWork(elsewhere);
    if (!patch.ok) throw new Error(patch.error);
    writeFileSync(join(common, "feature-5-y-20261126-0900.patch"), patch.patch);
    mkdirSync(join(common, "Repo-A-y-20261126-0900"));
    cpSync(join(elsewhere, ".env"), join(common, "Repo-A-y-20261126-0900", ".env"));
    sh(w.repos[0].source, "worktree", "remove", "--force", elsewhere);
    const inSet = join(w.folder, "Repo A--y");
    sh(w.repos[0].source, "worktree", "add", inSet, "feature/5-y");
    w.writeSet([...w.repos, { name: "Repo A--y", source: w.repos[0].source, path: inSet, branch: "feature/5-y" }]);
    await undo(snap);
    expect(fingerprint(w, [elsewhere])).toEqual(before);
    expect(existsSync(inSet)).toBe(false);
  });

  it("add: the new worktree and the branch made for it are gone", async () => {
    const w = world();
    const before = fingerprint(w);
    const snap = await takeSnapshot(gitRun, w.folder, "Add Repo A--z to the set");
    const added = join(w.folder, "Repo A--z");
    sh(w.repos[0].source, "worktree", "add", "-b", "feature/5-z", added, "main");
    w.writeSet([...w.repos, { name: "Repo A--z", source: w.repos[0].source, path: added, branch: "feature/5-z" }]);
    await undo(snap);
    expect(fingerprint(w)).toEqual(before);
    expect(existsSync(added)).toBe(false);
  });

  it("drop: the worktree is back", async () => {
    const w = world();
    const before = fingerprint(w);
    const snap = await takeSnapshot(gitRun, w.folder, "Take Repo B out of the set");
    sh(w.repos[1].source, "worktree", "remove", w.repos[1].path);
    w.writeSet([w.repos[0]]);
    await undo(snap);
    expect(fingerprint(w)).toEqual(before);
  });

  it("remove set: the folder, the worktrees, the files and the ignored files are back; the backup is named", async () => {
    const w = world();
    write(w.repos[1].path, ".env", "SECRET=1\n");
    const before = fingerprint(w);
    const snap = await takeSnapshot(gitRun, w.folder, "Remove the set of story #5");
    const backup = join(w.repos[1].source, ".git", "aihub", "backup", "Repo-B-20261126-0900");
    mkdirSync(backup, { recursive: true });
    cpSync(join(w.repos[1].path, ".env"), join(backup, ".env"));
    for (const r of w.repos) sh(r.source, "worktree", "remove", "--force", r.path);
    rmSync(w.folder, { recursive: true, force: true });
    expect(newBackups(snap).map((b) => b.names)).toEqual([["Repo-B-20261126-0900"]]);
    await undo(snap);
    expect(fingerprint(w)).toEqual(before);
    expect(readdirSync(w.folder).sort()).toEqual([".aihub-set.json", "Repo A", "Repo B", "story-5.code-workspace"]);
  });
});

describe("Undo that cannot be done does nothing", () => {
  it("uncommitted work since the action: one sentence, no step, nothing changed", async () => {
    const w = world();
    const snap = await takeSnapshot(gitRun, w.folder, "Switch Repo A to feature/5-y");
    sh(w.repos[0].path, "switch", "feature/5-y");
    w.writeSet([{ ...w.repos[0], branch: "feature/5-y" }, w.repos[1]]);
    write(w.repos[0].path, "a.txt", "work since\n");
    const after = fingerprint(w);
    const plan = await planUndo(gitRun, snap);
    expect(plan.problem).toBe("Repo A has uncommitted changes since; commit or stash them, then undo");
    expect(plan.steps).toEqual([]);
    expect(fingerprint(w)).toEqual(after);
  });

  it("the place of a removed worktree is taken: said, nothing done", async () => {
    const w = world();
    const snap = await takeSnapshot(gitRun, w.folder, "Take Repo B out of the set");
    sh(w.repos[1].source, "worktree", "remove", w.repos[1].path);
    mkdirSync(w.repos[1].path);
    write(w.repos[1].path, "mine.txt", "somebody put this here\n");
    const plan = await planUndo(gitRun, snap);
    expect(plan.problem).toContain("is not empty now");
    expect(plan.steps).toEqual([]);
  });
});

describe("BarState.undo", () => {
  it("is there while an action can be undone, with its label", async () => {
    const { buildState } = await import("../src/bar/state");
    const base = { open: {}, scan: { at: 1, folders: [], repos: [], sets: [] }, recents: [], lookIn: [], stories: {}, exists: () => true };
    expect(buildState(base).undo).toBeUndefined();
    expect(buildState({ ...base, undo: "Switch Repo A to feature/5-y" }).undo).toEqual({ label: "Switch Repo A to feature/5-y" });
  });
});

describe("Undo for a hand edit of the set file and for Open Story", () => {
  it("a branch changed in the set file by hand: the switch goes back and the file is as it was before the edit", async () => {
    const w = world();
    const before = fingerprint(w);
    const old = readFileSync(w.setFile);
    // the user edits the file; the snapshot knows what it said at the last read
    w.writeSet([{ ...w.repos[0], branch: "feature/5-y" }, w.repos[1]]);
    const snap = await takeSnapshot(gitRun, w.folder, "Set file: Repo A to feature/5-y", { files: [{ path: w.setFile, bytes: old }] });
    sh(w.repos[0].path, "switch", "feature/5-y");
    await undo(snap);
    expect(readFileSync(w.setFile).equals(old)).toBe(true);
    expect(sh(w.repos[0].path, "branch", "--show-current").trim()).toBe("feature/5-x");
    expect(fingerprint(w).worktrees).toEqual(before.worktrees);
  });

  /** Open Story: a set that did not exist: a folder, a set file, a workspace file, a worktree on an existing branch and one on a new branch. */
  async function openStory(w: W) {
    const sources = w.repos.map((r) => r.source);
    const snap = await takeSnapshot(gitRun, "", "Open story #7", { sources });
    const folder = join(w.root, "sets", "7-new");
    mkdirSync(folder, { recursive: true });
    const a = join(folder, "Repo A");
    const b = join(folder, "Repo B");
    sh(w.repos[0].source, "worktree", "add", a, "feature/5-y");
    sh(w.repos[1].source, "worktree", "add", "-b", "feature/7-new", b, "main");
    writeFileSync(join(folder, ".aihub-set.json"), JSON.stringify({ story: 7, branch: "feature/7-new", workspace: join(folder, "story-7.code-workspace"), repos: [{ name: "Repo A", source: w.repos[0].source, path: a }, { name: "Repo B", source: w.repos[1].source, path: b }] }));
    writeFileSync(join(folder, "story-7.code-workspace"), "{}");
    snap.setFolder = folder;
    finishSnapshot(snap);
    return { snap, folder, a, b };
  }

  it("Open Story: the new worktrees, the branches it made and the set are gone; a branch that existed stays", async () => {
    const w = world();
    const before = fingerprint(w);
    const o = await openStory(w);
    await undo(o.snap);
    expect(existsSync(o.folder)).toBe(false);
    expect(fingerprint(w)).toEqual(before);
    expect(sh(w.repos[0].source, "branch", "--list", "feature/5-y")).toContain("feature/5-y");
    expect(sh(w.repos[1].source, "branch", "--list", "feature/7-new").trim()).toBe("");
  });

  it("Open Story: something changed in it since (uncommitted work, or a commit on a new branch): said, nothing done", async () => {
    const w = world();
    const o = await openStory(w);
    write(o.a, "a.txt", "later work\n");
    expect((await planUndo(gitRun, o.snap)).problem).toBe("Repo A has uncommitted changes since; commit or stash them, then undo");
    sh(o.a, "checkout", "--", "a.txt");
    write(o.b, "later.txt", "x\n");
    sh(o.b, "add", "-A");
    sh(o.b, "commit", "-m", "later");
    const plan = await planUndo(gitRun, o.snap);
    expect(plan.problem).toBe("the set changed since this action, in another window or by hand");
    // without the stamp the made branch is still protected
    delete o.snap.after;
    expect((await planUndo(gitRun, o.snap)).problem).toBe("feature/7-new has commits of its own since; they would be lost");
    expect(plan.steps).toEqual([]);
    expect(existsSync(o.b)).toBe(true);
  });
});

describe("Undo never throws away commits", () => {
  it("a branch the action made that got a commit since is not deleted: said, nothing done (was a gap in #243: the exclude pattern counted the branch itself)", async () => {
    const w = world();
    const snap = await takeSnapshot(gitRun, w.folder, "Switch Repo B to feature/5-new");
    sh(w.repos[1].path, "switch", "-c", "feature/5-new");
    write(w.repos[1].path, "later.txt", "x\n");
    sh(w.repos[1].path, "add", "-A");
    sh(w.repos[1].path, "commit", "-m", "later");
    w.writeSet([w.repos[0], { ...w.repos[1], branch: "feature/5-new" }]);
    finishSnapshot(snap);
    write(w.repos[1].path, "more.txt", "y");
    sh(w.repos[1].path, "add", "-A");
    sh(w.repos[1].path, "commit", "-m", "more");
    expect((await planUndo(gitRun, snap)).problem).toBe("the set changed since this action, in another window or by hand");
    delete snap.after;
    const plan = await planUndo(gitRun, snap);
    expect(plan.problem).toBe("feature/5-new has commits of its own since; they would be lost");
    expect(sh(w.repos[1].source, "branch", "--list", "feature/5-new")).toContain("feature/5-new");
  });
});

describe("Undo during a merge or a rebase", () => {
  it("is refused with the name of the repository, nothing done", async () => {
    const w = world();
    const snap = await takeSnapshot(gitRun, w.folder, "Switch Repo A to feature/5-y");
    sh(w.repos[0].path, "switch", "feature/5-y");
    writeFileSync(join(sh(w.repos[0].path, "rev-parse", "--absolute-git-dir").trim(), "MERGE_HEAD"), sh(w.repos[0].path, "rev-parse", "HEAD"));
    const plan = await planUndo(gitRun, snap);
    expect(plan.problem).toBe("a merge is in progress in Repo A; finish or abort it first");
    expect(plan.steps).toEqual([]);
  });
});

describe("Undo is careful with what the user keeps in the set (review C)", () => {
  it("ignored local files of a worktree that Undo takes out are saved first, by the rule of a removal", async () => {
    const w = world();
    const snap = await takeSnapshot(gitRun, w.folder, "Add Repo A--z to the set");
    const added = join(w.folder, "Repo A--z");
    sh(w.repos[0].source, "worktree", "add", "-b", "feature/5-z", added, "main");
    w.writeSet([...w.repos, { name: "Repo A--z", source: w.repos[0].source, path: added, branch: "feature/5-z" }]);
    finishSnapshot(snap);
    // build output is ignored for good (as in every real project), like .env here
    writeFileSync(join(w.repos[0].source, ".git", "info", "exclude"), "node_modules/\n");
    write(added, ".env", "KEY=1\n");
    write(added, "node_modules/x/index.js", "1");
    const plan = await planUndo(gitRun, snap);
    expect(plan.problem).toBeUndefined();
    const res = await runUndo(plan);
    expect(res.ok).toBe(true);
    expect(existsSync(added)).toBe(false);
    const backups = readdirSync(join(w.repos[0].source, ".git", "aihub", "backup"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(w.repos[0].source, ".git", "aihub", "backup", backups[0], ".env"), "utf8")).toBe("KEY=1\n");
    expect(existsSync(join(w.repos[0].source, ".git", "aihub", "backup", backups[0], "node_modules"))).toBe(false);
    expect(res.lines.join(" ")).toContain("saved in");
  });

  it("too much to save: said before anything is done", async () => {
    const w = world();
    const snap = await takeSnapshot(gitRun, w.folder, "Add Repo A--z to the set");
    const added = join(w.folder, "Repo A--z");
    sh(w.repos[0].source, "worktree", "add", "-b", "feature/5-z", added, "main");
    w.writeSet([...w.repos, { name: "Repo A--z", source: w.repos[0].source, path: added, branch: "feature/5-z" }]);
    finishSnapshot(snap);
    writeFileSync(join(added, ".env"), Buffer.alloc(51 * 1024 * 1024));
    const plan = await planUndo(gitRun, snap);
    expect(plan.problem).toContain("Repo A--z holds 1 ignored local file");
    expect(plan.problem).toContain("too big to save");
    expect(plan.steps).toEqual([]);
    expect(existsSync(added)).toBe(true);
  });

  it("a branch the user made after the action is not the action's: it stays", async () => {
    const w = world();
    const snap = await takeSnapshot(gitRun, w.folder, "Switch Repo A to feature/5-new");
    sh(w.repos[0].path, "switch", "-c", "feature/5-new");
    w.writeSet([{ ...w.repos[0], branch: "feature/5-new" }, w.repos[1]]);
    finishSnapshot(snap);
    // later the user marks a spot with a branch of their own, on a commit that exists
    sh(w.repos[0].source, "branch", "reserve", "main");
    const plan = await planUndo(gitRun, snap);
    expect(plan.problem).toBeUndefined();
    expect((await runUndo(plan)).ok).toBe(true);
    expect(sh(w.repos[0].source, "branch", "--list", "reserve")).toContain("reserve");
    expect(sh(w.repos[0].source, "branch", "--list", "feature/5-new").trim()).toBe("");
  });

  it("the branch to go back to is checked out elsewhere now: said, nothing done", async () => {
    const w = world();
    const snap = await takeSnapshot(gitRun, w.folder, "Switch Repo A to feature/5-y");
    sh(w.repos[0].path, "switch", "feature/5-y");
    w.writeSet([{ ...w.repos[0], branch: "feature/5-y" }, w.repos[1]]);
    finishSnapshot(snap);
    // feature/5-x is taken by another worktree of the same clone
    sh(w.repos[0].source, "worktree", "add", join(w.root, "elsewhere", "x"), "feature/5-x");
    const plan = await planUndo(gitRun, snap);
    expect(plan.problem).toContain("feature/5-x is checked out in");
    expect(plan.steps).toEqual([]);
  });

  it("the set changed since (another window, a hand edit): refused with one sentence, nothing done", async () => {
    const w = world();
    const snap = await takeSnapshot(gitRun, w.folder, "Switch Repo A to feature/5-y");
    sh(w.repos[0].path, "switch", "feature/5-y");
    w.writeSet([{ ...w.repos[0], branch: "feature/5-y" }, w.repos[1]]);
    finishSnapshot(snap);
    // another window adds a set to the same file
    const j = JSON.parse(readFileSync(w.setFile, "utf8"));
    writeFileSync(w.setFile, JSON.stringify({ ...j, others: [{ story: 6, branch: "feature/6-a", repos: [] }] }, null, 2));
    const plan = await planUndo(gitRun, snap);
    expect(plan.problem).toBe("the set changed since this action, in another window or by hand");
    expect(plan.steps).toEqual([]);
    expect(sh(w.repos[0].path, "branch", "--show-current").trim()).toBe("feature/5-y");
  });

  it("a step that fails says what was done and what was not (nothing is guessed back)", async () => {
    const res = await runUndo({ steps: [{ what: "one", run: async () => undefined }, { what: "two", run: async () => { throw new Error("locked"); } }, { what: "three", run: async () => undefined }] });
    expect(res).toEqual({ ok: false, lines: ["one", "stopped at \"two\": locked", "not done: three"] });
  });
});

describe("the last undo of a set lives on disk: every window shows the same one (review G)", () => {
  it("action in A, Undo in B works: B reads A's entry from the file and puts the set back", async () => {
    const { saveUndo, loadUndo, clearUndo } = await import("../src/bar/undoStore");
    const env = { AIHUB_CONFIG_HOME: mkdtempSync(join(tmpdir(), "aihub-undo-cfg-")) } as NodeJS.ProcessEnv;
    const w = world();
    const before = fingerprint(w);
    // window A
    const snapA = await takeSnapshot(gitRun, w.folder, "Switch Repo A to feature/5-y");
    sh(w.repos[0].path, "switch", "feature/5-y");
    w.writeSet([{ ...w.repos[0], branch: "feature/5-y" }, w.repos[1]]);
    finishSnapshot(snapA);
    saveUndo(env, snapA.label, snapA);
    // window B: nothing in memory, only the file
    const kept = loadUndo(env, w.folder)!;
    expect(kept.label).toBe("Switch Repo A to feature/5-y");
    expect(kept.snap.files.every((f) => f.bytes === undefined || Buffer.isBuffer(f.bytes))).toBe(true);
    const plan = await planUndo(gitRun, kept.snap);
    expect(plan.problem).toBeUndefined();
    expect((await runUndo(plan)).ok).toBe(true);
    clearUndo(env, w.folder);
    expect(fingerprint(w)).toEqual(before);
    expect(loadUndo(env, w.folder)).toBeUndefined();
  });

  it("action in A, action in B: there is one entry (B's), and A's stale snapshot is refused", async () => {
    const { saveUndo, loadUndo, undoLabelOf } = await import("../src/bar/undoStore");
    const env = { AIHUB_CONFIG_HOME: mkdtempSync(join(tmpdir(), "aihub-undo-cfg-")) } as NodeJS.ProcessEnv;
    const w = world();
    const snapA = await takeSnapshot(gitRun, w.folder, "Switch Repo A to feature/5-y");
    sh(w.repos[0].path, "switch", "feature/5-y");
    w.writeSet([{ ...w.repos[0], branch: "feature/5-y" }, w.repos[1]]);
    finishSnapshot(snapA);
    saveUndo(env, snapA.label, snapA, 1000);
    // B does its own action on the same set
    const snapB = await takeSnapshot(gitRun, w.folder, "Switch Repo B to feature/5-y");
    sh(w.repos[1].path, "switch", "feature/5-y");
    w.writeSet([{ ...w.repos[0], branch: "feature/5-y" }, { ...w.repos[1], branch: "feature/5-y" }]);
    finishSnapshot(snapB);
    saveUndo(env, snapB.label, snapB, 2000);
    expect(undoLabelOf(env, w.folder)).toBe("Switch Repo B to feature/5-y");
    expect(loadUndo(env, w.folder)!.savedAt).toBe(2000);
    // A still holds its own snapshot in memory: the set is not what it left, so it is refused
    const stale = await planUndo(gitRun, snapA);
    expect(stale.problem).toBe("the set changed since this action, in another window or by hand");
    expect(stale.steps).toEqual([]);
    // and B's entry (what both windows now show) works
    expect((await planUndo(gitRun, loadUndo(env, w.folder)!.snap)).problem).toBeUndefined();
  });

  it("the entry survives the file: Maps, bytes and the stamp come back as they were", async () => {
    const { saveUndo, loadUndo } = await import("../src/bar/undoStore");
    const env = { AIHUB_CONFIG_HOME: mkdtempSync(join(tmpdir(), "aihub-undo-cfg-")) } as NodeJS.ProcessEnv;
    const w = world();
    const snap = await takeSnapshot(gitRun, w.folder, "x");
    sh(w.repos[0].source, "branch", "made");
    finishSnapshot(snap);
    saveUndo(env, "x", snap);
    const back = loadUndo(env, w.folder)!.snap;
    expect(back.after).toEqual(snap.after);
    expect([...back.created!]).toEqual([...snap.created!]);
    expect([...back.branches.get(w.repos[0].source)!]).toEqual([...snap.branches.get(w.repos[0].source)!]);
    expect(back.files.map((f) => f.bytes?.toString("base64"))).toEqual(snap.files.map((f) => f.bytes?.toString("base64")));
  });
});
