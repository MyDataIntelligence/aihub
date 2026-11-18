import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGit } from "../src/worktrees/git";

// The code under test commits through createGit(), which uses process.env: give it an identity (CI has no global one).
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
export const git = createGit();
export const lf = (t: string) => t.replace(new RegExp(String.fromCharCode(13), "g"), "");
export const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
export const write = (cwd: string, f: string, text: string) => {
  mkdirSync(join(cwd, f, ".."), { recursive: true });
  writeFileSync(join(cwd, f), text);
};

/** An origin with staging, and a clone on a feature branch that has two commits. */
export function world() {
  const root = mkdtempSync(join(tmpdir(), "aihub-git-"));
  const origin = join(root, "origin.git");
  mkdirSync(origin);
  sh(origin, "init", "--bare", "-b", "staging");
  const seed = join(root, "seed");
  sh(root, "clone", origin, seed);
  sh(seed, "switch", "-c", "staging");
  write(seed, "a.txt", "a\n");
  write(seed, "b.txt", "b\n");
  sh(seed, "add", "-A");
  sh(seed, "commit", "-m", "init");
  sh(seed, "push", "-u", "origin", "staging");
  const work = join(root, "work");
  sh(root, "clone", origin, work);
  sh(work, "switch", "-c", "feature/1-x");
  write(work, "a.txt", "a changed\n");
  sh(work, "commit", "-am", "change a");
  write(work, "new.txt", "new\n");
  sh(work, "add", "-A");
  sh(work, "commit", "-m", "add new");
  return { root, origin, seed, work };
}

