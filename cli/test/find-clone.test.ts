import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { cloneIsOf, findCloneByIdentity, looseName } from "../src/lib/findClone.js";
import { resolveRepoDirs } from "../src/lib/repos.js";
import { setPreferredClone } from "../src/lib/repoPicker.js";
import type { TeamConfig } from "../src/lib/team.js";

const parent = () => mkdtempSync(join(tmpdir(), "aihub-find-"));
/** A fake clone: a folder with `.git/config` holding the remote, as git writes it (no git process needed). */
function clone(root: string, folder: string, url?: string): string {
  const dir = join(root, folder);
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "config"), url ? `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` : "[core]\n\tbare = false\n");
  return resolve(dir);
}
const team = {} as TeamConfig;
const env = () => ({ AIHUB_CONFIG_HOME: mkdtempSync(join(tmpdir(), "aihub-cfg-")) }) as NodeJS.ProcessEnv;

describe("looseName: case, spaces, _ and - do not count", () => {
  it("treats the three spellings as one name", () => {
    expect(looseName("Repo X")).toBe(looseName("repo_x"));
    expect(looseName("repo-x")).toBe(looseName("Repo X"));
    expect(looseName("repo")).not.toBe(looseName("repo-x"));
  });
});

describe("a clone is found by the repository its remote points to", () => {
  const forms = [
    "https://dev.azure.com/org-x/proj-y/_git/repo_x",
    "https://dev.azure.com/org-x/proj-y/_git/repo_x.git",
    "https://someone@dev.azure.com/org-x/proj-y/_git/repo_x",
    "https://org-x.visualstudio.com/proj-y/_git/repo_x",
    "https://org-x.visualstudio.com/DefaultCollection/proj-y/_git/repo_x",
    "org-x@vs-ssh.visualstudio.com:v3/org-x/proj-y/repo_x",
    "git@ssh.dev.azure.com:v3/org-x/proj-y/repo_x",
    "https://dev.azure.com/org-x/proj-y/_git/Repo%20X",
  ];
  for (const url of forms)
    it(`remote ${url}`, () => {
      const p = parent();
      const d = clone(p, "Some Other Folder", url);
      expect(cloneIsOf(d, "repo_x")).toBe(true);
      expect(cloneIsOf(d, "Repo X")).toBe(true);
      expect(cloneIsOf(d, "other_repo")).toBe(false);
      const cur = clone(p, "current", "https://dev.azure.com/org-x/proj-y/_git/current");
      expect(resolveRepoDirs(["repo_x"], cur, team, [], env())).toEqual([{ name: "repo_x", dir: d }]);
    });
});

describe("resolveRepoDirs finds the clone when the folder is named differently", () => {
  it("the user's case: folder 'Repo X', repository 'repo_x', remote says so", () => {
    const p = parent();
    const cur = clone(p, "current", "https://dev.azure.com/org-x/proj-y/_git/current");
    const d = clone(p, "Repo X", "https://dev.azure.com/org-x/proj-y/_git/repo_x");
    expect(resolveRepoDirs(["repo_x"], cur, team, [], env())[0].dir).toBe(d);
  });

  it("a folder without remote is found by its loosely equal name", () => {
    const p = parent();
    const cur = clone(p, "current");
    const d = clone(p, "Repo X");
    expect(resolveRepoDirs(["repo-x"], cur, team, [], env())[0].dir).toBe(d);
  });

  it("identity beats a loosely similar folder name", () => {
    const p = parent();
    const cur = clone(p, "current");
    clone(p, "Repo X", "https://dev.azure.com/org-x/proj-y/_git/something_else");
    const right = clone(p, "elsewhere", "https://dev.azure.com/org-x/proj-y/_git/repo_x");
    expect(resolveRepoDirs(["repo_x"], cur, team, [], env())[0].dir).toBe(right);
  });

  it("an exact folder name still wins (nothing changes for people who never needed this)", () => {
    const p = parent();
    const cur = clone(p, "current");
    const exact = clone(p, "repo_x");
    clone(p, "Repo X", "https://dev.azure.com/org-x/proj-y/_git/repo_x");
    expect(resolveRepoDirs(["repo_x"], cur, team, [], env())[0].dir).toBe(exact);
  });

  it("two candidates: the preferred one, else the most recently used, else the first folder to look in", () => {
    const p = parent();
    const cur = clone(p, "current");
    const url = "https://dev.azure.com/org-x/proj-y/_git/repo_x";
    const a = clone(join(p, "x"), "Copy A", url);
    const b = clone(join(p, "y"), "Copy B", url);
    mkdirSync(join(p, "x"), { recursive: true });
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(join(a, ".git"), old, old);
    writeFileSync(join(b, ".git", "HEAD"), "ref: refs/heads/main\n");
    // b has a fresher HEAD than a (which has none): b is last used
    expect(findCloneByIdentity("repo_x", [join(p, "x"), join(p, "y")])).toBe(b);
    // the preferred one wins whatever the age
    expect(findCloneByIdentity("repo_x", [join(p, "x"), join(p, "y")], [], a)).toBe(a);
    // a clone preferred under another name is a known candidate
    const e = env();
    setPreferredClone(e, "repo_x", a);
    expect(resolveRepoDirs(["repo_x"], cur, team, [], e)[0].dir).toBe(a);
  });

  it("the folders to look in (lookin.json) are searched too", () => {
    const p = parent();
    const cur = clone(p, "current");
    const other = parent();
    const d = clone(other, "Repo X", "https://dev.azure.com/org-x/proj-y/_git/repo_x");
    const e = env();
    writeFileSync(join(e.AIHUB_CONFIG_HOME!, "lookin.json"), JSON.stringify({ folders: [other] }));
    expect(resolveRepoDirs(["repo_x"], cur, team, [], e)[0].dir).toBe(d);
  });

  it("not found: one plain sentence with the exact command to point aihub to the folder", () => {
    const p = parent();
    const cur = clone(p, "current");
    clone(p, "unrelated", "https://dev.azure.com/org-x/proj-y/_git/unrelated");
    expect(() => resolveRepoDirs(["repo_x"], cur, team, [], env())).toThrowError(/can't find the clone of 'repo_x'.*aihub repos prefer "repo_x" <folder>.*remembers it/);
  });

  it("the remembered folder is then used, whatever it is called", () => {
    const p = parent();
    const cur = clone(p, "current");
    const far = clone(parent(), "my stuff");
    const e = env();
    setPreferredClone(e, "repo_x", far);
    expect(resolveRepoDirs(["repo_x"], cur, team, [], e)[0].dir).toBe(far);
  });
});
