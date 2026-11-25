import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildState } from "../src/bar/state";
import { allMerged, allPrsMerged, setKey, SizeMemo, sizeOfDirs } from "../src/bar/setSize";
import type { BarPr } from "../src/bar/types";

const dir = () => mkdtempSync(join(tmpdir(), "aihub-size-"));
const put = (root: string, rel: string, bytes: number) => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), Buffer.alloc(bytes));
};

describe("how much disk a set holds", () => {
  it("adds up the files of the worktrees, never follows a link, gives the loop a turn", async () => {
    const a = dir();
    const b = dir();
    const outside = dir();
    put(a, "src/x.txt", 1000);
    put(a, ".git", 24);
    put(b, "deep/er/y.bin", 500);
    put(outside, "huge.bin", 100_000);
    symlinkSync(outside, join(a, "linked"), process.platform === "win32" ? "junction" : "dir");
    for (let i = 0; i < 30; i++) put(a, `many/f${i}`, 1);
    expect(await sizeOfDirs([a, b], { yieldEvery: 5 })).toBe(1000 + 24 + 500 + 30);
    expect(await sizeOfDirs([join(a, "missing")])).toBe(0);
  });

  it("is measured once per set, again when the set changes, one run at a time, and says when each is done", async () => {
    let measured = 0;
    const memo = new SizeMemo(async (paths) => (measured++, paths.length * 100));
    const done: number[] = [];
    const sets = [{ id: "s1", key: "k1", paths: ["a", "b"] }, { id: "s2", key: "k1", paths: ["c"] }];
    expect(memo.get("s1", "k1")).toBeUndefined();
    await memo.measureAll(sets, () => done.push(done.length));
    expect([memo.get("s1", "k1"), memo.get("s2", "k1")]).toEqual([200, 100]);
    expect(done).toHaveLength(2);
    await memo.measureAll(sets, () => done.push(0));
    expect(measured).toBe(2);
    // the set changed (its key): the old size is not shown, it is measured again
    expect(memo.get("s1", "k2")).toBeUndefined();
    await memo.measureAll([{ id: "s1", key: "k2", paths: ["a"] }], () => undefined);
    expect(memo.get("s1", "k2")).toBe(100);
    // two calls at once: the second does nothing
    const slow = new SizeMemo(async () => (await new Promise((r) => setTimeout(r, 20)), 1));
    await Promise.all([slow.measureAll([{ id: "x", key: "k", paths: [] }], () => undefined), slow.measureAll([{ id: "y", key: "k", paths: [] }], () => undefined)]);
    expect(slow.get("x", "k")).toBe(1);
    expect(slow.get("y", "k")).toBeUndefined();
  });

  it("the key changes when the set file changes", () => {
    const folder = dir();
    const s = { folder, repos: [{ name: "a", path: join(folder, "a"), branch: "b", exists: true }] };
    writeFileSync(join(folder, ".aihub-set.json"), "{}");
    const before = setKey(s);
    expect(setKey(s)).toBe(before);
    utimesSync(join(folder, ".aihub-set.json"), new Date(2030, 1, 1), new Date(2030, 1, 1));
    expect(setKey(s)).not.toBe(before);
  });
});

const merged: BarPr = { id: 1, status: "merged", url: "u" };
const set = (...repos: [string, string, boolean][]) => ({ repos: repos.map(([name, branch, exists]) => ({ name, path: `/w/${name}`, branch, exists })) });

describe("all merged", () => {
  const pr = (repo: string, branch: string) => (branch === "gone" ? undefined : branch === "open" ? ({ id: 2, status: "active", url: "u" } as BarPr) : merged);

  it("every repository needs a merged pull request; a folder that is gone does not count", () => {
    expect(allPrsMerged(set(["a", "f", true], ["b", "f", true]), pr)).toBe(true);
    expect(allPrsMerged(set(["a", "f", true], ["b", "open", true]), pr)).toBe(false);
    expect(allPrsMerged(set(["a", "f", true], ["b", "gone", true]), pr)).toBe(false);
    expect(allPrsMerged(set(["a", "f", true], ["b", "gone", false]), pr)).toBe(true);
    expect(allPrsMerged(set(), pr)).toBe(false);
  });

  it("and nothing may be lost: no uncommitted file, nothing unpushed; unknown is no", async () => {
    const s = set(["a", "f", true], ["b", "f", true]);
    const facts = (changes: Record<string, number | undefined>, unpushed: Record<string, number | undefined>) => ({ pr, changes: async (p: string) => changes[p], unpushed: async (p: string) => unpushed[p] });
    expect(await allMerged(s, facts({ "/w/a": 0, "/w/b": 0 }, { "/w/a": 0, "/w/b": 0 }))).toBe(true);
    expect(await allMerged(s, facts({ "/w/a": 0, "/w/b": 2 }, { "/w/a": 0, "/w/b": 0 }))).toBe(false);
    expect(await allMerged(s, facts({ "/w/a": 0, "/w/b": 0 }, { "/w/a": 1, "/w/b": 0 }))).toBe(false);
    expect(await allMerged(s, facts({ "/w/a": 0, "/w/b": undefined }, { "/w/a": 0, "/w/b": 0 }))).toBe(false);
    expect(await allMerged(set(["a", "open", true]), facts({ "/w/a": 0 }, { "/w/a": 0 }))).toBe(false);
  });
});

describe("BarState.sets[] for the clean-up", () => {
  it("sizeBytes and allMerged per set, and the total of the sizes that are known", () => {
    const sc = (id: string, story: number) => ({ id, folder: id, story, branch: "b", repos: [{ name: "a", path: `${id}/a`, branch: "b", exists: true }] });
    const s = buildState({
      open: {},
      scan: { at: 1, folders: [], repos: [], sets: [sc("/s/1", 1), sc("/s/2", 2), sc("/s/3", 3)] },
      recents: [],
      lookIn: [],
      stories: {},
      exists: () => true,
      size: (x) => (x.id === "/s/3" ? undefined : x.id === "/s/1" ? 1000 : 2500),
      allMerged: (x) => (x.id === "/s/1" ? true : x.id === "/s/2" ? false : undefined),
    });
    expect(s.sets.map((x) => [x.id, x.sizeBytes, x.allMerged])).toEqual([["/s/1", 1000, true], ["/s/2", 2500, false], ["/s/3", undefined, undefined]]);
    expect(s.totalSizeBytes).toBe(3500);
    // nothing known yet: no total
    expect(buildState({ open: {}, scan: { at: 1, folders: [], repos: [], sets: [sc("/s/1", 1)] }, recents: [], lookIn: [], stories: {}, exists: () => true }).totalSizeBytes).toBeUndefined();
  });
});
