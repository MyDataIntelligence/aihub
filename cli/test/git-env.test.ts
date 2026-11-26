import * as cp from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bareHint, git, gitRaw } from "../src/lib/git.js";
import { gitEnvironment, isGitCommand, REPOSITORY_VARIABLES, scrubGitOptions } from "../src/lib/gitEnv.js";
import { spawnSync } from "../src/lib/proc.js";
import { patchOfWork } from "../src/lib/workBackup.js";
import { makeRepo, sh, write } from "./helpers.js";

const SAVED = { ...process.env };
afterEach(() => {
  for (const k of REPOSITORY_VARIABLES) delete process.env[k];
  Object.assign(process.env, SAVED);
});

/** A main clone with a linked worktree; returns the main folder and the worktree's git dir (.git/worktrees/<name>). */
function mainWithWorktree() {
  const { dir } = makeRepo();
  const wt = join(mkdtempSync(join(tmpdir(), "aihub-linked-")), "linked");
  sh(dir, ["worktree", "add", "-b", "linked-branch", wt]);
  return { dir, wt, gitDir: join(dir, ".git", "worktrees", "linked") };
}

const bare = (dir: string) => cp.spawnSync("git", ["-C", dir, "config", "core.bare"], { encoding: "utf8", env: gitEnvironment() }).stdout.trim();

describe("git environment isolation", () => {
  it("drops the repository variables and keeps everything else", () => {
    const env = gitEnvironment({ PATH: "p", GIT_DIR: "x", git_work_tree: "y", GIT_CEILING_DIRECTORIES: "c", HOME: "h", GIT_TERMINAL_PROMPT: "0" });
    expect(env).toEqual({ PATH: "p", HOME: "h", GIT_TERMINAL_PROMPT: "0" });
  });

  it("keeps a variable aihub sets on purpose", () => {
    const env = gitEnvironment({ GIT_INDEX_FILE: "inherited", GIT_DIR: "x" }, { GIT_INDEX_FILE: "mine" });
    expect(env.GIT_INDEX_FILE).toBe("mine");
    expect(env.GIT_DIR).toBeUndefined();
  });

  it("recognises git commands, also on a shell command line", () => {
    for (const c of ["git", "git.exe", "C:\\Program Files\\Git\\cmd\\git.exe", "/usr/bin/git", 'git commit -m "x"']) expect(isGitCommand(c)).toBe(true);
    for (const c of ["gitk", "dbt", "az", "mygit", undefined]) expect(isGitCommand(c)).toBe(false);
  });

  it("scrubs inherited variables from an explicit env copy but keeps a changed value", () => {
    process.env.GIT_DIR = "/inherited";
    const o = scrubGitOptions({ env: { ...process.env, GIT_INDEX_FILE: "/own/index", GIT_TERMINAL_PROMPT: "0" } }) as { env: NodeJS.ProcessEnv };
    expect(o.env.GIT_DIR).toBeUndefined();
    expect(o.env.GIT_INDEX_FILE).toBe("/own/index");
    expect(o.env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("a git init under a worktree's GIT_DIR leaves core.bare of the main clone false (through aihub's spawn)", () => {
    const { dir, gitDir } = mainWithWorktree();
    expect(bare(dir)).toBe("false");
    process.env.GIT_DIR = gitDir;
    const target = mkdtempSync(join(tmpdir(), "aihub-init-"));
    const r = spawnSync("git", ["init", target], { encoding: "utf8" });
    expect(r.status).toBe(0);
    delete process.env.GIT_DIR;
    expect(bare(dir)).toBe("false");
  });

  it("measures what git does without the helper (documents the mechanism on this machine)", () => {
    const { dir, gitDir } = mainWithWorktree();
    const target = mkdtempSync(join(tmpdir(), "aihub-init-"));
    // raw child_process: the unprotected path
    cp.spawnSync("git", ["init", target], { encoding: "utf8", env: { ...process.env, GIT_DIR: gitDir } });
    const after = bare(dir);
    console.log(`without the helper, git init under GIT_DIR=.git/worktrees/<name> leaves core.bare of the main clone: ${after}`);
    // the mechanism exists when this is "true"; on a git that no longer does this the protected test above still holds
    expect(["true", "false"]).toContain(after);
  });

  it("keeps the temporary index of a work backup (GIT_INDEX_FILE set on purpose)", () => {
    const { dir } = makeRepo();
    write(dir, "new.txt", "hello\n");
    process.env.GIT_DIR = join(dir, ".git");
    process.env.GIT_INDEX_FILE = join(dir, ".git", "index");
    const r = patchOfWork(dir);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.patch.toString()).toContain("new.txt");
    // the user's own index was not touched: new.txt is still untracked
    delete process.env.GIT_DIR;
    delete process.env.GIT_INDEX_FILE;
    expect(sh(dir, ["status", "--porcelain"])).toContain("?? new.txt");
  });
});

describe("core.bare repair message", () => {
  it("names the repair command for a normal clone that says core.bare = true", () => {
    const { dir } = makeRepo();
    sh(dir, ["config", "core.bare", "true"]);
    const msg = bareHint(dir, "fatal: this operation must be run in a work tree");
    expect(msg).toContain("core.bare = true");
    expect(msg).toContain(`git -C "${dir}" config core.bare false`);
    // not repaired by aihub itself
    expect(bare(dir)).toBe("true");
  });

  it("is part of the error of a failing aihub git call", () => {
    const { dir } = makeRepo();
    sh(dir, ["config", "core.bare", "true"]);
    expect(() => git(dir, ["status"])).toThrow(/core\.bare false/);
    expect(gitRaw(dir, ["status"]).stderr).toMatch(/core\.bare false/);
  });

  it("says nothing for other errors or a real bare repository", () => {
    const { dir, bare: bareRepo } = makeRepo();
    expect(bareHint(dir, "fatal: not a git repository")).toBe("");
    expect(bareHint(dir, "fatal: this operation must be run in a work tree")).toBe("");
    mkdirSync(join(bareRepo, ".git"), { recursive: true });
    writeFileSync(join(bareRepo, ".git", "config"), "");
    expect(bareHint(bareRepo, "fatal: this operation must be run in a work tree")).toBe("");
  });
});

describe("every child process of aihub is scrubbed", () => {
  const show = "console.log([process.env.GIT_DIR, process.env.GIT_WORK_TREE, process.env.GIT_INDEX_FILE, process.env.KEEP_ME].join('|'))";

  it("a non-git child started through proc.ts sees no repository variables", () => {
    process.env.GIT_DIR = "/inherited/.git/worktrees/x";
    process.env.GIT_WORK_TREE = "/inherited";
    process.env.KEEP_ME = "yes";
    const r = spawnSync(process.execPath, ["-e", show], { encoding: "utf8" });
    expect(r.stdout.trim()).toBe("|||yes");
    const withEnv = spawnSync(process.execPath, ["-e", show], { encoding: "utf8", env: { ...process.env } });
    expect(withEnv.stdout.trim()).toBe("|||yes");
  });

  it("a variable set on purpose for a child survives", () => {
    process.env.GIT_DIR = "/inherited";
    const r = spawnSync(process.execPath, ["-e", show], { encoding: "utf8", env: { ...process.env, GIT_INDEX_FILE: "/own/index" } });
    expect(r.stdout.trim()).toBe("||/own/index|" + (process.env.KEEP_ME ?? ""));
  });
});
