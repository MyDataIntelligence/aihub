import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({ window: {} }));

import { missingCloneRepo, whyNotTheClone } from "../src/bar/missingClone";
import { withCloneRecovery, type RecoveryUi } from "../src/bar/missingCloneUi";
import { plainError } from "../src/bar/plainError";

const NOT_FOUND = "can't find the clone of 'repo-one' next to /x/current; point aihub to its folder once with: aihub repos prefer repo-one <folder> (aihub remembers it)";
function clone(folder: string, url?: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), "aihub-mc-")), folder);
  mkdirSync(join(dir, ".git"), { recursive: true });
  if (url) writeFileSync(join(dir, ".git", "config"), `[remote "origin"]\n\turl = ${url}\n`);
  return dir;
}
function ui(folder: string | undefined, button: string | null = "Choose Folder…") {
  const seen = { warnings: [] as string[], remembered: [] as [string, string][], dialogs: 0 };
  const u: RecoveryUi = {
    warn: async (t) => (seen.warnings.push(t), button ?? undefined),
    pickFolder: async () => (seen.dialogs++, folder),
    remember: (r, d) => void seen.remembered.push([r, d]),
  };
  return { u, seen };
}

describe("the clone of a repository cannot be found (bar action)", () => {
  it("names the repository from the CLI failure, and only for that failure", () => {
    expect(missingCloneRepo(new Error(NOT_FOUND))).toBe("repo-one");
    expect(missingCloneRepo(new Error("fatal: not a git repository"))).toBeUndefined();
  });

  it("Choose Folder... then the preference is saved and the action is repeated once", async () => {
    const dir = clone("Repo One", "https://dev.azure.com/org-x/proj-y/_git/repo_one");
    const { u, seen } = ui(dir);
    let runs = 0;
    const out = await withCloneRecovery(async () => {
      if (++runs === 1) throw new Error(NOT_FOUND);
      return "done";
    }, u);
    expect(out).toBe("done");
    expect(runs).toBe(2);
    expect(seen.warnings).toEqual(["AI Context Hub: Can't find the clone of repo-one."]);
    expect(seen.remembered).toEqual([["repo-one", dir]]);
  });

  it("a folder whose remote points to another repository is refused with one sentence, nothing saved, nothing repeated", async () => {
    const dir = clone("Elsewhere", "https://dev.azure.com/org-x/proj-y/_git/other-repo");
    const { u, seen } = ui(dir);
    let runs = 0;
    const out = await withCloneRecovery(async () => (++runs, Promise.reject(new Error(NOT_FOUND))), u);
    expect(out).toBeUndefined();
    expect(runs).toBe(1);
    expect(seen.remembered).toEqual([]);
    expect(seen.warnings[1]).toContain("belongs to other-repo, not to repo-one");
  });

  it("a folder that is no clone, or has no remote, is refused too", () => {
    expect(whyNotTheClone(join(tmpdir()), "repo-one")).toContain("not a git clone");
    expect(whyNotTheClone(clone("No Remote"), "repo-one")).toContain("no remote");
    expect(whyNotTheClone(clone("Fine", "git@ssh.dev.azure.com:v3/org-x/proj-y/Repo-One"), "repo-one")).toBeUndefined();
  });

  it("the repeated action fails again: that failure is thrown, no second dialog", async () => {
    const dir = clone("Repo One", "https://dev.azure.com/org-x/proj-y/_git/repo-one");
    const { u, seen } = ui(dir);
    await expect(withCloneRecovery(async () => Promise.reject(new Error(NOT_FOUND)), u)).rejects.toThrow(/can't find the clone/);
    expect(seen.dialogs).toBe(1);
  });

  it("dismissing the message or the dialog changes nothing; other failures pass through untouched", async () => {
    const a = ui(undefined, null);
    expect(await withCloneRecovery(async () => Promise.reject(new Error(NOT_FOUND)), a.u)).toBeUndefined();
    expect(a.seen.dialogs).toBe(0);
    const b = ui(undefined);
    expect(await withCloneRecovery(async () => Promise.reject(new Error(NOT_FOUND)), b.u)).toBeUndefined();
    expect(b.seen.remembered).toEqual([]);
    await expect(withCloneRecovery(async () => Promise.reject(new Error("boom")), b.u)).rejects.toThrow("boom");
  });

  it("everywhere else the failure is one plain sentence with the command, no raw CLI text", () => {
    const t = plainError(NOT_FOUND).text;
    expect(t).toBe('the clone of repo-one was not found; choose its folder when asked, or run: aihub repos prefer "repo-one" <folder>');
  });
});
