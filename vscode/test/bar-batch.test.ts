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
    const repos = ["Repo A", "Repo B", "Repo C"].map((n) => ({ name: n, path: `/w/${n}` }));
    const res = await eachRepo(repos, (r) => commitOne(cli, r, "feat(export): add the csv", true), 1);
    expect(res.map((r) => [r.repo, r.ok, r.line])).toEqual([
      ["Repo A", true, "Repo A: committed abc1234 (2 files), pushed"],
      ["Repo B", false, "Repo B: git hooks stopped the commit: ruff failed (3 lines). choose: fix and run again | --skip-hooks ruff | --no-verify"],
      ["Repo C", true, "Repo C: nothing to commit"],
    ]);
    expect(calls[0]).toEqual({ args: ["commit", "--type", "feat", "--scope", "export", "--subject", "add the csv", "--push", "--json"], cwd: "/w/Repo A" });
    expect(calls).toHaveLength(3);
    expect(res[1].detail).toContain("--skip-hooks ruff");
  });
});

describe("eachRepo", () => {
  it("an exception becomes the line of that repository; the order of the results is the order of the repositories", async () => {
    const res = await eachRepo([{ name: "x", path: "1" }, { name: "y", path: "2" }, { name: "z", path: "3" }], async (r) => {
      if (r.name === "y") throw new Error("boom\nsecond line");
      await new Promise((ok) => setTimeout(ok, r.name === "x" ? 20 : 0));
      return { repo: r.name, ok: true, line: `${r.name}: ok` };
    });
    expect(res.map((r) => r.line)).toEqual(["x: ok", "y: boom", "z: ok"]);
  });
});
