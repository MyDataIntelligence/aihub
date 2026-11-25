import { describe, expect, it } from "vitest";
import { checkMeta, parseSetFile, planSetFile, summarizePlan } from "../src/bar/setFilePlan";

const meta = (branch: string, repos: { name: string; branch?: string }[]) => ({ branch, repos: repos.map((r) => ({ name: r.name, source: `/c/${r.name}`, path: `/w/${r.name}`, ...(r.branch ? { branch: r.branch } : {}) })) });

describe("the set file changed by hand", () => {
  it("a file that is not JSON gives one reason and nothing to apply", () => {
    const p = parseSetFile('{ "story": 7, ');
    expect(p.json).toBeUndefined();
    expect(p.problem).toMatch(/^the set file is not valid JSON \(/);
    expect(parseSetFile("﻿" + JSON.stringify({ a: 1 })).json).toEqual({ a: 1 });
  });

  it("names what is wrong: no branch, no repositories, a nameless or doubled repository", () => {
    expect(checkMeta(undefined)).toMatch(/no set/);
    expect(checkMeta({ branch: "", repos: [] })).toMatch(/no branch/);
    expect(checkMeta({ branch: "b", repos: [] })).toMatch(/no repositories/);
    expect(checkMeta({ branch: "b", repos: [{ name: " ", source: "s", path: "p" }] })).toMatch(/no name/);
    expect(checkMeta(meta("b", [{ name: "repo-a" }, { name: "repo-a" }]))).toBe("repo-a is in the set file twice");
    expect(checkMeta(meta("b", [{ name: "repo-a" }]))).toBeUndefined();
  });

  it("a set file that agrees with the folders asks for nothing", () => {
    const plan = planSetFile(meta("feature/7-x", [{ name: "repo-a" }, { name: "repo-b", branch: "feature/7-y" }]), [{ name: "repo-a", exists: true, branch: "feature/7-x" }, { name: "repo-b", exists: true, branch: "feature/7-y" }]);
    expect(plan).toEqual({ actions: [], notes: [] });
    expect(summarizePlan([], [])).toBe("Set file: matches the folders");
  });

  it("a branch changed by hand is switched (the repository's own branch, else the set's)", () => {
    const plan = planSetFile(meta("feature/7-x", [{ name: "repo-a", branch: "feature/7-z" }, { name: "repo-b" }]), [{ name: "repo-a", exists: true, branch: "feature/7-x" }, { name: "repo-b", exists: true, branch: "feature/7-old" }], new Map([["repo-a", "feature/7-x"], ["repo-b", "feature/7-old"]]));
    expect(plan.actions).toEqual([{ kind: "switch", repo: "repo-a", branch: "feature/7-z" }, { kind: "switch", repo: "repo-b", branch: "feature/7-x" }]);
  });

  it("only a change in the file is an order: a difference in an entry that did not change means HEAD moved, and HEAD wins", () => {
    const m = meta("feature/7-x", [{ name: "repo-a", branch: "feature/7-z" }, { name: "repo-b" }]);
    const actual = [{ name: "repo-a", exists: true, branch: "feature/7-x" }, { name: "repo-b", exists: true, branch: "feature/7-moved" }];
    // repo-a changed in the file (x -> z): switched; repo-b did not change (still x): follows its HEAD
    const plan = planSetFile(m, actual, new Map([["repo-a", "feature/7-x"], ["repo-b", "feature/7-x"]]));
    expect(plan.actions).toEqual([{ kind: "switch", repo: "repo-a", branch: "feature/7-z" }]);
    expect(plan.follow).toEqual(["repo-b"]);
    // nothing known about the last read: nothing is switched
    expect(planSetFile(m, actual).actions).toEqual([]);
  });

  it("a repository added by hand (no worktree yet) is repaired first; an unreadable HEAD is not switched", () => {
    const plan = planSetFile(meta("feature/7-x", [{ name: "repo-a" }, { name: "repo-c" }]), [{ name: "repo-a", exists: true, branch: "" }, { name: "repo-c", exists: false, branch: "" }]);
    expect(plan.actions).toEqual([{ kind: "repair", repos: ["repo-c"] }]);
  });

  it("a repository taken out of the file is only mentioned: its worktree stays", () => {
    const plan = planSetFile(meta("feature/7-x", [{ name: "repo-a" }]), [{ name: "repo-a", exists: true, branch: "feature/7-x" }, { name: "repo-b", exists: true, branch: "feature/7-x" }]);
    expect(plan.actions).toEqual([]);
    expect(plan.notes).toEqual(["repo-b is no longer in the set file; the worktree stays (Remove from Set takes it away)"]);
    expect(summarizePlan(["repo-a switched to x"], plan.notes)).toBe("Set file: repo-a switched to x. repo-b is no longer in the set file; the worktree stays (Remove from Set takes it away)");
  });

  it("a broken set gives the problem and no actions at all", () => {
    expect(planSetFile({ branch: "b", repos: [] }, [])).toEqual({ problem: "the set file lists no repositories", actions: [], notes: [] });
  });
});
