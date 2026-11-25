import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listWorktrees, pruneIfSafe } from "../src/lib/gitx.js";
import { removeWorktreeSafely } from "../src/lib/worktree.js";
import { sh } from "./helpers.js";
import { makeNamedRepo, newParent } from "./parity-helpers.js";

const world = () => {
  const parent = newParent();
  const a = makeNamedRepo(parent, "repo-a").dir;
  sh(a, ["config", "user.name", "Test"]);
  sh(a, ["config", "user.email", "test@example.invalid"]);
  return { parent, a };
};
const registered = (a: string, p: string) => listWorktrees(a).some((w) => w.path.replace(/\\/g, "/").toLowerCase() === p.replace(/\\/g, "/").toLowerCase());

describe("a worktree whose drive is not there is not pruned", () => {
  it("a folder that is gone from an existing parent is pruned", () => {
    const { parent, a } = world();
    const wt = join(parent, "wts", "x");
    sh(a, ["worktree", "add", "-b", "feature/x", wt]);
    rmSync(wt, { recursive: true, force: true });
    expect(pruneIfSafe(a)).toBe(true);
    expect(registered(a, wt)).toBe(false);
  });

  it("a folder whose parent is gone too (unplugged disk, share offline) keeps its registration, also next to a real stale one", () => {
    const { parent, a } = world();
    const away = join(parent, "usb", "disk");
    const wt = join(away, "x");
    sh(a, ["worktree", "add", "-b", "feature/x", wt]);
    rmSync(join(parent, "usb"), { recursive: true, force: true });
    expect(pruneIfSafe(a)).toBe(false);
    expect(registered(a, wt)).toBe(true);
    // a second, really gone one does not make prune run over the first
    const gone = join(parent, "wts", "y");
    sh(a, ["worktree", "add", "-b", "feature/y", gone]);
    rmSync(gone, { recursive: true, force: true });
    expect(pruneIfSafe(a)).toBe(false);
    expect(registered(a, wt)).toBe(true);
  });

  it("a drive letter that does not exist", () => {
    if (process.platform !== "win32" || existsSync("Q:\\")) return;
    const { parent, a } = world();
    const wt = join(parent, "wts", "x");
    sh(a, ["worktree", "add", "-b", "feature/x", wt]);
    const admin = join(a, ".git", "worktrees", "x");
    writeFileSync(join(admin, "gitdir"), "Q:/aihub-absent/x/.git\n");
    expect(readFileSync(join(admin, "gitdir"), "utf8")).toContain("Q:");
    expect(pruneIfSafe(a)).toBe(false);
    expect(existsSync(admin)).toBe(true);
  });

  it("removing a set entry on an unreachable folder keeps it in the set", () => {
    const { parent, a } = world();
    const wt = join(parent, "usb", "disk", "x");
    mkdirSync(join(parent, "usb"), { recursive: true });
    sh(a, ["worktree", "add", "-b", "feature/x", wt]);
    rmSync(join(parent, "usb"), { recursive: true, force: true });
    const r = removeWorktreeSafely({ name: "repo-a", source: a, path: wt }, "feature/x");
    expect(r.removed).toBe(false);
    expect(r.line).toContain("cannot be reached");
    expect(registered(a, wt)).toBe(true);
  });
});
