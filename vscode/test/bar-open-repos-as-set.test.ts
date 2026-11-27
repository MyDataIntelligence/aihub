import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
// the CLI's own packages (yaml) are there only where cli/ was installed too (locally); the CI job of the extension installs vscode/ only
const cliInstalled = existsSync(join(__dirname, "..", "..", "cli", "node_modules", "yaml"));
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { branchFor, list } from "../../cli/src/lib/cliargs";
// repoSet reaches the CLI's Azure DevOps client (fetch types the extension's tsconfig does not have): loaded at run time only
const cliLib = "../../cli/src/lib/";
const loadOpenSet = async () => ((await import(/* @vite-ignore */ `${cliLib}repoSet`)) as { openSet: (ctx: unknown, o: Record<string, unknown>) => unknown }).openSet;
import { repoNameOfUrl } from "../../cli/src/lib/repoName";
import { branchesOf, cliNameOf, cloneOf, openArgs, parseOpenRepos, remoteKey, resultOf } from "../src/bar/openReposAsSet";
import { BAR_COMMANDS } from "../src/bar/types";
import { sh, write } from "./gitHelpers";

describe("open repositories as a set: the argument", () => {
  it("needs repositories with a name and a branch (own, new, or the shared new one)", () => {
    expect(parseOpenRepos(undefined)).toMatchObject({ problem: expect.stringMatching(/which repositories/) });
    expect(parseOpenRepos({ repos: [{ branch: "main" }] })).toMatchObject({ problem: "every repository needs a name" });
    expect(parseOpenRepos({ repos: [{ name: "repo-a" }] })).toMatchObject({ problem: expect.stringMatching(/repo-a: which branch/) });
    expect(parseOpenRepos({ repos: [{ name: "repo-a", branch: "x" }, { name: "Repo-A", branch: "y" }] })).toMatchObject({ problem: "Repo-A is in the list twice" });
    expect(parseOpenRepos({ repos: [{ name: "repo-a" }], newBranch: "feature/12-x", story: "12", window: "this" })).toEqual({ repos: [{ name: "repo-a", project: undefined, remoteUrl: undefined, branch: undefined, newBranch: undefined, from: undefined }], story: 12, window: "this", newBranch: "feature/12-x", from: undefined });
  });

  it("gives each repository its branch and base; the set is named after the shared new branch", () => {
    const arg = parseOpenRepos({
      repos: [{ name: "repo-a" }, { name: "repo-b", branch: "release/1.2" }, { name: "repo-c", newBranch: "feature/12-c", from: "develop" }],
      newBranch: "feature/12-x",
      from: "staging",
    }) as never;
    expect(branchesOf(arg)).toEqual({
      setBranch: "feature/12-x",
      per: [
        { name: "repo-a", branch: "feature/12-x", from: "staging" },
        { name: "repo-b", branch: "release/1.2", from: undefined },
        { name: "repo-c", branch: "feature/12-c", from: "develop" },
      ],
    });
    expect(branchesOf(parseOpenRepos({ repos: [{ name: "a", branch: "main" }, { name: "b", newBranch: "feature/1-b" }] }) as never).setBranch).toBe("feature/1-b");
  });

  it("finds the clone of a repository by its remote in every url form, else by name", () => {
    expect(remoteKey("https://ferron-test@dev.azure.com/ferron-test/test-project/_git/repo-a")).toBe("ferron-test/test-project/repo-a");
    expect(remoteKey("git@ssh.dev.azure.com:v3/ferron-test/test-project/repo-a")).toBe("ferron-test/test-project/repo-a");
    expect(remoteKey("https://ferron-test.visualstudio.com/DefaultCollection/test-project/_git/Repo%20A")).toBe("ferron-test/test-project/repo a");
    const locals = [
      { name: "repo-a", path: "C:/src/repo-a-copy", remote: "https://dev.azure.com/ferron-test/test-project/_git/repo-a" },
      { name: "repo-b", path: "C:/src/repo-b" },
      { name: "repo-c", path: "C:/src/repo-c", remote: "https://dev.azure.com/ferron-test/other/_git/repo-c" },
    ];
    expect(cloneOf({ name: "repo-a", remoteUrl: "git@ssh.dev.azure.com:v3/ferron-test/test-project/repo-a" }, locals)?.path).toBe("C:/src/repo-a-copy");
    expect(cloneOf({ name: "repo-b", remoteUrl: "https://dev.azure.com/ferron-test/test-project/_git/repo-b" }, locals)?.path).toBe("C:/src/repo-b");
    // the same name in another project is another repository
    expect(cloneOf({ name: "repo-c", remoteUrl: "https://dev.azure.com/ferron-test/test-project/_git/repo-c" }, locals)).toBeUndefined();
    expect(cloneOf({ name: "REPO-B" }, locals)?.path).toBe("C:/src/repo-b");
    expect(cliNameOf("C:/src/repo-a-copy", "https://dev.azure.com/ferron-test/test-project/_git/repo-a", repoNameOfUrl)).toBe("repo-a");
    expect(cliNameOf("C:/src/loose/", undefined, repoNameOfUrl)).toBe("loose");
  });

  it("answers per repository, with the clones and the failures that never reached the CLI", () => {
    const r = resultOf(
      { story: 12, folder: "C:/sets/12-x", workspace: "C:/sets/12-x/story-12.code-workspace", repos: [{ repo: "repo-a", ok: true, state: "created", branch: "feature/12-x", path: "C:/sets/12-x/repo-a", note: "made" }, { repo: "repo-b", ok: false, state: "failed", branch: "x", note: "branch x is checked out in C:/src/repo-b" }] },
      { opened: true, cloned: ["repo-a"], failed: [{ repo: "repo-z", ok: false, branch: "feature/12-x", error: "repo-z could not be cloned: not found" }] },
    );
    expect(r).toEqual({
      story: 12,
      folder: "C:/sets/12-x",
      workspace: "C:/sets/12-x/story-12.code-workspace",
      opened: true,
      repos: [
        { repo: "repo-a", ok: true, branch: "feature/12-x", path: "C:/sets/12-x/repo-a", cloned: true, state: "created" },
        { repo: "repo-b", ok: false, branch: "x", state: "failed", error: "branch x is checked out in C:/src/repo-b" },
        { repo: "repo-z", ok: false, branch: "feature/12-x", error: "repo-z could not be cloned: not found" },
      ],
    });
    expect(BAR_COMMANDS.openReposAsSet).toBe("aihub.bar.openReposAsSet");
  });
});

/** Synthetic repositories with a bare origin each; repo-b's folder is named differently from its remote, and has a pushed develop. */
function world() {
  const root = mkdtempSync(join(tmpdir(), "aihub-reposet-"));
  const make = (name: string, folder = name) => {
    const origin = join(root, "origins", `${name}.git`);
    mkdirSync(origin, { recursive: true });
    sh(origin, "init", "--bare", "-b", "main");
    const clone = join(root, "src", folder);
    mkdirSync(join(root, "src"), { recursive: true });
    sh(join(root, "src"), "clone", origin, clone);
    sh(clone, "switch", "-c", "main");
    write(clone, "README.md", `${name}\n`);
    sh(clone, "add", "-A");
    sh(clone, "commit", "-m", "init");
    sh(clone, "push", "-u", "origin", "main");
    return { name, origin, clone };
  };
  const a = make("repo-a");
  const b = make("repo-b", "repo-b-copy");
  sh(b.clone, "switch", "-c", "develop");
  write(b.clone, "develop.txt", "develop\n");
  sh(b.clone, "add", "-A");
  sh(b.clone, "commit", "-m", "develop");
  sh(b.clone, "push", "-u", "origin", "develop");
  sh(b.clone, "switch", "main");
  sh(a.clone, "branch", "release/1.2");
  return { root, a, b };
}

describe("open repositories as a set: the CLI call on real repositories", () => {
  it.skipIf(!cliInstalled)("makes one set: an existing branch in one, a new branch from its own base in the other", async () => {
    const { root, a, b } = world();
    const arg = parseOpenRepos({ repos: [{ name: "repo-a", branch: "release/1.2" }, { name: "repo-b", newBranch: "feature/12-from-develop", from: "develop" }], story: 12 }) as never;
    const present = [
      { name: "repo-a", cliName: cliNameOf(a.clone, a.origin, repoNameOfUrl), path: a.clone },
      { name: "repo-b", cliName: cliNameOf(b.clone, b.origin, repoNameOfUrl), path: b.clone },
    ];
    const args = openArgs(arg, present);
    expect(args).toContain("--from-for");
    const out: string[] = [];
    const errs: string[] = [];
    const env = { ...process.env, AIHUB_CONFIG_HOME: join(root, "cfg"), AIHUB_HOME: join(root, "home") };
    // the options `aihub worktree open` makes of these arguments (commands/worktree.ts), then the set itself
    const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
    const ctx = { cwd: a.clone, env, fetch: (async () => new Response("{}", { status: 404 })) as never, out: (l: string) => out.push(l), err: (l: string) => errs.push(l) };
    const openSet = await loadOpenSet();
    out.push(JSON.stringify(openSet(ctx, { repos: list(flag("--repos")), branch: flag("--branch")!, branches: branchFor(flag("--branch-for")), froms: branchFor(flag("--from-for")), storyId: Number(flag("--story")), newSet: args.includes("--new-set"), window: "none" })));
    expect(errs.join("\n")).toBe("");
    const res = JSON.parse(out.join("\n"));
    expect(res.story).toBe(12);
    const ra = res.repos.find((x: { repo: string }) => x.repo === "repo-a");
    const rb = res.repos.find((x: { repo: string }) => x.repo === "repo-b");
    expect(ra).toMatchObject({ ok: true, branch: "release/1.2" });
    expect(rb).toMatchObject({ ok: true, branch: "feature/12-from-develop" });
    expect(existsSync(join(rb.path, "develop.txt"))).toBe(true);
    expect(existsSync(join(ra.path, "develop.txt"))).toBe(false);
    expect(existsSync(res.workspace)).toBe(true);
    const answer = resultOf(res, { opened: false, cloned: [], failed: [] });
    expect(answer.repos.map((r) => [r.repo, r.ok])).toEqual([
      ["repo-a", true],
      ["repo-b", true],
    ]);
  });
});
