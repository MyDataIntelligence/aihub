import { describe, expect, it } from "vitest";
import { resultMessage, robotTestLines } from "../src/robotModel";

describe("Run this test (CodeLens)", () => {
  it("finds the test cases of a .robot file, not keywords, settings or comments", () => {
    const text = "*** Settings ***\nLibrary    X\n\n*** Test Cases ***\nLoad the orders\n    Log    one\n# comment\nReconcile the totals    [Tags]  a\n    Log    two\n\n*** Keywords ***\nHelper\n    Log    k\n";
    expect(robotTestLines(text)).toEqual([
      { name: "Load the orders", line: 4 },
      { name: "Reconcile the totals", line: 7 },
    ]);
  });
});

describe("the result message", () => {
  it("says PASS or FAIL with counts and the first failing tests", () => {
    expect(resultMessage({ status: "PASS", pass: 3, fail: 0, skip: 0, failed: [] }, 0)).toBe("Robot PASS: 3 passed.");
    expect(resultMessage({ status: "FAIL", pass: 1, fail: 2, skip: 1, failed: [{ name: "A", message: "x" }, { name: "B", message: "y" }] }, 1)).toBe("Robot FAIL: 1 passed, 2 failed, 1 skipped. Failed: A (x); B (y)");
    expect(resultMessage(null, 3)).toBe("Robot run ended with exit code 3 and wrote no output.xml.");
  });
});
