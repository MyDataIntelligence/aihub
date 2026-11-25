import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isRemoteFolder, walk } from "../src/lib/machineScan.js";
import { tmp } from "./helpers.js";

const repoAt = (dir: string) => mkdirSync(join(dir, ".git"), { recursive: true });

describe("what the scan looks at, and what it says it did not", () => {
  it("says so when it stopped early (too many folders)", () => {
    const root = tmp("aihub-scan-");
    for (let i = 0; i < 5200; i++) mkdirSync(join(root, `d${String(i).padStart(4, "0")}`));
    const scan = walk([root]);
    expect(scan.truncated).toBe(true);
    expect(walk([tmp("aihub-scan-")]).truncated).toBeUndefined();
  });

  it("leaves OneDrive and network folders out unless they were put in Folders to Look In", () => {
    const root = tmp("aihub-scan-");
    repoAt(join(root, "plain", "repo-a"));
    repoAt(join(root, "OneDrive - Org", "repo-b"));
    const derived = walk([root]);
    expect(derived.repos.map((r) => r.name)).toEqual(["repo-a"]);
    expect(derived.skippedRemote).toEqual([join(root, "OneDrive - Org")]);
    // the folder is listed by the user: everything below it is looked at
    const own = walk([join(root, "OneDrive - Org")], { allowRemote: true });
    expect(own.repos.map((r) => r.name)).toEqual(["repo-b"]);
    expect(own.skippedRemote).toBeUndefined();
  });

  it("knows OneDrive by name and by the OneDrive variables, and UNC paths", () => {
    expect(isRemoteFolder("C:\\Users\\x\\OneDrive\\Documenten")).toBe(true);
    expect(isRemoteFolder("D:\\Cloud\\Sync", { OneDriveCommercial: "D:\\Cloud" })).toBe(true);
    expect(isRemoteFolder("\\\\server\\share\\git")).toBe(true);
    expect(isRemoteFolder("C:\\git\\work")).toBe(false);
  });

  it("does not follow a junction or symlink to another place", () => {
    const root = tmp("aihub-scan-");
    const elsewhere = tmp("aihub-elsewhere-");
    repoAt(join(elsewhere, "repo-x"));
    symlinkSync(elsewhere, join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    expect(walk([root]).repos).toEqual([]);
  });
});
