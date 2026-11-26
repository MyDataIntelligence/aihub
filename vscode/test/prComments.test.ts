import { describe, expect, it } from "vitest";
import {
  commentMarkdown,
  fileCounts,
  firstSentence,
  isUnread,
  markSeen,
  newSince,
  notice,
  openComments,
  outdatedMarkdown,
  parseThreadsRead,
  placeThread,
  prCounts,
  suggestionRange,
  threadsArgs,
  type PrThread,
  type Seen,
  type ThreadsRead,
} from "../src/comments/model";

// orders.py in the latest iteration of pull request 812
const FILE = [
  "import pandas as pd",
  "",
  "def export_orders(day):",
  "    rows = read_orders(day)",
  '    rows["customer_number"] = rows["customer_number"].str.strip()',
  '    rows = rows[rows["amount"].astype(float) > 0]',
  "    return rows",
];
const ME = { id: "u-me", name: "Test User" };

function thread(over: Partial<PrThread> = {}): PrThread {
  return {
    threadId: 11,
    status: "active",
    open: true,
    file: "/notebooks/orders.py",
    side: "right",
    line: 5,
    endLine: 5,
    outdated: false,
    original: [FILE[4]],
    anchor: { start: 3, lines: FILE.slice(2, 7) },
    comments: [{ id: 1, author: "Sanne de Vries", authorId: "u-sanne", when: "2026-11-26T08:00:00Z", text: "This fails for orders without a customer number. Guard it?" }],
    suggestions: [],
    ...over,
  };
}
const read = (threads: PrThread[], repo = "repo-a", pr = 812): ThreadsRead => ({ me: ME, prs: [{ repo, pr, threads }], failed: [] });
const none: Seen = { threads: {}, prs: {} };

describe("where a thread goes in the file as it is now", () => {
  it("unchanged file: the line of Azure DevOps", () => {
    expect(placeThread(thread(), FILE)).toEqual({ line: 4, outdated: false, top: false });
  });

  it("follows local lines added above the comment", () => {
    const doc = ["# header", "# more", ...FILE];
    expect(placeThread(thread(), doc)).toEqual({ line: 6, outdated: false, top: false });
  });

  it("stays when lines are added below the comment", () => {
    const doc = [...FILE.slice(0, 6), "    rows = rows.dropna()", ...FILE.slice(6)];
    expect(placeThread(thread(), doc)).toEqual({ line: 4, outdated: false, top: false });
  });

  it("the commented line itself changed here: outdated, at its place (after the lines before it)", () => {
    const doc = [...FILE];
    doc[4] = '    rows["customer_number"] = rows["customer_number"].fillna("").str.strip()';
    expect(placeThread(thread(), doc)).toEqual({ line: 4, outdated: true, top: false });
  });

  it("nothing of it is there any more: outdated at the top", () => {
    expect(placeThread(thread(), ["x = 1", "y = 2"])).toEqual({ line: 0, outdated: true, top: true });
  });

  it("two equal lines: the one with the same lines around it", () => {
    const dup = ["a", "same", "b", "", "c", "same", "d"];
    const t = thread({ line: 6, endLine: 6, anchor: { start: 4, lines: ["", "c", "same", "d"] } });
    expect(placeThread(t, ["new", ...dup])?.line).toBe(6);
  });

  it("outdated in Azure DevOps (a later iteration rewrote it) stays outdated, at the tracked line", () => {
    expect(placeThread(thread({ outdated: true, original: ['    rows = rows[rows["amount"] > 0]'] }), FILE)).toEqual({ line: 4, outdated: true, top: false });
  });

  it("a comment on a removed line, or a file that is gone in the pull request: at the top", () => {
    expect(placeThread(thread({ side: "left", anchor: undefined }), FILE)?.top).toBe(true);
    expect(placeThread(thread({ fileDeleted: true }), FILE)?.top).toBe(true);
  });

  it("a general comment is not placed in a file", () => {
    expect(placeThread(thread({ file: undefined }), FILE)).toBeUndefined();
  });
});

describe("suggestions", () => {
  const sug = { commentId: 1, old: [FILE[4]], new: ['    rows["customer_number"] = rows["customer_number"].fillna("").str.strip()'] };
  it("replaces the commented lines", () => {
    expect(suggestionRange(FILE, 4, sug)).toEqual({ start: 4, end: 5 });
  });
  it("finds them a line or two away", () => {
    expect(suggestionRange(["# x", ...FILE], 4, sug)).toEqual({ start: 5, end: 6 });
  });
  it("says so when the lines changed", () => {
    expect(suggestionRange(["other"], 0, sug)).toEqual({ error: expect.stringContaining("changed") });
  });
  it("shows a suggestion as a diff of the old and new lines", () => {
    const md = commentMarkdown("Guard it?\n```suggestion\nnew line\n```", ["old line"]);
    expect(md).toContain("**Suggested change**");
    expect(md).toContain("```diff\n- old line\n+ new line\n```");
  });
  it("an outdated thread shows what was commented and what is there now", () => {
    expect(outdatedMarkdown(["- was"], ["+ is"])).toContain("Outdated · the code changed since this comment.");
    expect(outdatedMarkdown(["y = 2"], undefined, "left")).toContain("removes");
  });
});

describe("new and unread", () => {
  it("the first read of a pull request is taken as seen: no flood", () => {
    const r = newSince(none, read([thread()]), new Set());
    expect(r.fresh).toEqual([]);
    expect(isUnread(r.seen, "repo-a", 812, thread(), ME.id)).toBe(false);
  });

  it("a new comment of someone else after that: one notice with where and the first sentence, unread", () => {
    const first = newSince(none, read([thread()]), new Set()).seen;
    const t = thread({ comments: [...thread().comments, { id: 2, author: "Tom Bakker", authorId: "u-tom", text: "Agreed. Also log it." }] });
    const r = newSince(first, read([t]), new Set());
    expect(r.fresh).toEqual([{ repo: "repo-a", pr: 812, threadId: 11, file: "notebooks/orders.py", line: 5, author: "Tom Bakker", firstLine: "Agreed." }]);
    expect(notice(r.fresh)).toEqual({ message: "New comment on pull request 812 · notebooks/orders.py:5", detail: "Tom Bakker: “Agreed.”" });
    expect(isUnread(r.seen, "repo-a", 812, t, ME.id)).toBe(true);
    expect(prCounts(read([t]), r.seen, "repo-a", 812)).toEqual({ open: 1, unread: 1 });
  });

  it("never for my own comment", () => {
    const first = newSince(none, read([thread()]), new Set()).seen;
    const t = thread({ comments: [...thread().comments, { id: 2, author: "Test User", authorId: "u-me", text: "Done." }] });
    const r = newSince(first, read([t]), new Set());
    expect(r.fresh).toEqual([]);
    expect(isUnread(r.seen, "repo-a", 812, t, ME.id)).toBe(false);
  });

  it("several new at once: one notice; the same comment is not told twice", () => {
    const first = newSince(none, read([thread(), thread({ threadId: 12 })]), new Set()).seen;
    const plus = (t: PrThread) => ({ ...t, comments: [...t.comments, { id: 5, author: "Tom Bakker", authorId: "u-tom", text: "More." }] });
    const told = new Set<string>();
    const next = read([plus(thread()), plus(thread({ threadId: 12 })), thread({ threadId: 13 })]);
    const r = newSince(first, next, told);
    expect(notice(r.fresh)).toEqual({ message: "3 new comments on pull request 812" });
    expect(newSince(r.seen, next, told).fresh).toEqual([]);
  });

  it("read when the thread was shown: no longer unread", () => {
    const first = newSince(none, read([thread()]), new Set()).seen;
    const t = thread({ comments: [...thread().comments, { id: 2, author: "Tom Bakker", authorId: "u-tom", text: "x" }] });
    expect(isUnread(markSeen(first, "repo-a", 812, t), "repo-a", 812, t, ME.id)).toBe(false);
  });

  it("two repositories each with a pull request: per repository", () => {
    const both: ThreadsRead = { me: ME, prs: [{ repo: "repo-a", pr: 812, threads: [thread()] }, { repo: "repo-c", pr: 813, threads: [thread({ threadId: 31, file: "/config/settings.yaml" })] }], failed: [] };
    const seen = newSince(none, both, new Set()).seen;
    expect(prCounts(both, seen, "repo-a", 812)).toEqual({ open: 1, unread: 0 });
    expect(prCounts(both, seen, "REPO-C", 813)).toEqual({ open: 1, unread: 0 });
    expect(prCounts(both, seen, "repo-b", 1)).toBeUndefined();
  });
});

describe("the Explorer and the title bar", () => {
  const targets = [{ repo: "repo-a", path: "C:\\sets\\4711\\repo-a", pr: 812 }];
  const key = (p: string) => p.replace(/\\/g, "/").toLowerCase();

  it("counts open threads per file and up to the repository folder; resolved and general ones count for no file", () => {
    const r = read([thread(), thread({ threadId: 12, line: 6 }), thread({ threadId: 13, file: "/notebooks/export.py" }), thread({ threadId: 14, open: false, status: "fixed" }), thread({ threadId: 15, file: undefined })]);
    const c = fileCounts(targets, r, newSince(none, r, new Set()).seen, key);
    expect(c.get("c:/sets/4711/repo-a/notebooks/orders.py")).toMatchObject({ open: 2, unread: 0, pr: 812 });
    expect(c.get("c:/sets/4711/repo-a/notebooks")?.open).toBe(3);
    expect(c.get("c:/sets/4711/repo-a")?.open).toBe(3);
    expect(c.get("c:/sets/4711")).toBeUndefined();
  });

  it("the overview list: open threads, newest first, with the first sentence and unread", () => {
    const r = read([
      thread({ threadId: 11 }),
      thread({ threadId: 12, comments: [{ id: 1, author: "Tom Bakker", authorId: "u-tom", when: "2026-11-26T09:00:00Z", text: "Should we log the duplicates we drop here? Maybe." }] }),
      thread({ threadId: 13, open: false, status: "fixed" }),
    ]);
    const list = openComments(r, none);
    expect(list.map((c) => [c.threadId, c.firstLine, c.unread])).toEqual([
      [12, "Should we log the duplicates we drop here?", true],
      [11, "This fails for orders without a customer number.", true],
    ]);
    expect(list[0]).toMatchObject({ repo: "repo-a", pr: 812, file: "notebooks/orders.py", line: 5, author: "Tom Bakker" });
  });

  it("first sentence without markdown and code", () => {
    expect(firstSentence("**Read** the `path` from [settings](x). Then more.")).toBe("Read the path from settings.");
    expect(firstSentence("```suggestion\nx\n```\nUse this")).toBe("Use this");
  });

  it("one read for all pull requests of the set", () => {
    expect(threadsArgs([{ repo: "repo-a", path: "a", pr: 812 }, { repo: "repo-c", path: "c", pr: 813 }])).toEqual(["comments", "threads", "--pr", "repo-a:812", "--pr", "repo-c:813", "--json"]);
    expect(threadsArgs([{ repo: "", path: "a", pr: 9 }])).toEqual(["comments", "threads", "--pr", "9", "--json"]);
  });

  it("parses the CLI answer after a warning line", () => {
    expect(parseThreadsRead('warning: x\n{"prs":[{"repo":"r","pr":1,"threads":[]}],"failed":[]}').prs[0].pr).toBe(1);
  });
});
