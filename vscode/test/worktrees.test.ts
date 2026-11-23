import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanUpCandidate, createSet, createStatusCache, lossSummary, mergedWorktrees, pushSet, removeSet, setStatuses, syncSet } from "../src/worktrees/service";
import { findRepos } from "../src/worktrees/core";
import { readSet } from "../src/worktrees/sets";
import { git, sh, write } from "./gitHelpers";

/** Repos (each with an origin on staging) below one folder; two by default. */
function twoRepos(names = ["alpha", "beta"]) {
  const root = mkdtempSync(join(tmpdir(), "aihub-wt-"));
  const repos = names.map((name) => {
    const origin = join(root, `${name}.git`);
    mkdirSync(origin);
    sh(origin, "init", "--bare", "-b", "staging");
    const work = join(root, "repos", name);
    mkdirSync(join(root, "repos"), { recursive: true });
    sh(root, "clone", origin, work);
    sh(work, "switch", "-c", "staging");
    write(work, "f.txt", `${name}\n`);
    sh(work, "add", "-A");
    sh(work, "commit", "-m", "init");
    sh(work, "push", "-u", "origin", "staging");
    return { name, path: work, root: join(root, "repos") };
  });
  return { root, repos, sets: join(root, "sets") };
}

/** staging takes the feature branch and moves on (a merge commit), as after a completed PR. */
function merge(repo: string) {
  sh(repo, "fetch");
  sh(repo, "merge", "--no-ff", "-m", "merge feature", "origin/feature/10-m");
  sh(repo, "push", "origin", "staging");
}

describe("worktree sets", () => {
  it("scans repositories", async () => {
    const w = twoRepos();
    expect((await findRepos([join(w.root, "repos")], 1)).map((r) => r.name).sort()).toEqual(["alpha", "beta"]);
  });

  it("creates a set with one worktree per repo, a set file and a workspace file", async () => {
    const w = twoRepos();
    const r = await createSet(git, { root: w.sets, branch: "feature/7-export", base: "staging", remote: "origin", repos: w.repos });
    expect(r.outcomes.map((o) => o.status)).toEqual(["ok", "ok"]);
    expect(r.set?.repos.map((x) => x.name).sort()).toEqual(["alpha", "beta"]);
    const folder = join(w.sets, "feature-7-export");
    expect(existsSync(join(folder, "alpha", "f.txt"))).toBe(true);
    expect(existsSync(join(folder, ".worktree-set.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(folder, "feature-7-export.code-workspace"), "utf8")).folders).toHaveLength(2);
    expect(sh(join(folder, "alpha"), "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("feature/7-export");
  });

  it("adds a repository to an existing set", async () => {
    const w = twoRepos();
    await createSet(git, { root: w.sets, branch: "feature/8-a", base: "staging", remote: "origin", repos: [w.repos[0]] });
    const r = await createSet(git, { root: w.sets, branch: "feature/8-a", base: "staging", remote: "origin", repos: [w.repos[1]] });
    expect(r.set?.repos).toHaveLength(2);
  });

  it("pushes the set, syncs it, and reports status", async () => {
    const w = twoRepos();
    const { set } = await createSet(git, { root: w.sets, branch: "feature/9-p", base: "staging", remote: "origin", repos: w.repos });
    write(set!.repos[0].path, "new.txt", "n");
    sh(set!.repos[0].path, "add", "-A");
    sh(set!.repos[0].path, "commit", "-m", "work");
    const before = await setStatuses(git, "origin", set!);
    expect(before.find((s) => s.name === "alpha")?.unpushed).toBe(1);
    expect(lossSummary(before)).toEqual(["alpha: 1 commit(s) not pushed"]);
    expect((await pushSet(git, set!, "origin")).map((x) => x.status)).toEqual(["ok", "ok"]);
    expect(lossSummary(await setStatuses(git, "origin", set!))).toEqual([]);
    expect((await syncSet(git, set!, "origin")).map((x) => x.status)).toEqual(["ok", "ok"]);
  });

  it("finds merged worktrees and cleans them up, keeping dirty ones", async () => {
    const w = twoRepos();
    const { set } = await createSet(git, { root: w.sets, branch: "feature/10-m", base: "staging", remote: "origin", repos: [w.repos[0]] });
    const wt = set!.repos[0].path;
    write(wt, "m.txt", "m");
    sh(wt, "add", "-A");
    sh(wt, "commit", "-m", "m");
    sh(wt, "push", "-u", "origin", "feature/10-m");
    expect(await mergedWorktrees(git, [w.repos[0]], "origin", ["staging"])).toHaveLength(0);
    sh(w.repos[0].path, "fetch");
    merge(w.repos[0].path);
    const found = await mergedWorktrees(git, [w.repos[0]], "origin", ["staging"]);
    expect(found).toHaveLength(1);
    expect(found[0].label).toContain("merged into staging");
    write(wt, "dirty.txt", "x");
    expect((await cleanUpCandidate(git, found[0])).ok).toBe(false);
    expect(existsSync(wt)).toBe(true);
    sh(wt, "add", "-A");
    sh(wt, "commit", "-m", "clean");
    sh(wt, "push");
    merge(w.repos[0].path);
    const again = await mergedWorktrees(git, [w.repos[0]], "origin", ["staging"]);
    expect((await cleanUpCandidate(git, again[0])).ok).toBe(true);
    expect(existsSync(wt)).toBe(false);
  });

  it("shares one status read per set across the rows, and re-reads after clear()", async () => {
    const w = twoRepos(["alpha", "beta", "gamma"]);
    const { set } = await createSet(git, { root: w.sets, branch: "feature/12-c", base: "staging", remote: "origin", repos: w.repos });
    expect(set!.repos).toHaveLength(3);
    let calls = 0;
    const counting: typeof git = (args, cwd) => {
      calls++;
      return git(args, cwd);
    };
    const single = await setStatuses(counting, "origin", set!);
    const singleCalls = calls;
    expect(singleCalls).toBeGreaterThan(0);
    const cache = createStatusCache(counting);
    calls = 0;
    const rows = await Promise.all(set!.repos.map(() => cache.get("origin", set!)));
    expect(calls).toBe(singleCalls);
    expect(rows[0].map((s) => s.name).sort()).toEqual(["alpha", "beta", "gamma"]);
    expect(rows[0]).toEqual(single);
    calls = 0;
    await cache.get("origin", set!);
    expect(calls).toBe(0);
    cache.clear();
    await cache.get("origin", set!);
    expect(calls).toBe(singleCalls);
  });

  it("removes a set; a dirty repo blocks it without force", async () => {
    const w = twoRepos();
    const { set } = await createSet(git, { root: w.sets, branch: "feature/11-r", base: "staging", remote: "origin", repos: w.repos });
    write(set!.repos[0].path, "dirty.txt", "x");
    const blocked = await removeSet(git, set!, false);
    expect(blocked.find((r) => r.name === "alpha")?.ok).toBe(false);
    expect(existsSync(join(set!.repos[0].path, "dirty.txt"))).toBe(true);
    const fresh = (await readSet(set!.folder))!;
    const forced = await removeSet(git, fresh, true);
    expect(forced.every((r) => r.ok)).toBe(true);
    expect(existsSync(set!.repos[0].path)).toBe(false);
  });
});
