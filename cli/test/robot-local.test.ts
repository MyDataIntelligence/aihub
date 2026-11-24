import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { findRunner, localCommand, parseRobotTests, readResult } from "../src/lib/robotLocal.js";
import { ctxFor, fakeFetch, makeRepo, write } from "./helpers.js";

const SUITE = `*** Settings ***
Library    Collections

*** Test Cases ***
Load the orders
    [Tags]    smoke
    Log    one

# a comment
Reconcile the totals
    Log    two

*** Keywords ***
Helper
    Log    no test
`;

const OUTPUT = (fail: number) => `<?xml version="1.0" encoding="UTF-8"?>
<robot generator="Robot 7.0">
<suite name="Lakehouse"><test id="s1-t1" name="Load the orders"><status status="PASS"/></test>
<test id="s1-t2" name="Reconcile the totals"><status status="${fail ? "FAIL" : "PASS"}">${fail ? "totals differ: 3 != 4" : ""}</status></test></suite>
<statistics><total><stat pass="${2 - fail}" fail="${fail}" skip="0">All Tests</stat></total></statistics>
</robot>`;

describe("Robot test discovery", () => {
  it("reads the test cases of a .robot file with their lines, not the keywords", () => {
    expect(parseRobotTests(SUITE)).toEqual([
      { name: "Load the orders", line: 5 },
      { name: "Reconcile the totals", line: 10 },
    ]);
  });

  it("finds the runner from team.yaml, else an rf-run.py in the repository", () => {
    const { dir } = makeRepo();
    write(dir, "tests/robot/rf-run.py", "print('x')\n");
    write(dir, "tests/robot/test_cases/01_lakehouse.robot", SUITE);
    expect(findRunner(dir, {})).toMatchObject({ script: join(dir, "tests", "robot", "rf-run.py"), cwd: join(dir, "tests", "robot") });
    write(dir, "tools/run_robot.py", "print('y')\n");
    expect(findRunner(dir, { robot: { runner: "tools/run_robot.py" } } as never)?.script).toBe(join(dir, "tools", "run_robot.py"));
  });
});

describe("the local Robot command", () => {
  it("runs the team script from its folder with the repository's venv, one test and the chosen test environment", () => {
    const { dir } = makeRepo();
    write(dir, "tests/robot/rf-run.py", "print('x')\n");
    write(dir, "tests/robot/test_cases/01_lakehouse.robot", SUITE);
    mkdirSync(join(dir, ".venv", "Scripts"), { recursive: true });
    writeFileSync(join(dir, ".venv", "Scripts", "python.exe"), "");
    const team = { robot: { environments: { tst: { INTEGRATION_DEPENDENCY_ENVIRONMENT: "tst" }, acc: { INTEGRATION_DEPENDENCY_ENVIRONMENT: "acc" } } } } as never;
    const c = localCommand(dir, team, { file: join(dir, "tests", "robot", "test_cases", "01_lakehouse.robot"), test: "Reconcile the totals", env: "tst" }, "win32");
    expect(c.cwd).toBe(join(dir, "tests", "robot"));
    expect(c.exe).toBe(join(dir, ".venv", "Scripts", "python.exe"));
    expect(c.args).toEqual(["rf-run.py", "--test", "Reconcile the totals", join("test_cases", "01_lakehouse.robot")]);
    expect(c.env).toEqual({ INTEGRATION_DEPENDENCY_ENVIRONMENT: "tst" });
    expect(() => localCommand(dir, team, { env: "prd" }, "win32")).toThrow(/not a test environment.*tst, acc/);
  });

  it("without a team script runs python -m robot with its own output folder", () => {
    const { dir } = makeRepo();
    write(dir, "robot/suite.robot", SUITE);
    const c = localCommand(dir, {} as never, { file: join(dir, "robot", "suite.robot") }, "linux");
    expect(c.exe).toBe("python3");
    expect(c.args.slice(0, 4)).toEqual(["-m", "robot", "--outputdir", c.outputDir!]);
    expect(c.args.at(-1)).toBe(join("robot", "suite.robot"));
    expect(c.cwd).toBe(dir);
  });
});

describe("the Robot result", () => {
  it("reads the newest output.xml written after the start: counts, failing tests, log and report", () => {
    const { dir } = makeRepo();
    const old = join(dir, "test_results", "2026", "11", "20", "09-00-00", "report");
    const fresh = join(dir, "test_results", "2026", "11", "24", "10-00-00", "report");
    for (const [d, fail] of [
      [old, 0],
      [fresh, 1],
    ] as const) {
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "output.xml"), OUTPUT(fail));
      writeFileSync(join(d, "log.html"), "<html/>");
      writeFileSync(join(d, "report.html"), "<html/>");
    }
    const t = Date.now();
    utimesSync(join(old, "output.xml"), new Date(t - 3_600_000), new Date(t - 3_600_000));
    const r = readResult(dir, t - 60_000)!;
    expect(r).toMatchObject({ pass: 1, fail: 1, skip: 0, status: "FAIL", failed: [{ name: "Reconcile the totals", message: "totals differ: 3 != 4" }] });
    expect(r.log).toBe(join(fresh, "log.html"));
    expect(r.report).toBe(join(fresh, "report.html"));
    expect(readResult(dir, t + 60_000)).toBeUndefined(); // nothing newer than the start: no old result
  });

  it("aihub robot local --json lists runner, suites, tests and environments", async () => {
    const { dir } = makeRepo();
    write(dir, "tests/robot/rf-run.py", "print('x')\n");
    write(dir, "tests/robot/test_cases/01_lakehouse.robot", SUITE);
    write(dir, ".agents/skills/_shared/references/team.yaml", "version: 1\nrobot:\n  environments:\n    tst:\n      INTEGRATION_DEPENDENCY_ENVIRONMENT: tst\n");
    const { ctx, lines } = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(["robot", "local", "--json"], ctx)).toBe(0);
    const j = JSON.parse(lines.join(""));
    expect(j.runner).toMatchObject({ script: join(dir, "tests", "robot", "rf-run.py") });
    expect(j.suites).toEqual([{ file: join(dir, "tests", "robot", "test_cases", "01_lakehouse.robot"), rel: "tests/robot/test_cases/01_lakehouse.robot", tests: [{ name: "Load the orders", line: 5 }, { name: "Reconcile the totals", line: 10 }] }]);
    expect(j.environments).toEqual(["tst"]);
  });
});
