import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chooseClone, cloneItem, originUrl, readPreferredClones, remoteKey, uniqueRepos } from "../src/worktrees/clones";
import { findRepos } from "../src/worktrees/core";
import { sh } from "./gitHelpers";

describe("one repository is one line, however often it is cloned", () => {
  it("every spelling of one Azure DevOps remote has the same key", () => {
    const keys = [
      "https://dev.azure.com/ferron-test/test-project/_git/repo-a",
      "https://someone@dev.azure.com/Ferron-Test/Test-Project/_git/Repo-A.git",
      "https://ferron-test.visualstudio.com/DefaultCollection/test-project/_git/repo-a",
      "git@ssh.dev.azure.com:v3/ferron-test/test-project/repo-a",
      "ferron-test@vs-ssh.visualstudio.com:v3/ferron-test/test-project/repo-a",
    ].map(remoteKey);
    expect(new Set(keys).size).toBe(1);
    expect(remoteKey("https://dev.azure.com/ferron-test/test-project/_git/repo-b")).not.toBe(keys[0]);
  });

  it("ssh and https of another host have the same key", () => {
    expect(remoteKey("git@example.com:team/repo-a.git")).toBe(remoteKey("https://example.com/Team/repo-a"));
  });

  it("the preferred clone wins, else the most recently used, else the first folder to look in", () => {
    const clones = [
      { path: "C:\\work\\old\\repo-a", lastUsed: 10 },
      { path: "C:\\src\\repo-a", lastUsed: 20, rank: 1 },
      { path: "C:\\x\\repo-a", lastUsed: 20, rank: 0 },
    ];
    expect(chooseClone(clones)).toBe("C:\\x\\repo-a");
    expect(chooseClone(clones, "c:\\work\\OLD\\repo-a")).toBe("C:\\work\\old\\repo-a");
    expect(chooseClone(clones, "C:\\elsewhere\\repo-a")).toBe("C:\\x\\repo-a");
  });

  it("two clones and a worktree of one remote, ssh and https: one line with +1 more", async () => {
    const root = mkdtempSync(join(tmpdir(), "aihub-clones-"));
    const origin = join(root, "origin", "repo-a.git");
    mkdirSync(origin, { recursive: true });
    sh(origin, "init", "--bare", "-b", "main");
    const scan = join(root, "scan");
    mkdirSync(join(scan, "old"), { recursive: true });
    const a1 = join(scan, "repo-a");
    const a2 = join(scan, "old", "repo-a");
    sh(root, "clone", origin, a1);
    sh(root, "clone", origin, a2);
    sh(a1, "commit", "--allow-empty", "-m", "init");
    sh(a1, "worktree", "add", "-b", "feature/1", join(scan, "repo-a-wt"));
    // the same remote spelled two ways (as an ssh and an https clone would have it)
    sh(a1, "remote", "set-url", "origin", "git@ssh.dev.azure.com:v3/ferron-test/test-project/repo-a");
    sh(a2, "remote", "set-url", "origin", "https://dev.azure.com/ferron-test/test-project/_git/repo-a");
    const other = join(scan, "repo-b");
    sh(root, "init", "-b", "main", other);
    expect(await originUrl(a2)).toBe("https://dev.azure.com/ferron-test/test-project/_git/repo-a");
    // a1 was used last
    const old = new Date(Date.now() - 86_400_000);
    utimesSync(join(a2, ".git", "HEAD"), old, old);
    utimesSync(join(a1, ".git", "HEAD"), new Date(), new Date());

    const found = await findRepos([scan], 2);
    expect(found).toHaveLength(3); // two clones of repo-a, repo-b; the worktree has a .git file, not a directory
    const unique = await uniqueRepos(found);
    expect(unique.map((r) => r.path)).toEqual([a1, other]);
    expect(unique).toHaveLength(2);
    const a = unique.find((r) => r.path === a1)!;
    expect(a.otherClones).toEqual([a2]);
    expect(cloneItem(a)).toMatchObject({ label: a.name, description: `${a1}  +1 more`, detail: `also cloned at ${a2}` });
    expect(cloneItem(unique.find((r) => r.path === other)!)).toEqual({ label: "repo-b", description: other });

    // a preference by repository name picks the other clone
    const preferred = await uniqueRepos(found, { "REPO-A": a2 });
    expect(preferred.find((r) => r.otherClones)?.path).toBe(a2);
  });

  it("reads the preferences of aihub repos prefer from the aihub config home", () => {
    const home = mkdtempSync(join(tmpdir(), "aihub-cfg-"));
    expect(readPreferredClones({ AIHUB_CONFIG_HOME: home })).toEqual({});
    writeFileSync(join(home, "repos.json"), JSON.stringify({ prefer: { "repo-a": "C:\\src\\repo-a" } }));
    expect(readPreferredClones({ AIHUB_CONFIG_HOME: home })).toEqual({ "repo-a": "C:\\src\\repo-a" });
  });
});
