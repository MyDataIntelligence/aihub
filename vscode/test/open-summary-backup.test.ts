import { describe, expect, it } from "vitest";
import { summarizeOpen } from "../src/repoSetModel";

describe("Recreate: the ignored files (.env) are in the back-up and the message says where (persona 10)", () => {
  it("the line of a recreated repository carries the note with the back-up folder", () => {
    const note = "recreated from feature/x (old worktree /w/repo-a-x removed; 1 ignored local file saved in /src/repo-a/.git/aihub/backup/repo-a-x-20261126-0900 (.env))";
    const s = summarizeOpen({ branch: "feature/x", mode: "worktree", folder: "/set", opened: false, repos: [{ repo: "repo-a", ok: true, state: "recreated", branch: "feature/x", path: "/set/repo-a", note }] } as never);
    expect(s.lines[0]).toContain("saved in");
    expect(s.lines[0].split("\\").join("/")).toContain("/src/repo-a/.git/aihub/backup/repo-a-x-20261126-0900");
    expect(s.lines[0]).toContain(".env");
  });
});
