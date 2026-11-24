import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { decideRow } from "../src/lib/worktreeCleanup.js";
import { ctxFor, fakeFetch, makeRepo, sh, tmp, type Route } from "./helpers.js";

/** A worktree of `dir` on a new branch, optionally pushed. */
function worktree(dir: string, branch: string, o: { push?: boolean; commit?: boolean } = {}) {
  const path = join(dirname(dir), "wt", branch.replace(/\//g, "-"));
  sh(dir, ["worktree", "add", "-b", branch, path, "main"]);
  if (o.commit !== false) {
    writeFileSync(join(path, `${branch.replace(/\//g, "-")}.txt`), "work\n");
    sh(path, ["add", "."]);
    sh(path, ["commit", "-m", branch]);
  }
  if (o.push) sh(path, ["push", "-u", "origin", branch]);
  return path;
}

const pr = (id: number, branch: string, status: string): Route => ({
  match: new RegExp(`pullrequests\\?.*searchCriteria\\.sourceRefName=refs%2Fheads%2F${encodeURIComponent(branch).replace(/%/g, "%25").replace(/%25/g, "%")}`),
  respond: () => ({ body: { value: [{ pullRequestId: id, status, sourceRefName: `refs/heads/${branch}`, creationDate: "2026-11-20T10:00:00Z" }] } }),
});
const story = (id: number, state: string): Route => ({ match: new RegExp(`_apis/wit/workitems/${id}\\?`), respond: () => ({ body: { id, fields: { "System.Title": `Story ${id}`, "System.State": state, "System.WorkItemType": "User Story" } } }) });

describe("worktree cleanup decisions", () => {
  it("preselects done work without local work, never local work", () => {
    expect(decideRow({ uncommitted: 0, unpushed: 0, pr: { id: 5, status: "completed" } })).toEqual({ reasons: ["PR !5 completed"], warning: undefined, preselected: true });
    expect(decideRow({ uncommitted: 0, unpushed: 0, story: { id: 7, state: "Closed", done: true } }).preselected).toBe(true);
    expect(decideRow({ uncommitted: 0, unpushed: 0, merged: true }).preselected).toBe(true);
    expect(decideRow({ uncommitted: 2, unpushed: 0, pr: { id: 5, status: "abandoned" } })).toEqual({ reasons: ["PR !5 abandoned"], warning: "local work: 2 uncommitted", preselected: false });
    expect(decideRow({ uncommitted: 0, unpushed: 1, merged: true }).preselected).toBe(false);
    expect(decideRow({ uncommitted: 0, unpushed: 0, pr: { id: 6, status: "active" }, story: { id: 8, state: "Active", done: false } })).toEqual({ reasons: [], warning: undefined, preselected: false });
  });
});

describe("aihub worktree cleanup", () => {
  it("lists the worktrees with PR, story, local work and merged, and preselects only finished clean ones", async () => {
    const { dir } = makeRepo();
    const done = worktree(dir, "feature/7-done", { push: true });
    const dirty = worktree(dir, "feature/8-wip", { push: true });
    writeFileSync(join(dirty, "notes.txt"), "not committed\n");
    worktree(dir, "feature/9-active", { push: true });
    const merged = worktree(dir, "feature/10-merged", { push: true });
    sh(dir, ["merge", "--ff-only", "feature/10-merged"]);
    sh(dir, ["push", "origin", "main"]);
    const unpushed = worktree(dir, "feature/11-local");
    const f = fakeFetch([pr(41, "feature/7-done", "completed"), pr(42, "feature/8-wip", "completed"), pr(43, "feature/9-active", "active"), story(7, "Closed"), story(8, "Closed"), story(9, "Active"), story(10, "Active"), story(11, "New")]);
    const { ctx, lines } = ctxFor(dir, f.fn);
    expect(await main(["worktree", "cleanup", "--json"], ctx)).toBe(0);
    const j = JSON.parse(lines.join(""));
    const by = (b: string) => j.worktrees.find((w: { branch: string }) => w.branch === b);
    expect(by("feature/7-done")).toMatchObject({ preselected: true, pr: { id: 41, status: "completed" }, story: { id: 7, state: "Closed", done: true }, uncommitted: 0, unpushed: 0 });
    expect(by("feature/7-done").reasons).toEqual(["PR !41 completed", "story 7 Closed"]);
    expect(by("feature/8-wip")).toMatchObject({ preselected: false, uncommitted: 1, warning: "local work: 1 uncommitted" });
    expect(by("feature/9-active")).toMatchObject({ preselected: false, reasons: [] });
    expect(by("feature/10-merged")).toMatchObject({ preselected: true, merged: true, reasons: ["merged"] });
    expect(by("feature/11-local")).toMatchObject({ preselected: false, unpushed: 1 });
    expect(by("feature/7-done").sizeBytes).toBeGreaterThan(0);
    expect(by("feature/7-done").lastActive).toBeGreaterThan(0);
    expect(j.preselected).toBe(2);
    void done;
    void merged;
    void unpushed;
  });

  it("removes the chosen worktrees safely: a junction inside is taken out first and its target stays", async () => {
    const { dir } = makeRepo();
    const done = worktree(dir, "feature/7-done", { push: true });
    const shared = join(tmp("shared-"), "node_modules");
    mkdirSync(join(shared, "pkg"), { recursive: true });
    writeFileSync(join(shared, "pkg", "index.js"), "module.exports = 1;\n");
    symlinkSync(shared, join(done, "node_modules"), "junction");
    writeFileSync(join(dir, ".git", "info", "exclude"), "node_modules\n");
    const dirty = worktree(dir, "feature/8-wip", { push: true });
    writeFileSync(join(dirty, "notes.txt"), "not committed\n");
    const f = fakeFetch([pr(41, "feature/7-done", "completed"), pr(42, "feature/8-wip", "completed")]);
    const { ctx, lines } = ctxFor(dir, f.fn);
    expect(await main(["worktree", "cleanup", "--json", "--remove", `${done},${dirty}`, "--delete-branch"], ctx)).toBe(0);
    const j = JSON.parse(lines.join(""));
    expect(j.removed.map((r: { branch: string; removed: boolean }) => [r.branch, r.removed])).toEqual([
      ["feature/7-done", true],
      ["feature/8-wip", false],
    ]);
    expect(j.removed[1].note).toMatch(/kept: uncommitted changes/);
    expect(j.freedBytes).toBeGreaterThan(0);
    expect(existsSync(done)).toBe(false);
    expect(existsSync(dirty)).toBe(true);
    // the junction's target was not emptied
    expect(readFileSync(join(shared, "pkg", "index.js"), "utf8")).toContain("module.exports");
    expect(sh(dir, ["worktree", "list"])).not.toContain("7-done");
  });

  it("works offline: no PR or story, only git facts", async () => {
    const { dir } = makeRepo();
    worktree(dir, "feature/7-x", { push: true });
    const f = fakeFetch([]);
    const { ctx, lines } = ctxFor(dir, f.fn);
    expect(await main(["worktree", "cleanup", "--json", "--offline", "--no-size"], ctx)).toBe(0);
    const w = JSON.parse(lines.join("")).worktrees[0];
    expect(w).toMatchObject({ branch: "feature/7-x", preselected: false });
    expect(w.pr).toBeUndefined();
    expect(w.sizeBytes).toBeUndefined();
    expect(f.calls).toHaveLength(0);
  });
});
