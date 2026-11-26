import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commitOne, eachRepo, parseMessage, pushOne, summarize, updateOne } from "../src/bar/batch";
import { gitRun } from "../src/bar/ownWindow";
import { sh, write } from "./gitHelpers";

/** Two repositories "Repo A" and "Repo B" with a bare origin each, a clone of each on feature/5-x. */
function world() {
  const root = mkdtempSync(join(tmpdir(), "aihub-batch-"));
  const make = (name: string) => {
    const origin = join(root, `${name}.git`);
    mkdirSync(origin);
    sh(origin, "init", "--bare", "-b", "main");
    const clone = join(root, name);
    sh(root, "clone", origin, clone);
    sh(clone, "switch", "-c", "main");
    write(clone, "a.txt", "a\n");
    sh(clone, "add", "-A");
    sh(clone, "commit", "-m", "init");
    sh(clone, "push", "-u", "origin", "main");
    sh(clone, "switch", "-c", "feature/5-x");
    sh(clone, "push", "-u", "origin", "feature/5-x");
    // someone else's clone, to put commits on the remote
    const other = join(root, `${name}-other`);
    sh(root, "clone", origin, other);
    sh(other, "switch", "feature/5-x");
    return { name, origin, clone, other };
  };
  return { root, a: make("Repo A"), b: make("Repo B") };
}
const commitIn = (dir: string, file: string, text: string) => {
  write(dir, file, text);
  sh(dir, "add", "-A");
  sh(dir, "commit", "-m", file);
};

describe("Update all", () => {
  it("fast-forwards where it can, says why where it cannot, and goes on; one line per repository", async () => {
    const w = world();
    commitIn(w.a.other, "new-a.txt", "1");
    sh(w.a.other, "push", "origin", "feature/5-x");
    // repo B has a commit of its own and the remote another one: not a fast-forward
    commitIn(w.b.other, "theirs.txt", "1");
    sh(w.b.other, "push", "origin", "feature/5-x");
    commitIn(w.b.clone, "mine.txt", "1");
    const repos = [{ name: "Repo B", path: w.b.clone }, { name: "Repo A", path: w.a.clone }];
    const res = await eachRepo(repos, (r) => updateOne(gitRun, r));
    expect(res.map((r) => [r.repo, r.ok])).toEqual([["Repo B", false], ["Repo A", true]]);
    expect(res[1].line).toBe("Repo A: 1 new commit");
    expect(res[0].line).toContain("not updated, has commits of its own");
    expect(sh(w.a.clone, "log", "-1", "--format=%s").trim()).toBe("new-a.txt");
    expect(summarize("Update all", res).split("\n")[0]).toBe("Update all: 1 of 2 repositories done");
    // again: nothing new
    expect((await updateOne(gitRun, repos[1])).line).toBe("Repo A: already up to date");
  });
});

describe("Push all", () => {
  it("pushes what is ahead, says nothing to push, creates the remote branch of a new one, and a refused push stops only its repository", async () => {
    const w = world();
    commitIn(w.a.clone, "a2.txt", "1");
    sh(w.b.clone, "switch", "-c", "feature/5-new");
    commitIn(w.b.clone, "b2.txt", "1");
    const res = await eachRepo([{ name: "Repo A", path: w.a.clone }, { name: "Repo B", path: w.b.clone }], (r) => pushOne(gitRun, r));
    expect(res.map((r) => r.line)).toEqual(["Repo A: pushed 1 commit", "Repo B: pushed, new remote branch"]);
    expect(sh(w.b.origin, "branch", "--list", "feature/5-new")).toContain("feature/5-new");
    expect((await pushOne(gitRun, { name: "Repo A", path: w.a.clone })).line).toBe("Repo A: nothing to push");
    // a hook on the remote of repo A refuses; repo B is still pushed
    const hook = join(w.a.origin, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'rejected by policy' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    commitIn(w.a.clone, "a3.txt", "1");
    commitIn(w.b.clone, "b3.txt", "1");
    const again = await eachRepo([{ name: "Repo A", path: w.a.clone }, { name: "Repo B", path: w.b.clone }], (r) => pushOne(gitRun, r));
    expect(again.map((r) => r.ok)).toEqual([false, true]);
    expect(again[0].line).toContain("not pushed");
  });
});

describe("Commit all", () => {
  it("the message is type, scope and subject for aihub commit; one call per repository, in that repository; a failing hook in one does not stop the other", () => {
    expect(parseMessage("feat(export): add the csv")).toEqual({ type: "feat", scope: "export", subject: "add the csv" });
    expect(parseMessage("fix: x")).toEqual({ type: "fix", subject: "x" });
    expect(parseMessage("just words: here")).toEqual({ subject: "just words: here" });
    expect(parseMessage("add the csv")).toEqual({ subject: "add the csv" });
  });

  it("results per repository", async () => {
    const calls: { args: string[]; cwd: string }[] = [];
    const cli = async (args: string[], cwd: string) => {
      calls.push({ args, cwd });
      if (cwd.endsWith("Repo B")) throw new Error("git hooks stopped the commit: ruff failed (3 lines). choose: fix and run again | --skip-hooks ruff | --no-verify");
      if (cwd.endsWith("Repo C")) throw new Error("nothing to commit: no staged or changed files");
      return JSON.stringify({ sha: "abc1234", files: 2, pushed: args.includes("--push") });
    };
    const base = mkdtempSync(join(tmpdir(), "aihub-batch-dirs-"));
    const repos = ["Repo A", "Repo B", "Repo C"].map((n) => (mkdirSync(join(base, n)), { name: n, path: join(base, n) }));
    const res = await eachRepo(repos, (r) => commitOne(cli, r, "feat(export): add the csv", true), 1);
    expect(res.map((r) => [r.repo, r.ok, r.line])).toEqual([
      ["Repo A", true, "Repo A: committed abc1234 (2 files), pushed"],
      ["Repo B", false, "Repo B: git hooks stopped the commit: ruff failed (3 lines). choose: fix and run again | --skip-hooks ruff | --no-verify"],
      ["Repo C", true, "Repo C: nothing to commit"],
    ]);
    expect(calls[0]).toEqual({ args: ["commit", "--type", "feat", "--scope", "export", "--subject", "add the csv", "--push", "--json"], cwd: repos[0].path });
    expect(calls).toHaveLength(3);
    expect(res[1].detail).toContain("--skip-hooks ruff");
  });
});

describe("eachRepo", () => {
  it("an exception becomes the line of that repository; the order of the results is the order of the repositories", async () => {
    const here = mkdtempSync(join(tmpdir(), "aihub-each-"));
    const res = await eachRepo([{ name: "x", path: here }, { name: "y", path: here }, { name: "z", path: here }], async (r) => {
      if (r.name === "y") throw new Error("boom\nsecond line");
      await new Promise((ok) => setTimeout(ok, r.name === "x" ? 20 : 0));
      return { repo: r.name, ok: true, line: `${r.name}: ok` };
    });
    expect(res.map((r) => r.line)).toEqual(["x: ok", "y: boom", "z: ok"]);
  });
});

describe("the awkward repositories", () => {
  const lone = () => {
    const root = mkdtempSync(join(tmpdir(), "aihub-lone-"));
    const path = join(root, "Repo Alone");
    mkdirSync(path);
    sh(path, "init", "-b", "feature/5-x");
    write(path, "a.txt", "a\n");
    sh(path, "add", "-A");
    sh(path, "commit", "-m", "init");
    return { root, path };
  };

  it("a repository without a remote: update and push say so in one line, nothing throws, the others go on", async () => {
    const w = world();
    const l = lone();
    commitIn(w.a.clone, "a2.txt", "1");
    const res = await eachRepo([{ name: "Repo Alone", path: l.path }, { name: "Repo A", path: w.a.clone }], (r) => pushOne(gitRun, r));
    expect(res[0].ok).toBe(false);
    expect(res[0].line).toMatch(/^Repo Alone: not pushed, /);
    expect(res[1].line).toBe("Repo A: pushed 1 commit");
    const up = await updateOne(gitRun, { name: "Repo Alone", path: l.path });
    expect(up.ok).toBe(false);
    expect(up.line).toMatch(/^Repo Alone: not updated, /);
  });

  it("a folder that is gone: one line that names the repair, not a spawn error", async () => {
    const w = world();
    const res = await eachRepo([{ name: "Repo Gone", path: join(w.root, "nowhere") }, { name: "Repo A", path: w.a.clone }], (r) => updateOne(gitRun, r));
    expect(res[0]).toEqual({ repo: "Repo Gone", ok: false, line: "Repo Gone: its folder is missing (aihub worktree repair makes it again)" });
    expect(res[1].ok).toBe(true);
  });

  it("in the middle of a merge or a rebase nothing is updated, pushed or committed", async () => {
    const w = world();
    writeFileSync(join(w.a.clone, ".git", "MERGE_HEAD"), sh(w.a.clone, "rev-parse", "HEAD"));
    mkdirSync(join(w.b.clone, ".git", "rebase-merge"));
    const calls: string[] = [];
    const cli = async (args: string[]) => (calls.push(args[0]), "{}");
    const repos = [{ name: "Repo A", path: w.a.clone }, { name: "Repo B", path: w.b.clone }];
    const u = await eachRepo(repos, (r) => updateOne(gitRun, r));
    const p = await eachRepo(repos, (r) => pushOne(gitRun, r));
    const c = await eachRepo(repos, (r) => commitOne(cli, r, "fix: x", false), 1);
    expect(u.map((r) => r.line)).toEqual(["Repo A: a merge is in progress; finish or abort it first", "Repo B: a rebase is in progress; finish or abort it first"]);
    expect(p.every((r) => !r.ok) && c.every((r) => !r.ok)).toBe(true);
    expect(calls).toEqual([]);
  });

  it("Push All leaves the target branch alone", async () => {
    const w = world();
    sh(w.a.clone, "switch", "main");
    commitIn(w.a.clone, "on-main.txt", "1");
    const r = await pushOne(gitRun, { name: "Repo A", path: w.a.clone }, { protect: ["main"] });
    expect(r).toEqual({ repo: "Repo A", ok: true, line: "Repo A: on main, a protected or target branch: left alone" });
    expect(sh(w.a.origin, "rev-list", "--count", "main").trim()).toBe("1");
  });
});

describe("Push All and Commit All only do what was ticked (review F)", () => {
  it("push names the branch: a user setting such as push.default=upstream with a branch that tracks staging never pushes to staging", async () => {
    const w = world();
    sh(w.a.clone, "config", "push.default", "upstream");
    sh(w.a.clone, "branch", "--set-upstream-to=origin/main", "feature/5-x");
    const mainBefore = sh(w.a.origin, "rev-parse", "main").trim();
    commitIn(w.a.clone, "a2.txt", "1");
    const r = await pushOne(gitRun, { name: "Repo A", path: w.a.clone }, { protect: ["main", "master"] });
    expect(r.line).toBe("Repo A: pushed 1 commit");
    expect(sh(w.a.origin, "rev-parse", "main").trim()).toBe(mainBefore);
    expect(sh(w.a.origin, "log", "-1", "--format=%s", "feature/5-x").trim()).toBe("a2.txt");
  });

  it("main, master, the target and a protected branch of team.yaml are left alone; a detached HEAD says so", async () => {
    const w = world();
    sh(w.a.clone, "switch", "-c", "master");
    commitIn(w.a.clone, "x.txt", "1");
    const alone = await pushOne(gitRun, { name: "Repo A", path: w.a.clone }, { protect: ["main", "master"] });
    expect(alone.line).toBe("Repo A: on master, a protected or target branch: left alone");
    expect(sh(w.a.origin, "branch", "--list", "master").trim()).toBe("");
    sh(w.b.clone, "checkout", "--detach");
    expect((await pushOne(gitRun, { name: "Repo B", path: w.b.clone })).line).toContain("detached HEAD");
    const { protectedBranches } = await import("../src/bar/repoStatus");
    const dir = mkdtempSync(join(tmpdir(), "aihub-prot-"));
    mkdirSync(join(dir, ".agents", "skills", "_shared", "references"), { recursive: true });
    writeFileSync(join(dir, ".agents", "skills", "_shared", "references", "team.yaml"), "branches:\n  protected: [main, release/*]\n");
    expect(protectedBranches(dir)).toEqual(["main", "release/*"]);
    writeFileSync(join(dir, ".agents", "skills", "_shared", "references", "team.yaml"), "branches:\n  protected:\n    - main\n    - \"staging\"\nother: 1\n");
    expect(protectedBranches(dir)).toEqual(["main", "staging"]);
  });

  it("commit with a file list adds exactly those files by name, commits with --no-add, and leaves the others alone", async () => {
    const w = world();
    write(w.a.clone, "mine.txt", "1\n");
    write(w.a.clone, "other.txt", "2\n");
    const calls: string[][] = [];
    const cli = async (args: string[]) => (calls.push(args), JSON.stringify({ sha: "abc", files: 1 }));
    const r = await commitOne(cli, { name: "Repo A", path: w.a.clone, files: ["mine.txt"] }, "fix: x", false, gitRun);
    expect(r.ok).toBe(true);
    expect(calls[0]).toContain("--no-add");
    expect(sh(w.a.clone, "diff", "--cached", "--name-only").trim()).toBe("mine.txt");
    expect(sh(w.a.clone, "status", "--porcelain").includes("?? other.txt")).toBe(true);
  });

  it("files that were staged already and are not in the list stop that repository: nothing is committed", async () => {
    const w = world();
    write(w.a.clone, "mine.txt", "1\n");
    write(w.a.clone, "staged.txt", "2\n");
    sh(w.a.clone, "add", "staged.txt");
    const calls: string[][] = [];
    const r = await commitOne(async (a) => (calls.push(a), "{}"), { name: "Repo A", path: w.a.clone, files: ["mine.txt"] }, "fix: x", false, gitRun);
    expect(r.ok).toBe(false);
    expect(r.line).toBe("Repo A: 1 other file is staged already (staged.txt); unstage it or leave the file list out");
    expect(calls).toEqual([]);
  });

  it("without a file list every change of that repository is committed (aihub commit adds it), and a repository that is not in the list is not in the call at all", async () => {
    const calls: { args: string[]; cwd: string }[] = [];
    const cli = async (args: string[], cwd: string) => (calls.push({ args, cwd }), JSON.stringify({ sha: "abc" }));
    const dirs = ["Repo A", "Repo B"].map((n) => {
      const d = mkdtempSync(join(tmpdir(), "aihub-cm-"));
      return { name: n, path: d };
    });
    await eachRepo([dirs[0]], (r) => commitOne(cli, r, "fix: x", false, gitRun), 1);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).not.toContain("--no-add");
    expect(calls[0].cwd).toBe(dirs[0].path);
  });
});
