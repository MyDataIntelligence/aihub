import { describe, expect, it } from "vitest";
import { plainError } from "../src/bar/plainError";

describe("failures in plain words (persona 5)", () => {
  it("a missing source clone, local changes, sign-in, network: one sentence, no flag, no fatal:", () => {
    expect(plainError("fatal: not a git repository: C:/x/.git/worktrees/repo-c").text).toContain("source clone is not where it was");
    expect(plainError("orders-api: skipped - uncommitted changes in C:/x; Commit or stash them first, or add --mode worktree for a second worktree").text).toContain("not committed");
    expect(plainError("remote: TF401019: authentication failed").text).toContain("not signed in");
    expect(plainError("fatal: unable to access 'https://x/': Could not resolve host: x").text).toContain("no connection");
  });

  it("an unknown failure: the first line without aihub:/fatal: and without flags; the original text stays for Show Details", () => {
    const e = plainError("aihub: the branch frobnicates with --mode worktree today\nsecond line");
    expect(e.text).toBe("the branch frobnicates with today");
    expect(e.details).toContain("second line");
    expect(plainError("").text).toBe("something went wrong");
  });
});
