import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildState } from "../src/bar/state";
import { allMerged, allPrsMerged, measureDirs, setKey, SizeMemo, sizeOfDirs } from "../src/bar/setSize";
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

  it("is measured once a day per set, kept in a file with its time, one run at a time, and says when each is done", async () => {
    const file = join(dir(), "sizes.json");
    let clock = 1_000;
    const now = () => clock;
    let measured = 0;
    const mk = () => new SizeMemo(async (paths) => (measured++, paths.length * 100), { file, now });
    const memo = mk();
    const done: number[] = [];
    const sets = [{ id: "s1", key: "k1", paths: ["a", "b"] }, { id: "s2", key: "k1", paths: ["c"] }];
    expect(memo.get("s1", "k1")).toBeUndefined();
    await memo.measureAll(sets, () => done.push(done.length));
    expect([memo.get("s1", "k1")?.bytes, memo.get("s2", "k1")?.bytes]).toEqual([200, 100]);
    expect(memo.get("s1", "k1")?.at).toBe(1_000);
    expect(done).toHaveLength(2);
    // within the day nothing is measured again, not even by a second window or after a restart (the file)
    clock += 60_000;
    await memo.measureAll(sets, () => done.push(0));
    await mk().measureAll(sets, () => done.push(0));
    expect(measured).toBe(2);
    expect(mk().get("s1", "k1")).toEqual({ bytes: 200, at: 1_000 });
    // the user asks: measured again, within the day
    await mk().measureAll(sets, () => undefined, { force: true });
    expect(measured).toBe(4);
    // a day later: again
    clock += 25 * 3600_000;
    await mk().measureAll(sets, () => undefined);
    expect(measured).toBe(6);
    // the repositories of the set changed (its key): the old size is not shown, it is measured again
    expect(memo.get("s1", "k2")).toBeUndefined();
    await memo.measureAll([{ id: "s1", key: "k2", paths: ["a"] }], () => undefined);
    expect(memo.get("s1", "k2")?.bytes).toBe(100);
    // two calls at once: the second does nothing
    const slow = new SizeMemo(async () => (await new Promise((r) => setTimeout(r, 20)), 1));
    await Promise.all([slow.measureAll([{ id: "x", key: "k", paths: [] }], () => undefined), slow.measureAll([{ id: "y", key: "k", paths: [] }], () => undefined)]);
    expect(slow.get("x", "k")?.bytes).toBe(1);
    expect(slow.get("y", "k")).toBeUndefined();
  });

  it("measures nothing while the window has no focus, unless the user asked", async () => {
    let focus = false;
    let measured = 0;
    const memo = new SizeMemo(async () => (measured++, 1), { focused: () => focus });
    const sets = [{ id: "s", key: "k", paths: ["a"] }];
    await memo.measureAll(sets, () => undefined);
    expect(measured).toBe(0);
    focus = true;
    await memo.measureAll(sets, () => undefined);
    expect(measured).toBe(1);
  });

  it("a walk over its time limit stops and leaves a lower bound, kept like any size", async () => {
    const a = dir();
    for (let i = 0; i < 40; i++) put(a, `d/f${i}`, 10);
    let t = 0;
    const whole = await measureDirs([a], { yieldEvery: 5 });
    expect(whole).toEqual({ bytes: 400 });
    const cut = await measureDirs([a], { yieldEvery: 5, limitMs: 1, now: () => (t += 10) });
    expect(cut.lowerBound).toBe(true);
    expect(cut.bytes).toBeLessThan(400);
    const memo = new SizeMemo(async () => cut, { file: join(dir(), "sizes.json") });
    await memo.measureAll([{ id: "s", key: "k", paths: [a] }], () => undefined);
    expect(memo.get("s", "k")).toMatchObject({ bytes: cut.bytes, lowerBound: true });
    const s = buildState({ open: {}, scan: { at: 1, folders: [], repos: [], sets: [{ id: "s", folder: "s", story: 1, branch: "b", repos: [] }] }, recents: [], lookIn: [], stories: {}, exists: () => true, size: () => memo.get("s", "k") });
    expect(s.sets[0]).toMatchObject({ sizeBytes: cut.bytes, sizeLowerBound: true });
    expect(s.totalSizeLowerBound).toBe(true);
  });

  it("the key changes when a repository is added to the set", () => {
    const folder = dir();
    const r = (n: string) => ({ name: n, path: join(folder, n), branch: "b", exists: true });
    const before = setKey({ folder, repos: [r("a")] });
    expect(setKey({ folder, repos: [r("a")] })).toBe(before);
    expect(setKey({ folder, repos: [r("a"), r("b")] })).not.toBe(before);
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
      size: (x) => (x.id === "/s/3" ? undefined : { bytes: x.id === "/s/1" ? 1000 : 2500, at: 5 }),
      prsMerged: (x) => (x.id === "/s/3" ? undefined : x.id === "/s/1"),
      allMerged: (x) => (x.id === "/s/1" ? true : x.id === "/s/2" ? false : undefined),
    });
    expect(s.sets.map((x) => x.prsMerged)).toEqual([true, false, undefined]);
    expect(s.sets.map((x) => [x.id, x.sizeBytes, x.allMerged])).toEqual([["/s/1", 1000, true], ["/s/2", 2500, false], ["/s/3", undefined, undefined]]);
    expect(s.totalSizeBytes).toBe(3500);
    // nothing known yet: no total
    expect(buildState({ open: {}, scan: { at: 1, folders: [], repos: [], sets: [sc("/s/1", 1)] }, recents: [], lookIn: [], stories: {}, exists: () => true }).totalSizeBytes).toBeUndefined();
  });
});
