import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { oneClonePerRemote } from "../src/bar/engine";
import { hideClone, setPreferredClone } from "../src/bar/hiddenClones";
import { storyRepoRows } from "../src/bar/storyModel";
import type { ScanRepo } from "../../cli/src/lib/machineScan";

function world() {
  const root = mkdtempSync(join(tmpdir(), "aihub-clones-"));
  const env = { AIHUB_CONFIG_HOME: join(root, "cfg") } as NodeJS.ProcessEnv;
  const clone = (dir: string, name: string, remote: string): ScanRepo => {
    const path = join(root, dir, name);
    mkdirSync(join(path, ".git"), { recursive: true });
    writeFileSync(join(path, ".git", "HEAD"), "ref: refs/heads/main");
    // used at the same moment: then the first folder to look in decides
    utimesSync(join(path, ".git", "HEAD"), new Date(2026, 0, 1), new Date(2026, 0, 1));
    return { name, path, branch: "main", remote };
  };
  const url = "https://dev.azure.com/contoso/proj/_git/repo-a";
  const a = clone("git", "repo-a", url);
  const kopie = clone("oud", "repo-a-kopie", url);
  const spaces = clone("oud", "Repo Met Spaties", url);
  const other = clone("git", "repo-b", "https://dev.azure.com/contoso/proj/_git/repo-b");
  return { root, env, a, kopie, spaces, other, folders: [join(root, "git"), join(root, "oud")] };
}

describe("one repository is its remote, however often and wherever it is cloned (persona 5)", () => {
  it("the name is the repository's, the folder is only the path; the first folder to look in wins; all clones are listed", async () => {
    const w = world();
    const list = await oneClonePerRemote(w.env, [w.kopie, w.spaces, w.a, w.other], { folders: w.folders });
    expect(list.map((r) => r.name)).toEqual(["repo-a", "repo-b"]);
    const a = list[0];
    expect(a.path).toBe(w.a.path);
    expect(a.otherClones).toHaveLength(2);
    expect(a.clones?.map((c) => c.path).sort()).toEqual([w.a.path, w.kopie.path, w.spaces.path].sort());
    // Open Story finds the clone by the repository's name, not by the folder
    const { rows, notOnThisPc } = storyRepoRows([{ repo: "repo-a", branch: "feature/1-x", linked: "ado", status: "current" } as never], list);
    expect(notOnThisPc).toEqual([]);
    expect(rows[0]).toMatchObject({ repo: "repo-a", path: w.a.path });
  });

  it("a preferred clone wins whatever its folder is called; Remove from List takes one out of the list, not off the disk", async () => {
    const w = world();
    setPreferredClone(w.env, "repo-a", w.kopie.path);
    let list = await oneClonePerRemote(w.env, [w.a, w.kopie, w.spaces, w.other], { folders: w.folders });
    expect(list[0]).toMatchObject({ name: "repo-a", path: w.kopie.path });
    hideClone(w.env, w.kopie.path);
    list = await oneClonePerRemote(w.env, [w.a, w.kopie, w.spaces, w.other], { folders: w.folders });
    expect(list[0].path).not.toBe(w.kopie.path);
    expect(list[0].clones?.map((c) => c.path)).not.toContain(w.kopie.path);
    expect(list[0].clones).toHaveLength(2);
  });
});
