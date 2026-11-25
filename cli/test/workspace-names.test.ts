import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commands, main } from "../src/router.js";
import { readSetFile, repoBranch } from "../src/lib/setFile.js";
import { syncRepoName } from "../src/lib/workspaceNames.js";
import { ctxFor, fakeFetch, sh } from "./helpers.js";
import { makeNamedRepo, newParent } from "./parity-helpers.js";

const run = async (cwd: string, argv: string[]) => {
  const { ctx, lines, errs } = ctxFor(cwd, fakeFetch([]).fn);
  const code = await main(argv, ctx, commands);
  return { code, out: lines.join("\n"), err: errs.join("\n") };
};
const names = (ws: string) => (JSON.parse(readFileSync(ws, "utf8")).folders as { name: string }[]).map((f) => f.name);

async function world() {
  const parent = newParent();
  const dirs = ["repo-a", "repo-b"].map((n) => makeNamedRepo(parent, n).dir);
  for (const d of dirs) {
    sh(d, ["config", "user.name", "Test"]);
    sh(d, ["config", "user.email", "test@example.invalid"]);
  }
  const o = JSON.parse((await run(dirs[0], ["worktree", "open", "--repos", "repo-a,repo-b", "--branch", "feature/5-x", "--story", "5", "--window", "none", "--json"])).out);
  const wt = (n: string) => o.repos.find((r: { repo: string }) => r.repo === n).path as string;
  return { parent, dirs, folder: o.folder as string, ws: o.workspace as string, a: wt("repo-a"), b: wt("repo-b") };
}

describe("the folder name in the Explorer is the branch the repository is on", { timeout: 120_000 }, () => {
  it("a new set names its folders <repo> (<branch>), and a switch through aihub renames the folder", async () => {
    const w = await world();
    expect(names(w.ws)).toEqual(["repo-a (feature/5-x)", "repo-b (feature/5-x)"]);
    await run(w.a, ["branch", "switch", "--repo", "repo-a", "--branch", "feature/5-y", "--json"]);
    expect(names(w.ws)).toEqual(["repo-a (feature/5-y)", "repo-b (feature/5-x)"]);
  });

  it("git switch outside aihub: one write to the workspace file and one to the set file, then none", async () => {
    const w = await world();
    sh(w.a, ["switch", "-c", "feature/5-z"]);
    expect(syncRepoName({ setFolder: w.folder, workspaceFile: w.ws, repoPath: w.a })).toEqual({ workspace: true, setFile: true });
    expect(names(w.ws)).toEqual(["repo-a (feature/5-z)", "repo-b (feature/5-x)"]);
    const set = readSetFile(w.folder)!.top;
    expect(set.repos.map((r) => repoBranch(set, r))).toEqual(["feature/5-z", "feature/5-x"]);
    // the set file now says what HEAD says: the set-file watcher's plan has nothing to switch or repair, so no aihub call
    const before = [readFileSync(w.ws), readFileSync(join(w.folder, ".aihub-set.json"))];
    expect(syncRepoName({ setFolder: w.folder, workspaceFile: w.ws, repoPath: w.a })).toEqual({ workspace: false, setFile: false });
    expect([readFileSync(w.ws), readFileSync(join(w.folder, ".aihub-set.json"))].every((b, i) => b.equals(before[i]))).toBe(true);
  });

  it("two repositories at once", async () => {
    const w = await world();
    sh(w.a, ["switch", "-c", "feature/5-a2"]);
    sh(w.b, ["switch", "-c", "feature/5-b2"]);
    syncRepoName({ setFolder: w.folder, workspaceFile: w.ws, repoPath: w.a });
    syncRepoName({ setFolder: w.folder, workspaceFile: w.ws, repoPath: w.b });
    expect(names(w.ws)).toEqual(["repo-a (feature/5-a2)", "repo-b (feature/5-b2)"]);
    const set = readSetFile(w.folder)!.top;
    expect(set.repos.map((r) => repoBranch(set, r))).toEqual(["feature/5-a2", "feature/5-b2"]);
  });

  it("a detached HEAD shows the short hash and leaves the set file alone", async () => {
    const w = await world();
    sh(w.a, ["checkout", "--detach"]);
    const hash = sh(w.a, ["rev-parse", "--short=7", "HEAD"]);
    const setBefore = readFileSync(join(w.folder, ".aihub-set.json"));
    const r = syncRepoName({ setFolder: w.folder, workspaceFile: w.ws, repoPath: w.a });
    expect(r).toEqual({ workspace: true, setFile: false });
    expect(names(w.ws)[0]).toBe(`repo-a (${hash})`);
    expect(readFileSync(join(w.folder, ".aihub-set.json")).equals(setBefore)).toBe(true);
  });

  it("a hand-edited workspace file with comments is left alone", async () => {
    const w = await world();
    writeFileSync(w.ws, "// my notes\n" + readFileSync(w.ws, "utf8"));
    const before = readFileSync(w.ws);
    sh(w.a, ["switch", "-c", "feature/5-c"]);
    const r = syncRepoName({ setFolder: w.folder, workspaceFile: w.ws, repoPath: w.a });
    expect(r.workspace).toBe(false);
    expect(readFileSync(w.ws).equals(before)).toBe(true);
  });

  it("the extension's own format (.worktree-set.json) is followed the same way", async () => {
    const parent = newParent();
    const a = makeNamedRepo(parent, "repo-a").dir;
    sh(a, ["config", "user.name", "Test"]);
    sh(a, ["config", "user.email", "test@example.invalid"]);
    const folder = join(parent, "sets", "feature-x");
    mkdirSync(folder, { recursive: true });
    sh(a, ["worktree", "add", join(folder, "repo-a"), "-b", "feature/x"]);
    writeFileSync(join(folder, ".worktree-set.json"), JSON.stringify({ schemaVersion: 1, branch: "feature/x", slug: "feature-x", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", repos: [{ name: "repo-a", source: a, path: "repo-a" }] }, null, 2));
    const ws = join(folder, "feature-x.code-workspace");
    writeFileSync(ws, JSON.stringify({ folders: [{ name: "repo-a (feature/x)", path: "repo-a" }], settings: {} }));
    sh(join(folder, "repo-a"), ["switch", "-c", "feature/x2"]);
    expect(syncRepoName({ setFolder: folder, workspaceFile: ws, repoPath: join(folder, "repo-a") })).toEqual({ workspace: true, setFile: true });
    expect(names(ws)).toEqual(["repo-a (feature/x2)"]);
    const raw = JSON.parse(readFileSync(join(folder, ".worktree-set.json"), "utf8"));
    expect(raw.repos[0].branch).toBe("feature/x2");
    expect(raw.branch).toBe("feature/x");
  });
});
