import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { walk } from "../../cli/src/lib/machineScan";
import { oneClonePerRemote } from "../src/bar/engine";
import { remoteKey } from "../src/worktrees/clones";

const clone = (parent: string, name: string, url: string) => {
  const dir = join(parent, name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(dir, ".git", "config"), `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  return dir;
};

describe("one clone per remote, with the names of a real PC", () => {
  it("clones whose origin url has spaces in the repository name are different repositories", async () => {
    const parent = mkdtempSync(join(tmpdir(), "aihub-remote-"));
    clone(parent, "Repo One", "https://dev.azure.com/org/Project Name/_git/Repo One");
    clone(parent, "Repo Two", "https://dev.azure.com/org/Project Name/_git/Repo Two");
    clone(parent, "Repo Two copy", "https://org@dev.azure.com/org/Project%20Name/_git/Repo%20Two");
    const scan = walk([parent]);
    expect(scan.repos.map((r) => r.remote)).toContain("https://dev.azure.com/org/Project Name/_git/Repo Two");
    const one = await oneClonePerRemote({ AIHUB_CONFIG_HOME: mkdtempSync(join(tmpdir(), "aihub-cfg-")) }, scan.repos);
    // Repo One, and Repo Two with its second clone
    expect(one.map((r) => r.name).sort()).toEqual(["Repo One", expect.stringMatching(/^Repo Two/)]);
    expect(one).toHaveLength(2);
    expect(one.find((r) => r.name.startsWith("Repo Two"))?.otherClones).toHaveLength(1);
  });

  it("ssh://user@host and https of the same Azure DevOps repository have the same key", () => {
    const https = remoteKey("https://dev.azure.com/org/proj/_git/repo-a");
    expect(remoteKey("ssh://git@ssh.dev.azure.com/v3/org/proj/repo-a")).toBe(https);
    // what the scan keeps of that url: the user part is already stripped
    expect(remoteKey("ssh://ssh.dev.azure.com/v3/org/proj/repo-a")).toBe(https);
  });

  it("a remote url with a stray % does not break the whole list", () => {
    expect(() => remoteKey("https://dev.azure.com/org/proj/_git/100%")).not.toThrow();
  });
});
