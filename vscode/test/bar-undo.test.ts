import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { patchOfWork } from "../../cli/src/lib/workBackup";
import { gitRun } from "../src/bar/ownWindow";
import { newBackups, planUndo, runUndo, takeSnapshot } from "../src/bar/undo";
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
