import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { limitGit, type Git } from "../src/worktrees/git";
import { createStatusCache } from "../src/worktrees/service";
import { hasRemoteRef, parseStatusV2, type WorktreeSet } from "../src/worktrees/sets";

/**
 * The process storm of a work laptop (1519 git starts in one minute, reads of 2 minutes): every process start costs
 * ~200 ms there. Simulated here with a git that takes 200 ms per call: three sets of four repositories.
 */

const SPAWN_MS = 200;

function slowGit() {
  const calls: string[] = [];
  let running = 0;
  let maxParallel = 0;
  const git: Git = async (args) => {
    calls.push(args[0]);
    running++;
    maxParallel = Math.max(maxParallel, running);
    await new Promise((r) => setTimeout(r, SPAWN_MS));
    running--;
    return { code: 0, stdout: "# branch.oid abc\n# branch.head feature/7-x\n# branch.upstream origin/feature/7-x\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 a b src/a.py\n? notes.txt\n", stderr: "" };
  };
  return { git, calls, stats: () => ({ maxParallel }) };
}

function makeSets(n: number, repos: number): WorktreeSet[] {
  const root = mkdtempSync(join(tmpdir(), "aihub-storm-"));
  return Array.from({ length: n }, (_, s) => {
    const folder = join(root, `set${s}`);
    return {
      schemaVersion: 1,
      branch: `feature/${s}`,
      folder,
      repos: Array.from({ length: repos }, (_, r) => {
        const path = join(folder, `repo${r}`);
        mkdirSync(join(path, ".git", "refs", "remotes", "origin", "feature"), { recursive: true });
        writeFileSync(join(path, ".git", "HEAD"), `ref: refs/heads/feature/${s}\n`);
        writeFileSync(join(path, ".git", "index"), "");
        writeFileSync(join(path, ".git", "refs", "remotes", "origin", "feature", String(s)), "abc\n");
        return { name: `repo${r}`, source: path, path };
      }),
    } as WorktreeSet;
  });
}

describe("Worktree Sets on a slow machine (200 ms per process)", () => {
  it("reads the open set with one git process per repository, at most two at a time, within budget", async () => {
    const sets = makeSets(3, 4);
    const g = slowGit();
    const cache = createStatusCache(limitGit(g.git, 2));
    const t0 = Date.now();
    const first = await cache.get("origin", sets[0]); // only the set of this window is expanded
    const firstMs = Date.now() - t0;
    expect(first.map((s) => [s.currentBranch, s.dirty, s.ahead, s.behind, s.remoteBranch])).toEqual(Array(4).fill(["feature/7-x", 2, 2, 1, true]));
    expect(g.calls).toEqual(["status", "status", "status", "status"]); // was 4-5 per repository (rev-parse, status, rev-parse @{u}, rev-list, show-ref)
    expect(g.stats().maxParallel).toBeLessThanOrEqual(2);
    expect(firstMs).toBeLessThan(4 * SPAWN_MS / 2 + 600); // 4 reads, 2 at a time: about 400 ms (it was 16-20 processes at once)
  });

  it("a full redraw of three sets costs at most one process per repository, and nothing while git changed nothing", async () => {
    const sets = makeSets(3, 4);
    const g = slowGit();
    const cache = createStatusCache(limitGit(g.git, 2));
    const t0 = Date.now();
    await Promise.all(sets.map((s) => cache.get("origin", s)));
    const allMs = Date.now() - t0;
    expect(g.calls).toHaveLength(12); // per minute at most 12 processes for 12 repositories, not 1519
    expect(g.stats().maxParallel).toBeLessThanOrEqual(2);
    expect(allMs).toBeLessThan(12 * SPAWN_MS / 2 + 800);
    await Promise.all(sets.map((s) => cache.get("origin", s)));
    expect(g.calls).toHaveLength(12); // a redraw without git changes: no process
    // git touched one repository (a commit, a checkout): only that one is read again
    const later = new Date(Date.now() + 5000);
    utimesSync(join(sets[1].repos[2].path, ".git", "index"), later, later);
    await Promise.all(sets.map((s) => cache.get("origin", s)));
    expect(g.calls).toHaveLength(13);
    // a saved file in a repository: that one again
    cache.invalidate(join(sets[2].repos[0].path, "src", "a.py"));
    await cache.get("origin", sets[2]);
    expect(g.calls).toHaveLength(14);
  });
});

describe("status in one call and refs from .git", () => {
  it("parses git status --porcelain=v2 --branch", () => {
    expect(parseStatusV2("# branch.oid x\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -3\n")).toEqual({ dirty: 0, currentBranch: "main", upstream: "origin/main", ahead: 0, behind: 3 });
    expect(parseStatusV2("# branch.head (detached)\n? a\n1 M. x\n")).toEqual({ dirty: 2, currentBranch: "HEAD" });
  });

  it("finds a remote branch as a loose ref, in packed-refs, and through a linked worktree", async () => {
    const root = mkdtempSync(join(tmpdir(), "aihub-refs-"));
    const main = join(root, "main");
    mkdirSync(join(main, ".git", "refs", "remotes", "origin"), { recursive: true });
    writeFileSync(join(main, ".git", "refs", "remotes", "origin", "loose"), "abc\n");
    writeFileSync(join(main, ".git", "packed-refs"), "# pack-refs with: peeled\nabc refs/remotes/origin/feature/packed\n");
    const wtGitdir = join(main, ".git", "worktrees", "wt");
    mkdirSync(wtGitdir, { recursive: true });
    writeFileSync(join(wtGitdir, "commondir"), "../..\n");
    const wt = join(root, "wt");
    mkdirSync(wt);
    writeFileSync(join(wt, ".git"), `gitdir: ${wtGitdir}\n`);
    expect(await hasRemoteRef(main, "refs/remotes/origin/loose")).toBe(true);
    expect(await hasRemoteRef(main, "refs/remotes/origin/feature/packed")).toBe(true);
    expect(await hasRemoteRef(wt, "refs/remotes/origin/feature/packed")).toBe(true);
    expect(await hasRemoteRef(wt, "refs/remotes/origin/nope")).toBe(false);
  });
});
