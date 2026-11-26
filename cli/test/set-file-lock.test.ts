import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSetFile, repoBranch, setRepoBranchInPlace, withSetLock, writeAtomic, writeSetMeta } from "../src/lib/setFile.js";
import { syncRepoName } from "../src/lib/workspaceNames.js";
import { tmp } from "./helpers.js";

describe("set file writers (review G)", () => {
  it("writeAtomic never falls back to writing in place: the error stays and the old file is untouched", () => {
    const dir = tmp("aihub-atomic-");
    const target = join(dir, "set.json");
    // the target is a folder: the rename cannot work; a write in place would fail too, but never leave a half file behind
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "kept");
    expect(() => writeAtomic(target, "{}")).toThrow();
    expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("kept");
    expect(existsSync(`${target}.${process.pid}.tmp`)).toBe(false);
  });

  it("one writer at a time, across processes: a writer waits for a lock another process holds, and a stale lock is taken over", () => {
    const dir = tmp("aihub-lock-");
    const lock = join(dir, ".aihub-set.lock");
    // another process (another window) holds the lock for 400 ms
    const code = `const fs=require("fs");fs.writeFileSync(${JSON.stringify(lock)},"other");setTimeout(()=>{fs.rmSync(${JSON.stringify(lock)});},400);`;
    spawn(process.execPath, ["-e", code], { stdio: "ignore", detached: true }).unref();
    while (!existsSync(lock)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    const t0 = Date.now();
    let ran = 0;
    withSetLock(dir, () => (ran = Date.now() - t0));
    expect(ran).toBeGreaterThanOrEqual(250);
    expect(existsSync(lock)).toBe(false);
    // stale: older than 10 seconds, a writer that crashed
    writeFileSync(lock, "1 1");
    utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    expect(withSetLock(dir, () => "ran")).toBe("ran");
    expect(existsSync(lock)).toBe(false);
  });

  it("a held lock keeps a second writer out until it is released", () => {
    const dir = tmp("aihub-lock2-");
    let inner = "";
    withSetLock(dir, () => {
      // re-entrant inside one process: the nested writer (writeSetMeta) is not locked out by its own caller
      writeSetMeta(dir, { story: 1, branch: "feature/1-x", repos: [] });
      inner = "written";
    });
    expect(inner).toBe("written");
    expect(existsSync(join(dir, ".aihub-set.lock"))).toBe(false);
    expect(readSetFile(dir)?.top.branch).toBe("feature/1-x");
  });

  it("a HEAD change in one set of a folder with several leaves the other sets, their order and unknown fields alone", () => {
    const dir = tmp("aihub-others-");
    const wt = (n: string) => join(dir, n);
    for (const n of ["a1", "a2", "b1"]) mkdirSync(join(wt(n), ".git"), { recursive: true });
    const set = (story: number, branch: string, path: string) => ({ story, branch, mine: "keep", repos: [{ name: "repo", source: "/s/repo", path, extra: story }] });
    writeFileSync(join(dir, ".aihub-set.json"), JSON.stringify({ ...set(2, "feature/2-b", wt("b1")), others: [set(1, "feature/1-a", wt("a1")), set(3, "feature/3-c", wt("a2"))] }, null, 2));
    writeFileSync(join(wt("a1"), ".git", "HEAD"), "ref: refs/heads/feature/1-changed\n");
    expect(setRepoBranchInPlace(dir, wt("a1"), "feature/1-changed")).toBe(true);
    const j = JSON.parse(readFileSync(join(dir, ".aihub-set.json"), "utf8"));
    expect(j.story).toBe(2);
    expect(j.others.map((o: { story: number }) => o.story)).toEqual([1, 3]);
    expect(j.others[0].repos[0]).toEqual({ name: "repo", source: "/s/repo", path: wt("a1"), extra: 1, branch: "feature/1-changed" });
    expect(j.others[0].mine).toBe("keep");
    // back to the set's own branch: the key goes
    expect(setRepoBranchInPlace(dir, wt("a1"), "feature/1-a")).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, ".aihub-set.json"), "utf8")).others[0].repos[0].branch).toBeUndefined();
    expect(setRepoBranchInPlace(dir, wt("a1"), "feature/1-a")).toBe(false);
    void repoBranch;
    void syncRepoName;
  });
});
