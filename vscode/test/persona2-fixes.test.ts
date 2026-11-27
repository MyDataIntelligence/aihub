import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DIVERGED, divergedRepos, updateOne } from "../src/bar/batch";

import { plainError } from "../src/bar/plainError";
import { prListCalls } from "../src/bar/repoStatus";
import { buildModel, knownTitle, statusItems } from "../src/model";

const root = join(__dirname, "..");

describe("persona round 2: behind the target updates by itself (N4)", () => {
  it("aiContextHub.behindTarget is auto by default, also when the setting is not read", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.contributes.configuration.find?.((c: { properties: Record<string, unknown> }) => c.properties["aiContextHub.behindTarget"])?.properties["aiContextHub.behindTarget"].default ?? JSON.stringify(pkg).match(/"aiContextHub\.behindTarget":\s*\{[^}]*?"default":\s*"(\w+)"/)?.[1]).toBe("auto");
    expect(readFileSync(join(root, "src/bar/register.ts"), "utf8")).toContain('cfg().get<string>("behindTarget", "auto")');
  });
});

describe("persona round 2: the pull requests of a set are found by its branches (N3)", () => {
  it("one call per branch of the set, by anyone, in any state; more than three branches: the newest of mine as before", () => {
    expect(prListCalls(["feature/3749-x", "feature/3749-x"], false)).toEqual([["pr", "list", "--branch", "feature/3749-x", "--status", "all", "--json"]]);
    expect(prListCalls(["feature/1-a", "feature/1-b"], true)).toEqual([
      ["pr", "list", "--branch", "feature/1-a", "--status", "all", "--builds", "--json"],
      ["pr", "list", "--branch", "feature/1-b", "--status", "all", "--builds", "--json"],
    ]);
    expect(prListCalls(["a", "b", "c", "d"], false)).toEqual([["pr", "list", "--mine", "--status", "all", "--json"]]);
    expect(prListCalls(["", "HEAD"], false)).toEqual([["pr", "list", "--mine", "--status", "all", "--json"]]);
    expect(readFileSync(join(root, "src/bar/register.ts"), "utf8")).toMatch(/for \(const args of prListCalls\(f\.set!\.repos\.map\(\(r\) => r\.branch\), builds\)\)/);
  });
});

describe("persona round 2: Update All offers Update from Target for a branch with commits of its own (N6)", () => {
  it("the diverged reason names the button, and only those repositories get it", async () => {
    const git = async (_p: string, args: string[]) => {
      if (args[0] === "pull") throw new Error("fatal: Not possible to fast-forward, aborting.");
      return "abc\n";
    };
    const r = await updateOne(git, { name: "test-developers", path: "/w/d" });
    expect(r).toMatchObject({ ok: false, line: `test-developers: not updated, ${DIVERGED}` });
    expect(DIVERGED).toContain("Update from Target");
    const repos = [{ name: "test-consumer", path: "/w/c" }, { name: "test-developers", path: "/w/d" }];
    expect(divergedRepos(repos, [{ repo: "test-consumer", ok: true, line: "test-consumer: already up to date" }, r])).toEqual([repos[1]]);
    const ui = readFileSync(join(root, "src/bar/batchUi.ts"), "utf8");
    expect(ui).toMatch(/label: "Update from Target", run: \(\) => updateFromTarget\(h, diverged\)/);
    expect(ui).toMatch(/cli\(\["branch", "update", "--no-push"/);
  });
});

describe("persona round 2: a repository that is not on Azure DevOps is not 'not signed in' (N7)", () => {
  it("TF401019 and 'repository not found' say the remote points nowhere; a real sign-in failure still says sign in", () => {
    const tf = "remote: TF401019: The Git repository with name or identifier repo_z does not exist or you do not have permissions for the operation you are attempting.\nfatal: repository 'https://dev.azure.com/x/y/_git/repo_z/' not found";
    expect(plainError(tf).text).toBe("this repository is not on Azure DevOps (its remote points nowhere, or you have no access to it); check the remote of the clone");
    expect(plainError("fatal: Authentication failed for 'https://dev.azure.com/x/y/_git/a/'").text).toMatch(/^you are not signed in/);
    expect(plainError("TF400813: The user is not authorized").text).toMatch(/^you are not signed in/);
  });
});

describe("persona round 2: the status bar never says '(unknown)' (C2)", () => {
  it("a title that could not be read is left out: '#3748', the tooltip still names the story", () => {
    expect(knownTitle("(unknown)")).toBe(false);
    expect(knownTitle("")).toBe(false);
    expect(knownTitle("Klantportaal vijf repos")).toBe(true);
    const unknown = statusItems(buildModel({ status: { branch: "feature/3748-x", signedIn: true, story: { id: 3748, title: "(unknown)", state: "?" } } } as never)).find((i) => i.id === "story");
    expect(unknown?.text).toBe("$(git-branch) #3748");
    const known = statusItems(buildModel({ status: { branch: "feature/3748-x", signedIn: true, story: { id: 3748, title: "Klantportaal vijf repos", state: "Active" } } } as never)).find((i) => i.id === "story");
    expect(known?.text).toBe("$(git-branch) #3748 Klantportaal vijf repos");
  });
});
