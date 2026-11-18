import { describe, expect, it } from "vitest";
import { fixPrompt, isOpen, parseThreads, replyArg, replyArgs, repoPath } from "../src/threadsModel";

const json = { pr: 137, threads: [{ threadId: 7, status: "active", file: "/orders/discount.py", line: 12, comments: [{ id: 1, author: "Ann", text: "Use a\nconstant here" }] }, { threadId: 8, status: "fixed", comments: [] }, { nope: 1 }] };

describe("review threads", () => {
  it("parses aihub comments get --json and skips malformed rows", () => {
    const { pr, threads } = parseThreads(json);
    expect(pr).toBe(137);
    expect(threads.map((t) => t.threadId)).toEqual([7, 8]);
    expect(isOpen(threads[0])).toBe(true);
    expect(isOpen(threads[1])).toBe(false);
    expect(parseThreads(undefined).threads).toEqual([]);
  });

  it("builds the --reply argument the CLI parses", () => {
    expect(replyArg(7, "fixed", "Aangepast: constant")).toBe("7:fixed:Aangepast: constant");
    expect(replyArg(7, "active", "")).toBe("7:active:");
    expect(replyArg(7, "", "just a reply\nover lines")).toBe("7::just a reply over lines");
    expect(() => replyArg(7, "", "  ")).toThrow();
    expect(replyArgs(137, 7, "wontFix", "no")).toEqual(["comments", "reply", "--pr", "137", "--reply", "7:wontFix:no"]);
  });

  it("makes repo-relative paths and a chat prompt with the thread", () => {
    expect(repoPath("/orders/discount.py")).toBe("orders/discount.py");
    const p = fixPrompt(137, parseThreads(json).threads[0]);
    expect(p).toContain("review-process");
    expect(p).toContain("orders/discount.py:12");
    expect(p).toContain("Ann: Use a constant here");
    expect(p).toContain('--reply "7:fixed:');
  });
});
