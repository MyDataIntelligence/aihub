import { git, lf, sh, world, write } from "./gitHelpers";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { branchChangedFiles, checkConflicts, commitsAhead, defaultTarget, filesDifferingFrom, parseConflicts, resetPathsToRef, revertToMergeBase, squashCommits, switchBranch, switchChoices } from "../src/gitActions";
import { createGit } from "../src/worktrees/git";

describe("git branch actions", () => {
  it("finds the default target", async () => {
    const w = world();
    expect(await defaultTarget(git, w.work)).toBe("origin/staging");
  });

  it("resets files to a ref, and removes files that do not exist there", async () => {
    const w = world();
    expect(await filesDifferingFrom(git, w.work, "origin/staging", ["a.txt", "new.txt"])).toEqual(["a.txt", "new.txt"]);
    const r = await resetPathsToRef(git, w.work, "origin/staging", ["a.txt", "new.txt"]);
    expect(r.ok).toBe(true);
    expect(lf(readFileSync(join(w.work, "a.txt"), "utf8"))).toBe("a\n");
    expect(existsSync(join(w.work, "new.txt"))).toBe(false);
  });

  it("detects merge conflicts without touching the working tree", async () => {
    const w = world();
    write(w.seed, "a.txt", "a on staging\n");
    sh(w.seed, "commit", "-am", "staging edit");
    sh(w.seed, "push");
    sh(w.work, "fetch");
    const before = sh(w.work, "status", "--porcelain");
    const c = await checkConflicts(git, w.work, "origin/staging");
    expect(c.clean).toBe(false);
    expect(c.files).toEqual(["a.txt"]);
    expect(sh(w.work, "status", "--porcelain")).toBe(before);
    expect(lf(readFileSync(join(w.work, "a.txt"), "utf8"))).toBe("a changed\n");
  });

  it("reports no conflicts when the branches do not overlap", async () => {
    const w = world();
    write(w.seed, "b.txt", "b on staging\n");
    sh(w.seed, "commit", "-am", "staging edit b");
    sh(w.seed, "push");
    sh(w.work, "fetch");
    expect((await checkConflicts(git, w.work, "origin/staging")).clean).toBe(true);
  });

  it("parses conflict lines", () => {
    expect(parseConflicts("CONFLICT (content): Merge conflict in src/a.ts\nCONFLICT (content): Merge conflict in b.ts")).toEqual(["src/a.ts", "b.ts"]);
  });

  it("lists the branch's changed files and reverts the unrelated ones", async () => {
    const w = world();
    const files = await branchChangedFiles(git, w.work, "origin/staging");
    expect(files.map((f) => `${f.status}:${f.path}`).sort()).toEqual(["A:new.txt", "M:a.txt"]);
    const r = await revertToMergeBase(git, w.work, "origin/staging", files);
    expect(r.ok).toBe(true);
    sh(w.work, "commit", "-m", "drop unrelated");
    expect(await branchChangedFiles(git, w.work, "origin/staging")).toEqual([]);
  });

  it("squashes all commits, or only the newest ones, and needs a clean tree", async () => {
    const w = world();
    expect(await commitsAhead(git, w.work, "origin/staging")).toBe(2);
    write(w.work, "dirty.txt", "x");
    expect((await squashCommits(git, w.work, "origin/staging", "msg")).ok).toBe(false);
    sh(w.work, "add", "-A");
    sh(w.work, "commit", "-m", "third");
    const r = await squashCommits(git, w.work, "origin/staging", "3 stories in one", 2);
    expect(r.ok).toBe(true);
    expect(await commitsAhead(git, w.work, "origin/staging")).toBe(2);
    const all = await squashCommits(git, w.work, "origin/staging", "one");
    expect(all.message).toContain("Squashed 2");
    expect(await commitsAhead(git, w.work, "origin/staging")).toBe(1);
    expect(sh(w.work, "log", "-1", "--format=%s").trim()).toBe("one");
    expect((await squashCommits(git, w.work, "origin/staging", "again")).ok).toBe(false);
  });

  it("switches to a local branch and to a remote-only branch", async () => {
    const w = world();
    sh(w.seed, "switch", "-c", "feature/2-y");
    sh(w.seed, "push", "-u", "origin", "feature/2-y");
    const choices = await switchChoices(git, w.work);
    expect(choices.find((c) => c.name === "feature/2-y")).toEqual({ name: "feature/2-y", remoteOnly: true });
    expect((await switchBranch(git, w.work, { name: "feature/2-y", remoteOnly: true })).ok).toBe(true);
    expect(sh(w.work, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("feature/2-y");
    expect((await switchBranch(git, w.work, { name: "staging", remoteOnly: false })).ok).toBe(true);
  });
});
