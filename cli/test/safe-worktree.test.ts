import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dirSize, removeWorktreeSafely } from "../src/lib/safeWorktree.js";
import { sh, tmp } from "./helpers.js";
import { makeNamedRepo, newParent } from "./parity-helpers.js";

describe("safeWorktree: freed space", () => {
  it("dirSize counts files and does not follow folder links", () => {
    const d = tmp();
    writeFileSync(join(d, "a.txt"), "12345");
    mkdirSync(join(d, "sub"));
    writeFileSync(join(d, "sub", "b.txt"), "123");
    const big = tmp();
    writeFileSync(join(big, "huge.bin"), Buffer.alloc(10_000));
    symlinkSync(big, join(d, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    expect(dirSize(d)).toBe(8);
  });

  it("removeWorktreeSafely says how many bytes the removed worktree held (a linked node_modules not counted)", () => {
    const parent = newParent();
    const a = makeNamedRepo(parent, "repo-a");
    const wt = join(parent, "wt");
    sh(a.dir, ["worktree", "add", "-q", "-b", "feature/9-x", wt]);
    const linked = tmp();
    writeFileSync(join(linked, "huge.bin"), Buffer.alloc(10_000));
    symlinkSync(linked, join(wt, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const r = removeWorktreeSafely(a.dir, wt, "feature/9-x");
    expect(r.removed).toBe(true);
    expect(r.freedBytes).toBeGreaterThan(0);
    expect(r.freedBytes).toBeLessThan(10_000);
    expect(existsSync(join(linked, "huge.bin"))).toBe(true);
    const kept = removeWorktreeSafely(a.dir, join(parent, "nope"), "feature/9-x");
    expect(kept.freedBytes).toBe(0);
  });
});
