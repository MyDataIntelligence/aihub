import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BrowseMemo, REMEMBER_FAILURE_MS, browseArgs, browseErrorOf, pushFiles, removePushFiles, scopeOf } from "../src/bar/browse";
import { BAR_COMMANDS } from "../src/bar/types";

const C1 = "1".repeat(40);

describe("repository browser in the bar: arguments", () => {
  it("builds one aihub browse call per command", () => {
    expect(browseArgs.projects()).toEqual(["browse", "projects"]);
    expect(browseArgs.projects({ org: "ferron-test", refresh: true })).toEqual(["browse", "projects", "--org", "ferron-test", "--refresh"]);
    expect(browseArgs.project({ project: "test-project", days: 14 })).toEqual(["browse", "project", "--project", "test-project", "--days", "14"]);
    expect(browseArgs.repo({ project: "test-project", repo: "repo-a", ref: "tag:v1.2" })).toEqual(["browse", "repo", "--project", "test-project", "--repo", "repo-a", "--ref", "tag:v1.2"]);
    expect(browseArgs.items({ project: "p", repo: "r", path: "/dbt", lastCommit: true })).toEqual(["browse", "items", "--project", "p", "--repo", "r", "--path", "/dbt", "--last-commit"]);
    expect(browseArgs.file({ project: "p", repo: "r", path: "/a.py", ref: `commit:${C1}`, maxBytes: 5000 })).toEqual(["browse", "file", "--project", "p", "--repo", "r", "--ref", `commit:${C1}`, "--path", "/a.py", "--max-bytes", "5000"]);
    expect(browseArgs.branches({ project: "p", repo: "r", filter: "4711", top: 20 })).toEqual(["browse", "branches", "--project", "p", "--repo", "r", "--filter", "4711", "--top", "20"]);
    expect(browseArgs.history({ project: "p", repo: "r", path: "/a.py", top: 50, skip: 50 })).toEqual(["browse", "history", "--project", "p", "--repo", "r", "--path", "/a.py", "--top", "50", "--skip", "50"]);
    expect(browseArgs.diff({ project: "p", repo: "r", commit: C1, path: "/a.py" })).toEqual(["browse", "diff", "--commit", C1, "--path", "/a.py", "--project", "p", "--repo", "r"]);
    expect(browseArgs.blame({ project: "p", repo: "r", path: "/a.py" })).toEqual(["browse", "blame", "--path", "/a.py", "--project", "p", "--repo", "r"]);
    expect(browseArgs.find({ query: "orders_exp", repos: ["test-project/repo-a", "test-project/repo-b"] })).toEqual(["browse", "find", "--query", "orders_exp", "--repos", "test-project/repo-a,test-project/repo-b"]);
    expect(browseArgs.search({ text: "MAX_RETRIES", project: "p", ext: ["py", "sql"], top: 10 })).toEqual(["browse", "search", "--text", "MAX_RETRIES", "--project", "p", "--top", "10", "--ext", "py,sql"]);
    expect(browseArgs.search({ text: "x", scope: [{ project: "p1" }, { project: "p2", repo: "r" }], branch: "main", local: true })).toEqual(["browse", "search", "--text", "x", "--scope", "p1,p2/r", "--branch", "main", "--local"]);
    expect(browseArgs.createPr({ project: "p", repo: "r", branch: "feature/4711-fix", story: 4711, draft: true })).toEqual(["browse", "pr", "--branch", "feature/4711-fix", "--project", "p", "--repo", "r", "--story", "4711", "--draft"]);
    expect(browseArgs.related({ project: "p", repo: "r", path: "/a.py", top: 5 })).toEqual(["browse", "related", "--project", "p", "--repo", "r", "--path", "/a.py", "--top", "5"]);
    expect(browseArgs.suggestBranch({ story: 4711, path: "/a.py" })).toEqual(["browse", "suggest-branch", "--story", "4711", "--path", "/a.py"]);
  });

  it("refuses a call without its required arguments", () => {
    expect(() => browseArgs.repo({ project: "p" } as never)).toThrow(/project and a repository/);
    expect(() => browseArgs.file({ project: "p", repo: "r" } as never)).toThrow(/path/);
    expect(() => browseArgs.find({ query: " " })).toThrow(/file name/);
  });

  it("push: content and message in private files, removed after; PR flags only with pr", () => {
    const { args, dir } = pushFiles({ project: "p", repo: "r", path: "/a.py", baseCommit: C1, baseBranch: "main", content: "x = 1\n", branch: "feature/4711-fix", message: "Fix", pr: true, story: 4711, rebase: true });
    expect(args.slice(0, 12)).toEqual(["browse", "push", "--project", "p", "--repo", "r", "--path", "/a.py", "--base-commit", C1, "--base-branch", "main"]);
    expect(readFileSync(args[args.indexOf("--content-file") + 1], "utf8")).toBe("x = 1\n");
    expect(readFileSync(args[args.indexOf("--message-file") + 1], "utf8")).toBe("Fix");
    expect(args.slice(-4)).toEqual(["--pr", "--story", "4711", "--rebase"]);
    removePushFiles(dir);
    expect(existsSync(join(dir, "content"))).toBe(false);
    const plain = pushFiles({ project: "p", repo: "r", path: "/a.py", baseCommit: C1, baseBranch: "main", content: "", branch: "b", message: "m", story: 1 });
    expect(plain.args).not.toContain("--story");
    removePushFiles(plain.dir);
    expect(() => pushFiles({ project: "p", repo: "r", path: "/a.py", baseCommit: C1, baseBranch: "main", content: "x", branch: "", message: "m" })).toThrow(/branch/);
  });

  it("every browse command is in the contract", () => {
    for (const id of ["browseProjects", "browseProject", "browseRepo", "browseItems", "browseFile", "browseBranches", "browseHistory", "browseDiff", "browseBlame", "browseFind", "browseSearch", "browseSuggestBranch", "browsePush", "browseCreatePr", "browseRetryNow"])
      expect((BAR_COMMANDS as Record<string, string>)[id]).toBe(`aihub.bar.${id}`);
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
    const ids = pkg.contributes.commands.map((c: { command: string }) => c.command);
    expect(ids).toContain("aihub.bar.browsePush");
    expect(pkg.contributes.menus.commandPalette).toContainEqual({ command: "aihub.bar.browsePush", when: "false" });
  });
});

describe("repository browser in the bar: failures", () => {
  it("takes the kind from the CLI's error JSON", () => {
    const text = 'aihub: pushing to \'main\' is refused {"error":{"kind":"protectedBranch","message":"pushing to \'main\' is refused"}}';
    expect(browseErrorOf(new Error(text))).toEqual({ error: { kind: "protectedBranch", message: "pushing to 'main' is refused" } });
    expect(browseErrorOf(new Error("aihub: unknown command 'browse'; did you mean: branch?")).error.kind).toBe("cliTooOld");
    expect(browseErrorOf({ kind: "missing", message: "aihub was not found" }).error.kind).toBe("cliMissing");
    expect(browseErrorOf(new Error("aihub: not signed in to Azure DevOps: run 'az login'")).error.kind).toBe("signedOut");
    expect(browseErrorOf(new Error("boom")).error).toEqual({ kind: "failed", message: "boom" });
    // criteria not proven: the counts and the three choices come along for the dialog
    expect(browseErrorOf(new Error('{"error":{"kind":"criteriaNotProven","message":"2 of 2 ... Nothing was pushed.","proven":0,"total":2,"choices":["testFirst","draft","anyway"]}}')).error).toEqual({ kind: "criteriaNotProven", message: "2 of 2 ... Nothing was pushed.", proven: 0, total: 2, choices: ["testFirst", "draft", "anyway"] });
  });

  it("remembers lasting failures 5 minutes per scope and shares a running read", async () => {
    let t = 1_000;
    const memo = new BrowseMemo(() => t);
    let calls = 0;
    const signedOut = () => {
      calls++;
      return Promise.reject(new Error('{"error":{"kind":"signedOut","message":"not signed in"}}'));
    };
    const key = scopeOf({ org: "ferron-test", project: "p", repo: "r" }, "repo");
    expect(await memo.read("a", key, signedOut)).toEqual({ error: { kind: "signedOut", message: "not signed in" } });
    await memo.read("b", key, signedOut);
    expect(calls).toBe(1);
    t += REMEMBER_FAILURE_MS + 1;
    await memo.read("b", key, signedOut);
    expect(calls).toBe(2);
    // a conflict-like ordinary failure is not remembered
    let n = 0;
    const notFound = () => (n++, Promise.reject(new Error('{"error":{"kind":"notFound","message":"x"}}')));
    await memo.read("c", "other", notFound);
    await memo.read("c", "other", notFound);
    expect(n).toBe(2);
    // two equal reads at once: one process
    let m = 0;
    const slow = () => (m++, new Promise((r) => setTimeout(() => r({ ok: true }), 10)));
    const [x, y] = await Promise.all([memo.read("d", "s", slow), memo.read("d", "s", slow)]);
    expect(x).toEqual(y);
    expect(m).toBe(1);
    memo.forget();
  });
});
