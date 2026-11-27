import { describe, expect, it } from "vitest";
import { createPullRequests, madeLinks, prOffers } from "../src/bar/createPrs";
import type { BarRepo } from "../src/bar/types";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = mkdtempSync(join(tmpdir(), "aihub-prs-dirs-"));
/** a folder that exists (the repositories are real folders to the code under test) */
const d = (n: string) => (mkdirSync(join(base, n), { recursive: true }), join(base, n));

const repo = (name: string, o: Partial<BarRepo> = {}): BarRepo => ({ name, path: `/w/${name}`, branch: "feature/5-x", storyBranch: true, ...o });

describe("which repositories get a pull request", () => {
  it("only story branches without a pull request are ticked; the others say why not; uncommitted work is named", () => {
    const offers = prOffers([
      repo("repo-a", { changes: 2 }),
      repo("repo-b", { pr: { id: 812, status: "failed", url: "u" } }),
      repo("repo-c", { branch: "main", storyBranch: false }),
      repo("repo-d", { pr: { id: 7, status: "merged", url: "u" } }),
      repo("repo-e"),
    ]);
    expect(offers.map((o) => [o.repo, o.enabled, o.picked, o.reason])).toEqual([
      ["repo-a", true, true, "2 uncommitted files stay out"],
      ["repo-b", false, false, "812 exists · failed"],
      ["repo-c", false, false, "not on a story branch"],
      ["repo-d", false, false, "7 merged"],
      ["repo-e", true, true, undefined],
    ]);
  });
});

describe("create the pull requests", () => {
  it("one aihub pr create per ticked repository, in that repository, linked to the story; then one link-prs; a failure fails only its repository", async () => {
    const calls: { args: string[]; cwd: string }[] = [];
    const cli = async (args: string[], cwd: string) => {
      calls.push({ args, cwd });
      if (args[0] === "pr" && cwd.endsWith("repo-b")) throw new Error("the branch has no commits of its own\nsecond line");
      if (args[0] === "pr") return JSON.stringify({ id: cwd.endsWith("repo-a") ? 901 : 902, url: `https://x/${cwd}`, action: "created" });
      return JSON.stringify({ results: [] });
    };
    const { results, linked } = await createPullRequests(cli, [{ name: "repo-a", path: d("repo-a"), target: "staging" }, { name: "repo-b", path: d("repo-b") }, { name: "repo-c", path: d("repo-c") }], 5);
    expect(results.map((r) => [r.repo, r.ok, r.line, r.id])).toEqual([
      ["repo-a", true, "repo-a: PR !901 created", 901],
      ["repo-b", false, "repo-b: the branch has no commits of its own", undefined],
      ["repo-c", true, "repo-c: PR !902 created", 902],
    ]);
    expect(calls[0]).toEqual({ args: ["pr", "create", "--work-item", "5", "--target", "staging", "--json"], cwd: d("repo-a") });
    expect(calls.filter((c) => c.args[0] === "crossrepo")).toEqual([{ args: ["crossrepo", "link-prs", "--story", "5", "--json"], cwd: d("repo-a") }]);
    expect(linked).toContain("list each other");
  });

  it("nothing created: no link step", async () => {
    const calls: string[][] = [];
    const { results, linked } = await createPullRequests(async (a) => (calls.push(a), Promise.reject(new Error("no"))), [{ name: "repo-a", path: d("a") }], 5);
    expect(results[0].ok).toBe(false);
    expect(linked).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});

describe("progress and links", () => {
  it("the progress names each repository while it is pushed and gets its pull request; the message gets the links of the ones made", async () => {
    const steps: string[] = [];
    const cli = async (args: string[], cwd: string) => {
      if (args[0] === "crossrepo") return "{}";
      if (cwd.endsWith("b")) throw new Error("fatal: could not read Username for 'https://dev.azure.com': terminal prompts disabled\nmore");
      return JSON.stringify({ id: 1261, url: "https://dev.azure.com/ferron-test/test-project/_git/a/pullrequest/1261", action: "created" });
    };
    const { results } = await createPullRequests(cli, [{ name: "a", path: d("a") }, { name: "b", path: d("b") }], 3749, (t) => steps.push(t));
    expect(steps).toEqual(["a (1 of 2): push and pull request", "b (2 of 2): push and pull request"]);
    expect(madeLinks(results)).toEqual(["https://dev.azure.com/ferron-test/test-project/_git/a/pullrequest/1261"]);
    expect(results[1]).toMatchObject({ ok: false, line: "b: fatal: could not read Username for 'https://dev.azure.com': terminal prompts disabled" });
  });

  it("the command shows progress per repository, reads the pull requests again and offers Open Pull Requests", () => {
    const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "../src/bar/batchUi.ts"), "utf8") as string;
    expect(src).toMatch(/createPullRequests\(cli, picked, state\.story!\.id, \(text\) => progress\.report\(\{ message: text \}\)\)/);
    expect(src).toMatch(/h\.refreshPrs\?\.\(\)\.then\(\(\) => h\.changed\(\)/);
    expect(src).toContain('"Open Pull Requests"');
    expect(src).toMatch(/madeLinks\(results\)/);
    expect(src).toContain("no repository was ticked, so no pull request was made");
    expect(src).toMatch(/h\.log\(`create pull requests: \$\{picked\.map/);
  });
});

describe("pull requests for repositories that are not fit", () => {
  it("a missing folder and a merge in progress give their own line and no aihub call", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "aihub-prs-"));
    const merging = join(root, "m");
    mkdirSync(join(merging, ".git"), { recursive: true });
    writeFileSync(join(merging, ".git", "MERGE_HEAD"), "x");
    const calls: string[][] = [];
    const { results, linked } = await createPullRequests(async (a) => (calls.push(a), "{}"), [{ name: "gone", path: join(root, "nowhere") }, { name: "merging", path: merging }], 5);
    expect(results.map((r) => r.line)).toEqual(["gone: its folder is missing (aihub worktree repair makes it again)", "merging: a merge is in progress; finish or abort it first"]);
    expect(calls).toEqual([]);
    expect(linked).toBeUndefined();
  });
});
