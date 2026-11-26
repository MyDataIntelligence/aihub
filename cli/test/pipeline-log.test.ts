import { describe, expect, it } from "vitest";
import { findLinks, firstErrorOf, parseLines, readableLog, repoRelative, sectionsOf } from "../src/lib/pipelineLog.js";

const T = (s: number) => `2026-11-26T13:05:${String(s).padStart(2, "0")}.1234567Z `;

// a synthetic pytest step log, shaped like an Azure Pipelines log
const LOG = [
  `${T(0)}##[section]Starting: Run pytest`,
  `${T(0)}==============================================================================`,
  `${T(0)}Task         : Command line`,
  `${T(1)}##[group]Install`,
  `${T(1)}Collecting pandas`,
  `${T(1)}Successfully installed pandas-2.2.0`,
  `${T(2)}##[endgroup]`,
  `${T(2)}##[warning]pip 24.0 is available; version 25.1 is available.`,
  `${T(3)}collected 148 items`,
  `${T(3)}notebooks/test_orders.py ......F.F.                                [ 10%]`,
  `${T(3)}notebooks/test_more.py .........                                   [100%]`,
  `${T(4)}/home/vsts/work/1/s/notebooks/orders.py:14: FutureWarning: Downcasting object dtype arrays on .fillna is deprecated`,
  `${T(5)}FAILED notebooks/test_orders.py::test_empty_customer_number - AssertionError: customer_number must not be empty`,
  `${T(5)}FAILED notebooks/test_orders.py::test_zero_amount_rows - KeyError: 'amount'`,
  `${T(6)}    def test_empty_customer_number():`,
  `${T(6)}E   AssertionError: customer_number must not be empty`,
  `${T(6)}notebooks/test_orders.py:41: AssertionError`,
  `${T(7)}Traceback (most recent call last):`,
  `${T(7)}  File "/home/vsts/work/1/s/notebooks/orders.py", line 15, in total`,
  `${T(7)}  File "/usr/lib/python3.11/site-packages/pandas/core/frame.py", line 3761, in __getitem__`,
  `${T(7)}KeyError: 'amount'`,
  `${T(8)}see https://example.invalid/docs/page.html:80 for help`,
  `${T(9)}##[error]Bash exited with code '1'.`,
  "",
].join("\n");

describe("pipeline log: lines, levels and links", () => {
  it("numbers lines, splits off the time and gives each a level", () => {
    const lines = parseLines(LOG);
    expect(lines).toHaveLength(23);
    expect(lines[0]).toMatchObject({ n: 1, time: "2026-11-26T13:05:00.1234567Z", text: "##[section]Starting: Run pytest", level: "info" });
    const lvl = (n: number) => lines[n - 1].level;
    expect(lvl(8)).toBe("warning"); // ##[warning]
    expect(lvl(12)).toBe("warning"); // FutureWarning
    expect(lvl(13)).toBe("error"); // FAILED
    expect(lvl(15)).toBe("info"); // source line
    expect(lvl(16)).toBe("error"); // E   AssertionError
    expect(lvl(17)).toBe("error"); // path:41: AssertionError
    expect([18, 19, 20, 21].map(lvl)).toEqual(["error", "error", "error", "error"]); // the whole traceback
    expect(lvl(22)).toBe("info"); // after the traceback
    expect(lvl(23)).toBe("error");
  });

  it("numbers from a later line when only the new part was read", () => {
    expect(parseLines("a\nb\n", 40).map((l) => l.n)).toEqual([40, 41]);
  });

  it("links point into the repository, relative, with their place in the text", () => {
    const l = findLinks("/home/vsts/work/1/s/notebooks/orders.py:14: FutureWarning: x");
    expect(l).toEqual([{ file: "notebooks/orders.py", line: 14, start: 0, end: "/home/vsts/work/1/s/notebooks/orders.py:14".length }]);
    const py = findLinks('  File "/home/vsts/work/1/s/notebooks/orders.py", line 15, in total');
    expect(py).toMatchObject([{ file: "notebooks/orders.py", line: 15 }]);
    expect('  File "/home/vsts/work/1/s/notebooks/orders.py", line 15'.slice(py[0].start, py[0].end)).toBe("/home/vsts/work/1/s/notebooks/orders.py");
    expect(findLinks('  File "/usr/lib/python3.11/site-packages/pandas/core/frame.py", line 3761')).toEqual([]);
    expect(findLinks("see https://example.invalid/docs/page.html:80 for help")).toEqual([]);
    expect(findLinks("D:\\a\\1\\s\\src\\app.ts:7:3 - error TS2322")).toMatchObject([{ file: "src/app.ts", line: 7 }]);
    expect(findLinks("FAILED notebooks/test_orders.py::test_x - KeyError")).toEqual([]);
  });

  it("repoRelative strips agent checkout folders and refuses paths outside the repository", () => {
    expect(repoRelative("/__w/3/s/pkg/mod.py")).toBe("pkg/mod.py");
    expect(repoRelative("C:\\agent\\_work\\12\\s\\pkg\\mod.py")).toBe("pkg/mod.py");
    expect(repoRelative("$(Build.SourcesDirectory)/pkg/mod.py")).toBe("pkg/mod.py");
    expect(repoRelative("./pkg/mod.py")).toBe("pkg/mod.py");
    expect(repoRelative("/etc/hosts.txt")).toBeUndefined();
    expect(repoRelative(".venv/lib/x.py")).toBeUndefined();
  });
});

describe("pipeline log: first error and sections", () => {
  it("the first error is the first cause (not 'exited with code'), with the file:line of the test", () => {
    const fe = firstErrorOf(parseLines(LOG));
    expect(fe).toEqual({ n: 13, time: "2026-11-26T13:05:05.1234567Z", text: "AssertionError: customer_number must not be empty", file: "notebooks/test_orders.py", line: 41 });
  });

  it("only a generic error: that one is the first error", () => {
    expect(firstErrorOf(parseLines("ok\n##[error]Bash exited with code '1'.\n"))).toMatchObject({ n: 2, text: "Bash exited with code '1'." });
    expect(firstErrorOf(parseLines("all fine\n"))).toBeNull();
  });

  it("groups and quiet stretches become sections with a label", () => {
    const s = sectionsOf(parseLines(LOG));
    expect(s.find((x) => x.kind === "group")).toEqual({ kind: "group", label: "Install", start: 4, end: 7, problems: false });
    expect(s.find((x) => x.kind === "noise" && x.start === 1)).toMatchObject({ end: 7, label: "run pytest, install requirements" });
    expect(s.find((x) => x.kind === "noise" && x.start === 9)).toMatchObject({ end: 11, label: "running 148 tests, test progress" });
  });

  it("readableLog counts over the whole log and cuts lines to --tail", () => {
    const r = readableLog(LOG, { tail: 5 });
    expect(r.totalLines).toBe(23);
    expect(r.lines.map((l) => l.n)).toEqual([19, 20, 21, 22, 23]);
    expect(r.truncated).toBe(true);
    expect(r.counts).toEqual({ errors: 9, warnings: 2 });
    expect(r.firstError?.n).toBe(13);
    expect(r.sections.every((x) => x.end >= 19 && x.start >= 19)).toBe(true);
    expect(readableLog(LOG).truncated).toBe(false);
  });
});
