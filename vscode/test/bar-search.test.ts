import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { refsFromFiles, remoteOfFolder, walk } from "../../cli/src/lib/machineScan";
import { cloneParent, cloneWithProgress, folderName, progressOf, removeFolderPatiently, stopTree, untouched } from "../src/bar/cloneRepo";
import { gitRun } from "../src/bar/ownWindow";
import { adoCloneOf, isSignInError, notOnThisPc, REMOTE_FAILURE_MS, REMOTE_TTL_MS, RemoteRepos } from "../src/bar/remoteRepos";
import { checkoutsOf } from "../src/bar/state";

const tmp = () => mkdtempSync(join(tmpdir(), "aihub-search-"));

/** A fake clone with linked worktrees, written as git writes them (no git process). */
function clone(dir: string, head: string, worktrees: { name: string; path: string; head: string }[] = [], refs: { loose?: string[]; packed?: string[] } = {}) {
  const g = join(dir, ".git");
  mkdirSync(g, { recursive: true });
  writeFileSync(join(g, "HEAD"), head.startsWith("ref:") || /^[0-9a-f]{40}$/.test(head) ? `${head}\n` : `ref: refs/heads/${head}\n`);
  writeFileSync(join(g, "config"), `[remote "origin"]\n\turl = https://dev.azure.com/org/proj/_git/${encodeURIComponent(dir.split(/[\\/]/).pop()!)}\n`);
  for (const w of worktrees) {
    mkdirSync(join(g, "worktrees", w.name), { recursive: true });
    mkdirSync(w.path, { recursive: true });
    writeFileSync(join(w.path, ".git"), `gitdir: ${join(g, "worktrees", w.name)}\n`);
    writeFileSync(join(g, "worktrees", w.name, "HEAD"), /^[0-9a-f]{40}$/.test(w.head) ? `${w.head}\n` : `ref: refs/heads/${w.head}\n`);
    writeFileSync(join(g, "worktrees", w.name, "gitdir"), `${join(w.path, ".git")}\n`);
  }
  for (const r of refs.loose ?? []) {
    const f = join(g, "refs", ...r.split("/"));
    mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(f, "a".repeat(40) + "\n");
  }
  if (refs.packed) writeFileSync(join(g, "packed-refs"), "# pack-refs with: peeled fully-peeled sorted\n" + refs.packed.map((r) => `${"b".repeat(40)} refs/${r}\n^${"c".repeat(40)}`).join("\n") + "\n");
}

describe("the scan knows where every branch is checked out (files only)", () => {
  it("lists the main clone, a worktree in a set, a worktree of its own; skips a detached one; keeps a name with spaces", () => {
    const root = tmp();
    const code = join(root, "code");
    const setFolder = join(code, "sets", "4698");
    clone(join(code, "repo a"), "main", [
      { name: "repo-a", path: join(setFolder, "repo-a"), head: "feature/4698-klantnummer" },
      { name: "own", path: join(root, "own", "repo-a-4698-2"), head: "feature/4698-klantnummer-2" },
      { name: "det", path: join(root, "own", "detached"), head: "d".repeat(40) },
    ]);
    writeFileSync(join(setFolder, ".aihub-set.json"), JSON.stringify({ story: 4698, branch: "feature/4698-klantnummer", repos: [{ name: "repo-a", source: join(code, "repo a"), path: join(setFolder, "repo-a") }] }));
    const scan = walk([code]);
    const rows = checkoutsOf(scan, { 4698: { id: 4698, title: "Klantnummer valideren", at: 0 } });
    expect(rows.map((r) => [r.repo, r.branch, r.where, r.setLabel ?? ""])).toEqual(
      expect.arrayContaining([
        ["repo a", "main", "clone", ""],
        ["repo-a", "feature/4698-klantnummer", "set", "#4698 Klantnummer valideren"],
        ["repo a", "feature/4698-klantnummer-2", "own", ""],
      ]),
    );
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.where === "set")?.setId).toBe(setFolder);
  });

  it("a set whose clone is outside the folders to look in still lists its worktree", () => {
    const root = tmp();
    clone(join(root, "elsewhere", "repo-b"), "main", [{ name: "repo-b", path: join(root, "sets", "4711", "repo-b"), head: "feature/4711-orderexport" }]);
    writeFileSync(join(root, "sets", "4711", ".aihub-set.json"), JSON.stringify({ story: 4711, branch: "feature/4711-orderexport", repos: [{ name: "repo-b", source: join(root, "elsewhere", "repo-b"), path: join(root, "sets", "4711", "repo-b") }] }));
    const rows = checkoutsOf(walk([join(root, "sets")]), {});
    expect(rows.map((r) => [r.repo, r.branch, r.where])).toEqual([["repo-b", "feature/4711-orderexport", "set"]]);
  });

  it("reads branch names from loose refs and packed-refs, local and origin, without HEAD, capped", () => {
    const root = tmp();
    const dir = join(root, "repo-a");
    clone(dir, "main", [], { loose: ["heads/main", "heads/feature/4698-x", "remotes/origin/HEAD", "remotes/origin/release/1"], packed: ["heads/old", "remotes/origin/feature/4711-y", "tags/v1"] });
    expect(refsFromFiles(join(dir, ".git")).sort()).toEqual(["feature/4698-x", "feature/4711-y", "main", "old", "release/1"]);
    expect(refsFromFiles(join(dir, ".git"), 2)).toHaveLength(2);
    expect(walk([root]).refs?.[0]).toMatchObject({ repo: "repo-a", path: dir });
  });
});

describe("Azure DevOps repositories not on this PC", () => {
  const all = [
    { name: "orders-api", project: "data-platform", remoteUrl: "https://dev.azure.com/org/data-platform/_git/orders-api" },
    { name: "orders events", project: "platform-core", remoteUrl: "https://dev.azure.com/org/platform-core/_git/orders%20events" },
    { name: "repo-a", project: "test-project", remoteUrl: "https://dev.azure.com/org/test-project/_git/repo-a" },
  ];
  it("drops a repository cloned here, whatever the spelling of its url (case, user part, .git, %20, ssh)", () => {
    expect(notOnThisPc(all, ["https://User@dev.azure.com/ORG/Data-Platform/_git/orders-api.git"]).map((r) => r.name)).toEqual(["orders events", "repo-a"]);
    expect(notOnThisPc(all, ["https://dev.azure.com/org/platform-core/_git/orders events"]).map((r) => r.name)).toEqual(["orders-api", "repo-a"]);
    expect(notOnThisPc(all, ["git@ssh.dev.azure.com:v3/org/test-project/repo-a", undefined]).map((r) => r.name)).toEqual(["orders-api", "orders events"]);
  });

  it("reads once a day, remembers a failure 5 minutes, never reads without focus, says signed out", async () => {
    let now = 1_000_000;
    let focused = true;
    let calls = 0;
    let fail: string | undefined;
    const env = { AIHUB_CONFIG_HOME: tmp() };
    const r = new RemoteRepos({ env, focused: () => focused, changed: () => undefined, now: () => now, read: async () => (calls++, fail ? Promise.reject(new Error(fail)) : all) });
    expect(r.get([]).status).toBe("idle");
    focused = false;
    await r.load();
    expect(calls).toBe(0);
    focused = true;
    await r.load();
    expect(calls).toBe(1);
    expect(r.get([all[0].remoteUrl])).toMatchObject({ status: "ready", at: now });
    expect(r.get([all[0].remoteUrl]).repos).toHaveLength(2);
    now += REMOTE_TTL_MS - 1;
    await r.load();
    expect(calls).toBe(1);
    // a second window reads the same file
    const other = new RemoteRepos({ env, focused: () => true, changed: () => undefined, now: () => now, read: async () => (calls++, all) });
    await other.load();
    expect(calls).toBe(1);
    now += 2;
    fail = "not signed in to Azure DevOps: run 'az login' or set AIHUB_ADO_PAT";
    await r.load();
    expect(calls).toBe(2);
    expect(r.get([]).status).toBe("signedOut");
    await r.load();
    expect(calls).toBe(2);
    now += REMOTE_FAILURE_MS + 1;
    fail = "network down";
    await r.load();
    expect(calls).toBe(3);
    // an older list stays usable after a failure that is no sign-in problem
    expect(r.get([]).status).toBe("ready");
    fail = undefined;
    await r.load({ force: true });
    expect(calls).toBe(4);
    expect(JSON.parse(readFileSync(join(env.AIHUB_CONFIG_HOME, "bar-remote-repos.json"), "utf8")).failedAt).toBeUndefined();
  });

  it("knows a sign-in problem when it sees one", () => {
    expect(isSignInError("not signed in to Azure DevOps: run 'az login' or set AIHUB_ADO_PAT")).toBe(true);
    expect(isSignInError("HTTP 401 from Azure DevOps")).toBe(true);
    expect(isSignInError("getaddrinfo ENOTFOUND dev.azure.com")).toBe(false);
  });
});

describe("cloning from the search", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
  /** a bare repository with one commit on main, to clone from */
  function origin(): string {
    const root = tmp();
    const src = join(root, "src");
    mkdirSync(src);
    git(src, "init", "-q", "-b", "main");
    writeFileSync(join(src, "a.txt"), "a\n");
    git(src, "add", ".");
    git(src, "commit", "-q", "-m", "first");
    git(root, "clone", "-q", "--bare", src, join(root, "orders-api.git"));
    return join(root, "orders-api.git");
  }

  it("goes into the first folder to look in, else next to the most recently used clone", () => {
    expect(cloneParent(["C:\\git", "D:\\other"], ["E:\\x\\repo"])).toBe("C:\\git");
    expect(cloneParent([], [join("E:", "a", "old"), join("E:", "b", "new")], (d) => (d.includes("new") ? 2 : 1))).toBe(join("E:", "b"));
    expect(cloneParent([], [])).toBeUndefined();
    expect(folderName('orders:api?')).toBe("orders-api-");
  });

  it("turns git's progress lines into one rising percentage", () => {
    expect(progressOf("Receiving objects:  50% (5/10)")).toBe(48);
    expect(progressOf("Resolving deltas: 100% (3/3), done.")).toBe(98);
    expect(progressOf("Cloning into 'x'...")).toBeUndefined();
  });

  it("never overwrites a folder that exists", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "keep.txt"), "mine");
    const res = await cloneWithProgress({ url: origin(), dir });
    expect(res).toMatchObject({ ok: false, cancelled: false });
    expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("mine");
  });

  it("clones, and Undo may remove it only while nothing was changed or made in it", async () => {
    const dir = join(tmp(), "orders-api");
    const res = await cloneWithProgress({ url: origin(), dir });
    expect(res.ok).toBe(true);
    expect(await untouched(gitRun, dir)).toEqual({ ok: true });
    // Clone and Add makes the story branch: Undo may still remove the clone, another branch keeps it
    git(dir, "branch", "feature/4698-klantnummer");
    expect(await untouched(gitRun, dir)).toEqual({ ok: false, why: "a branch was made in it" });
    expect(await untouched(gitRun, dir, { ours: "feature/4698-klantnummer" })).toEqual({ ok: true });
    writeFileSync(join(dir, "new.txt"), "x");
    expect((await untouched(gitRun, dir)).ok).toBe(false);
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "mine");
    expect(await untouched(gitRun, dir)).toEqual({ ok: false, why: "a commit was made in it" });
  });

  it("Cancel stops git and removes the half clone", async () => {
    const dir = join(tmp(), "orders-api");
    const res = await cloneWithProgress({ url: origin(), dir, onCancel: (stop) => stop() });
    expect(res).toMatchObject({ ok: false, cancelled: true });
    expect(existsSync(dir)).toBe(false);
  });

  // Git for Windows' cmd\git.exe is a starter: Cancel must stop the real git it started too, or the clone goes on writing
  it.skipIf(process.platform !== "win32")("Cancel stops what the started git started (the whole process tree)", async () => {
    const pidFile = join(tmp(), "child.pid");
    const childJs = "setInterval(() => {}, 1000)";
    const parentJs = `const c = require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(childJs)}], { stdio: "ignore" }); require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000);`;
    const parent = spawn(process.execPath, ["-e", parentJs], { stdio: "ignore" });
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
    const child = Number(readFileSync(pidFile, "utf8"));
    expect(alive(child)).toBe(true);
    stopTree(parent.pid, () => parent.kill());
    for (let i = 0; i < 100 && (alive(child) || alive(parent.pid!)); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive(child)).toBe(false);
    expect(alive(parent.pid!)).toBe(false);
  });
});

describe("removing a clone while a file in it is still in use (Undo, Cancel)", () => {
  it("tries again until the folder is gone, and says so", async () => {
    let calls = 0;
    const r = await removeFolderPatiently("x", { waitMs: 1, remove: () => {
      calls++;
      if (calls < 3) throw new Error("EBUSY: resource busy or locked");
    }, exists: () => calls < 3 });
    expect(r.gone).toBe(true);
    expect(r.why).toMatch(/EBUSY/);
    expect(calls).toBe(3);
  });

  it("removes a folder with a read-only file in it (a git object or pack)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aihub-ro-"));
    mkdirSync(join(dir, ".git", "objects", "ab"), { recursive: true });
    const f = join(dir, ".git", "objects", "ab", "cdef");
    writeFileSync(f, "x");
    chmodSync(f, 0o444);
    const r = await removeFolderPatiently(dir, { tries: 2, waitMs: 1 });
    expect(r.gone).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it("gives up after its tries and says the folder is still there", async () => {
    let calls = 0;
    const r = await removeFolderPatiently("x", { tries: 4, waitMs: 1, remove: () => void calls++, exists: () => true });
    expect(r.gone).toBe(false);
    expect(calls).toBe(4);
  });
});

describe("the Azure DevOps list of the search needs one folder of Azure DevOps (persona round 3, S1)", () => {
  it("the remote of a clone and of a linked worktree (its config is in the main clone, git's commondir)", () => {
    const root = tmp();
    const main = join(root, "test-consumer");
    const wt = join(root, "sets", "3758", "test-consumer");
    clone(main, "main", [{ name: "test-consumer", path: wt, head: "feature/3758-x" }]);
    writeFileSync(join(main, ".git", "worktrees", "test-consumer", "commondir"), "../..");
    expect(remoteOfFolder(main)).toBe("https://dev.azure.com/org/proj/_git/test-consumer");
    expect(remoteOfFolder(wt)).toBe("https://dev.azure.com/org/proj/_git/test-consumer");
    expect(remoteOfFolder(join(root, "nothing"))).toBeUndefined();
  });

  it("a clone of the scan first; someone who works only in worktree sets gets a repository of a set; none: undefined", () => {
    const ado = (p: string) => (p.includes("ado") ? "https://dev.azure.com/org/proj/_git/x" : "https://github.com/x/y");
    expect(adoCloneOf({ repos: [{ path: "C:/gh", remote: "https://github.com/x/y" }, { path: "C:/a", remote: "https://ferron@dev.azure.com/org/p/_git/a" }], sets: [] }, ado)).toBe("C:/a");
    expect(adoCloneOf({ repos: [{ path: "C:/gh", remote: "https://github.com/x/y" }], sets: [{ repos: [{ path: "C:/sets/1/gone-ado", exists: false }, { path: "C:/sets/1/gh", exists: true }, { path: "C:/sets/1/ado-repo", exists: true }] }] }, ado)).toBe("C:/sets/1/ado-repo");
    expect(adoCloneOf({ repos: [], sets: [{ repos: [{ path: "C:/sets/1/gh", exists: true }] }] }, ado)).toBeUndefined();
  });
});
