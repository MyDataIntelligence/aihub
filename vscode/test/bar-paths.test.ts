import { describe, expect, it } from "vitest";
import { plainPath, plainPathsIn } from "../src/bar/paths";

describe("paths in the messages of the bar", () => {
  it("one kind of slash for the platform, shortened in the middle above 60 characters, start and end visible", () => {
    const bs = String.fromCharCode(92);
    expect(plainPath("C:/Work/repo-a", 60, true)).toBe(`C:${bs}Work${bs}repo-a`);
    expect(plainPath(`C:${bs}Work/repo-a`, 60, false)).toBe("C:/Work/repo-a");
    const long = "C:/Users/someone/OneDrive/Documents/work/sets/3742-orderexport/repo-a-long/worktrees/feature-3742";
    const short = plainPath(long, 60, true);
    expect(short.length).toBeLessThanOrEqual(60);
    expect(short.startsWith(`C:${bs}Users`)).toBe(true);
    expect(short.endsWith(`${bs}feature-3742`)).toBe(true);
    expect(short).toContain("…");
    expect(short.includes("/")).toBe(false);
  });

  it("paths inside a sentence, nothing else changes", () => {
    const long = "C:/Users/someone/OneDrive/Documents/work/sets/3742-orderexport/repo-a-long/worktrees/feature-3742";
    const out = plainPathsIn(`worktree made in ${long}, and a branch of 4/5`, 60, true);
    expect(out.startsWith("worktree made in C:")).toBe(true);
    expect(out.endsWith("feature-3742, and a branch of 4/5")).toBe(true);
    expect(out).toContain("…");
  });
});
