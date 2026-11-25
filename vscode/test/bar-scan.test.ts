import { describe, expect, it } from "vitest";
import { buildState } from "../src/bar/state";

const base = { open: {}, recents: [], lookIn: ["C:\\git"], stories: {}, exists: () => true };

describe("BarState says when the scan was not complete", () => {
  it("scanTruncated and scanSkipped only when they are true", () => {
    const plain = buildState({ ...base, scan: { at: 1, folders: [], repos: [], sets: [] } });
    expect(plain.scanTruncated).toBeUndefined();
    expect(plain.scanSkipped).toBeUndefined();
    const cut = buildState({ ...base, scan: { at: 1, folders: [], repos: [], sets: [], truncated: true, skippedRemote: ["C:\\Users\\x\\OneDrive"] } });
    expect(cut.scanTruncated).toBe(true);
    expect(cut.scanSkipped).toEqual(["C:\\Users\\x\\OneDrive"]);
    expect(cut.mode).toBe("empty");
    expect(cut.sets).toEqual([]);
  });
});
