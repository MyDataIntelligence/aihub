import { describe, expect, it } from "vitest";
import { createPullRequests, prOffers } from "../src/bar/createPrs";
import type { BarRepo } from "../src/bar/types";

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
    const { results, linked } = await createPullRequests(cli, [{ name: "repo-a", path: "/w/repo-a" }, { name: "repo-b", path: "/w/repo-b" }, { name: "repo-c", path: "/w/repo-c" }], 5);
    expect(results.map((r) => [r.repo, r.ok, r.line, r.id])).toEqual([
      ["repo-a", true, "repo-a: PR !901 created", 901],
      ["repo-b", false, "repo-b: the branch has no commits of its own", undefined],
      ["repo-c", true, "repo-c: PR !902 created", 902],
    ]);
    expect(calls[0]).toEqual({ args: ["pr", "create", "--work-item", "5", "--json"], cwd: "/w/repo-a" });
    expect(calls.filter((c) => c.args[0] === "crossrepo")).toEqual([{ args: ["crossrepo", "link-prs", "--story", "5", "--json"], cwd: "/w/repo-a" }]);
    expect(linked).toContain("list each other");
  });

  it("nothing created: no link step", async () => {
    const calls: string[][] = [];
    const { results, linked } = await createPullRequests(async (a) => (calls.push(a), Promise.reject(new Error("no"))), [{ name: "repo-a", path: "/w/a" }], 5);
    expect(results[0].ok).toBe(false);
    expect(linked).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});
