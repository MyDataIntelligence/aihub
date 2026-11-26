import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitRun } from "../src/bar/ownWindow";
import { dirtyFiles, fileList, smartCheckout } from "../src/bar/smartCheckout";
import { sh, write } from "./gitHelpers";

function repo() {
  const root = mkdtempSync(join(tmpdir(), "aihub-smart-"));
  const dir = join(root, "repo-a");
  mkdirSync(dir);
  sh(dir, "init", "-b", "main");
  write(dir, "a.txt", "a\n");
  write(dir, "b.txt", "b\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-m", "init");
  sh(dir, "switch", "-c", "other");
  write(dir, "b.txt", "b changed on other\n");
  sh(dir, "commit", "-am", "other");
  sh(dir, "switch", "main");
  return dir;
}
const switchTo = (dir: string, branch: string) => async () => {
  try {
    sh(dir, "switch", branch);
    return true;
  } catch {
    return false;
  }
};

describe("Smart Checkout: the changes go along, or everything goes back", () => {
  it("lists tracked changes (five at most) and carries a change that does not touch the other branch's files", async () => {
    const dir = repo();
    write(dir, "a.txt", "a changed here\n");
    write(dir, "untracked.txt", "u\n");
    expect(await dirtyFiles(gitRun, dir)).toEqual(["a.txt"]);
    expect(fileList(["1", "2", "3", "4", "5", "6", "7"])).toBe("1, 2, 3, 4, 5 and 2 more");
    const r = await smartCheckout(gitRun, { path: dir, oldBranch: "main", run: switchTo(dir, "other") });
    expect(r).toEqual({ ok: true });
    expect(sh(dir, "branch", "--show-current").trim()).toBe("other");
    expect(readFileSync(join(dir, "a.txt"), "utf8").replace(/\r/g, "")).toBe("a changed here\n");
    expect(sh(dir, "stash", "list").trim()).toBe("");
  });

  it("a change that conflicts there: back on the old branch with the change in place, nothing lost, no stash left behind", async () => {
    const dir = repo();
    write(dir, "b.txt", "b changed here\n");
    const r = await smartCheckout(gitRun, { path: dir, oldBranch: "main", run: switchTo(dir, "other") });
    expect(r.ok).toBe(false);
    expect(r.problem).toContain("main is checked out again");
    expect(sh(dir, "branch", "--show-current").trim()).toBe("main");
    expect(readFileSync(join(dir, "b.txt"), "utf8").replace(/\r/g, "")).toBe("b changed here\n");
    expect(sh(dir, "stash", "list").trim()).toBe("");
  });

  it("a switch that does not happen leaves the changes where they were", async () => {
    const dir = repo();
    write(dir, "a.txt", "a changed here\n");
    const r = await smartCheckout(gitRun, { path: dir, oldBranch: "main", run: async () => false });
    expect(r.ok).toBe(false);
    expect(readFileSync(join(dir, "a.txt"), "utf8").replace(/\r/g, "")).toBe("a changed here\n");
    expect(sh(dir, "stash", "list").trim()).toBe("");
  });
});
