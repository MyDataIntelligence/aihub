import { describe, expect, it } from "vitest";
import { addRecentRepos, plainWorkspace, repoRows, selectionOf, type AdoRepoJson, type LocalRepoJson } from "../src/repoPickerModel";

const local: LocalRepoJson[] = [
  { name: "repo-a", path: "C:\\r\\repo-a", branch: "main", key: "o/test-project/repo-a" },
  { name: "repo-b", path: "C:\\r\\repo-b", branch: "feature/9-x", key: "o/test-project/repo-b" },
  { name: "scratch", path: "C:\\r\\scratch", branch: "" },
];
const ado: AdoRepoJson[] = [
  { project: "other-project", name: "repo-c", key: "o/other-project/repo-c" },
  { project: "test-project", name: "repo-a", key: "o/test-project/repo-a", path: "C:\\r\\repo-a", branch: "main" },
  { project: "test-project", name: "repo-b", key: "o/test-project/repo-b", path: "C:\\r\\repo-b", branch: "feature/9-x" },
];
const groups = [{ name: "pipeline", source: "team" as const, repos: [{ name: "repo-a", path: "C:\\r\\repo-a" }, { name: "repo-b", path: "C:\\r\\repo-b" }], missing: [] }];

describe("the repo opener's list", () => {
  it("before Azure DevOps answers: groups, recent, then the local clones", () => {
    const rows = repoRows({ groups, recent: [{ path: "c:/r/repo-b", name: "repo-b", lastUsed: "x" }], local });
    expect(rows.map((r) => (r.separator ? `--${r.label}` : `${r.label} | ${r.description}`))).toEqual([
      "--Groups",
      "★ pipeline | 2 repos · team.yaml",
      "--Recent",
      "repo-b | feature/9-x · C:\\r\\repo-b",
      "--Local",
      "repo-a | main · C:\\r\\repo-a",
      "scratch | (detached) · C:\\r\\scratch",
    ]);
  });

  it("with Azure DevOps: per project, a clone shows its branch, else 'not cloned ↓'; rows keep their id", () => {
    const rows = repoRows({ groups: [], recent: [], local, ado });
    expect(rows.map((r) => (r.separator ? `--${r.label}` : `${r.label} | ${r.description}`))).toEqual([
      "--Azure DevOps · other-project",
      "repo-c | not cloned ↓",
      "--Azure DevOps · test-project",
      "repo-a | main · C:\\r\\repo-a",
      "repo-b | feature/9-x · C:\\r\\repo-b",
      "--Local, not in Azure DevOps",
      "scratch | (detached) · C:\\r\\scratch",
    ]);
    expect(rows.find((r) => r.label === "repo-a")!.id).toBe(repoRows({ groups: [], recent: [], local }).find((r) => r.label === "repo-a")!.id);
    expect(repoRows({ groups: [], recent: [], local, adoError: "not signed in" }).at(-1)?.label).toBe("Azure DevOps could not be read: not signed in");
  });

  it("the selection: a group stands for its repositories, no doubles, clones listed apart; one group alone opens by name", () => {
    const s = selectionOf([{ kind: "group", group: groups[0] }, { kind: "local", path: "c:/r/repo-a", name: "repo-a" }, { kind: "clone", project: "other-project", name: "repo-c" }]);
    expect(s).toEqual({ paths: ["C:\\r\\repo-a", "C:\\r\\repo-b"], clone: ["other-project/repo-c"], names: ["repo-a", "repo-b", "repo-c"], group: undefined });
    expect(selectionOf([{ kind: "group", group: groups[0] }]).group).toBe("pipeline");
  });

  it("recent repositories: newest first, no doubles, at most 10", () => {
    let r = addRecentRepos([], [{ path: "C:\\r\\a", name: "a" }], 1000);
    r = addRecentRepos(r, [{ path: "c:/r/a", name: "a" }, { path: "C:\\r\\b", name: "b" }], 2000);
    expect(r.map((x) => x.name)).toEqual(["a", "b"]);
    for (let i = 0; i < 12; i++) r = addRecentRepos(r, [{ path: `C:\\r\\x${i}`, name: `x${i}` }], 3000 + i);
    expect(r).toHaveLength(10);
  });

  it("'open as they are' is a workspace of the folders, no worktree", () => {
    const w = JSON.parse(plainWorkspace(["C:\\r\\repo-a", "C:\\r\\repo-b"], "repo-a, repo-b"));
    expect(w.folders).toEqual([{ path: "C:/r/repo-a" }, { path: "C:/r/repo-b" }]);
    expect(w.settings["aihub.set"]).toMatchObject({ mode: "plain", repos: [{ name: "repo-a" }, { name: "repo-b" }] });
  });
});
