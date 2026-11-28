import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { browseOf } from "../src/lib/browse/core.js";
import { changeDiff, changeStart, changeWrite } from "../src/lib/browse/change.js";
import { changeVerify, couldNotRun, lintChecks, sparseFolders, testErrors } from "../src/lib/browse/verify.js";
import { ctxFor, fakeFetch, sh, tmp, write, type Route } from "./helpers.js";

const TEAM = `version: 1
language: en
guidelines:
  linters:
    - name: badword
      command: node tools/lint.cjs {files}
      files: ["**/*.py"]
tests:
  command: node {tests}
  map:
    - source: "src/*.py"
      tests: "tests/check.cjs"
`;
// a linter: "file:line: message" for every line with BAD
const LINT = `const fs=require("fs");for(const f of process.argv.slice(2)){fs.readFileSync(f,"utf8").split(/\\n/).forEach((l,i)=>{if(l.includes("BAD"))console.log(f+":"+(i+1)+": no BAD here")})}`;
// a test: fails when src/calc.py says "return 3"
const CHECK = `const s=require("fs").readFileSync("src/calc.py","utf8");if(s.includes("return 3")){console.log("tests/check.cjs:1: AssertionError: expected 2");process.exit(1)}console.log("ok")`;

/** A bare origin (served over file://, with partial clone allowed) and its main branch. */
function origin(o: { team?: string; files?: Record<string, string> } = {}) {
  const root = tmp("aihub-verify-world-");
  const bare = join(root, "repo-a.git");
  const work = join(root, "work");
  mkdirSync(bare);
  mkdirSync(work);
  sh(bare, ["init", "--bare", "-b", "main"]);
  sh(bare, ["config", "uploadpack.allowFilter", "true"]);
  sh(bare, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  sh(work, ["init", "-b", "main"]);
  write(work, ".agents/skills/_shared/references/team.yaml", o.team ?? TEAM);
  write(work, "tools/lint.cjs", LINT);
  write(work, "tests/check.cjs", CHECK);
  for (const [p, text] of Object.entries(o.files ?? {})) write(work, p, text);
  write(work, "src/calc.py", "def two():\n    return 2\n");
  write(work, "docs/big/other.md", "not needed for lint\n");
  sh(work, ["add", "-A"]);
  sh(work, ["commit", "-m", "init"]);
  sh(work, ["remote", "add", "origin", bare]);
  sh(work, ["push", "-q", "origin", "main"]);
  const head = sh(work, ["rev-parse", "HEAD"]);
  return { url: pathToFileURL(bare).href, head };
}

function world(url: string, head: string) {
  const files: Record<string, string> = { "/src/calc.py": "def two():\n    return 2\n" };
  const routes: Route[] = [
    { match: /\/_apis\/connectionData/, respond: () => ({ body: { authenticatedUser: { id: "me" } } }) },
    { match: /^https:\/\/dev\.azure\.com\/ferron-test\/_apis\/projects\?/, respond: () => ({ body: { value: [{ id: "p1", name: "test-project" }] } }) },
    { match: /^https:\/\/dev\.azure\.com\/ferron-test\/_apis\/git\/repositories\?/, respond: () => ({ body: { value: [{ id: "r1", name: "repo-a", defaultBranch: "refs/heads/main", remoteUrl: url, project: { id: "p1", name: "test-project" } }] } }) },
    { match: /refs\?filter=heads%2Fmain/, respond: () => ({ body: { value: [{ name: "refs/heads/main", objectId: head }] } }) },
    { match: /blobs\//, respond: () => ({ status: 404, body: { message: "not found" } }) },
    {
      match: /repo-a\/items\?path=/,
      respond: (c) => {
        const path = decodeURIComponent(/path=([^&]+)/.exec(c.url)![1]);
        const content = files[path];
        if (content === undefined) return { status: 404, body: { message: `TF401174: The item '${path}' could not be found` } };
        return { body: { objectId: `o${path}`, gitObjectType: "blob", commitId: head, path, ...(c.url.includes("includeContent=true") ? { content } : {}) } };
      },
    },
  ];
  const f = fakeFetch(routes);
  const { ctx } = ctxFor(tmp(), f.fn);
  ctx.env = { ...process.env, ...ctx.env, AIHUB_ADO_ORG: "ferron-test", AIHUB_COMMON_ROOTS: "none" };
  return { ctx, b: () => browseOf(ctx, {}) };
}

const copies = () => readdirSync(tmpdir()).filter((n) => n.startsWith("aihub-verify-") && !n.startsWith("aihub-verify-world-"));

describe("change verify: lint and tests in a temporary copy", () => {
  it("lints only the changed lines and runs the mapped tests; reports the first errors and removes the copy", async () => {
    const o = origin();
    const w = world(o.url, o.head);
    const before = copies().length;
    const s = await changeStart(w.b(), { project: "test-project", repo: "repo-a", paths: ["/src/calc.py"], prompt: "x" });
    await changeWrite(w.b(), s.id, "/src/calc.py", { content: "def two():\n    return 3  # BAD\n" });
    const steps: string[] = [];
    const r = await changeVerify(w.b(), s.id, { tests: true, progress: (e) => steps.push(`${e.n}/${e.total} ${e.step}`) });
    expect(steps).toEqual(["1/6 clone", "2/6 checkout", "3/6 apply", "4/6 lint", "5/6 test", "6/6 cleanup"]);
    expect(r.ok).toBe(false);
    expect(r.copyRemoved).toBe(true);
    expect(r.files).toEqual(["/src/calc.py"]);
    expect(r.checks.find((c) => c.name === "badword")).toMatchObject({ kind: "lint", status: "failed", errors: [{ path: "/src/calc.py", line: 2, message: "no BAD here" }] });
    expect(r.checks.find((c) => c.kind === "test")).toMatchObject({ status: "failed", errors: [{ path: "/tests/check.cjs", line: 1, message: "AssertionError: expected 2" }] });
    expect(copies().length).toBe(before);
    // the last run is part of the change
    expect((await changeDiff(w.b(), s.id)).verify).toMatchObject({ ok: false });
  }, 120_000);

  it("passes a clean change with lint only, from a sparse copy", async () => {
    const o = origin();
    const w = world(o.url, o.head);
    const s = await changeStart(w.b(), { project: "test-project", repo: "repo-a", paths: ["/src/calc.py"], prompt: "x" });
    await changeWrite(w.b(), s.id, "/src/calc.py", { content: "def two():\n    return 1 + 1\n" });
    const r = await changeVerify(w.b(), s.id, {});
    expect(r.ok).toBe(true);
    expect(r.checks).toEqual([{ name: "guidelines", kind: "lint", status: "passed", errors: [], tookMs: expect.any(Number), command: "aihub guidelines check" }]);
    expect(r.copyRemoved).toBe(true);
  }, 120_000);

  it("removes the copy also when the clone fails", async () => {
    const w = world(pathToFileURL(join(tmp(), "nope.git")).href, "1".repeat(40));
    const before = copies().length;
    const s = await changeStart(w.b(), { project: "test-project", repo: "repo-a", paths: ["/src/calc.py"], prompt: "x" });
    await changeWrite(w.b(), s.id, "/src/calc.py", { content: "x = 1\n" });
    await expect(changeVerify(w.b(), s.id, {})).rejects.toThrow(/git clone failed/);
    expect(copies().length).toBe(before);
    expect(existsSync(s.dir)).toBe(true);
  }, 120_000);

  it("tests that cannot start (a missing module) are couldNotRun with the module, not a failure", async () => {
    const o = origin({ files: { "tests/check.cjs": 'require("leftpad-not-there");console.log("ok")' } });
    const w = world(o.url, o.head);
    const s = await changeStart(w.b(), { project: "test-project", repo: "repo-a", paths: ["/src/calc.py"], prompt: "x" });
    await changeWrite(w.b(), s.id, "/src/calc.py", { content: "def two():\n    return 1 + 1\n" });
    const r = await changeVerify(w.b(), s.id, { tests: true });
    expect(r.checks.find((c) => c.kind === "test")).toMatchObject({ status: "couldNotRun", missing: ["leftpad-not-there"], reason: "missing dependency leftpad-not-there" });
    expect(r.ok).toBe(true);
    expect(r.copyRemoved).toBe(true);
  }, 120_000);

  it("runs tests.setup of team.yaml in the copy before the tests", async () => {
    const team = TEAM.replace("  command: node {tests}", "  command: node {tests}\n  setup: node tools/setup.cjs");
    const o = origin({ team, files: { "tools/setup.cjs": 'require("fs").writeFileSync("tests/ready.txt","x")', "tests/check.cjs": 'if(!require("fs").existsSync("tests/ready.txt")){console.log("tests/check.cjs:1: AssertionError: no setup");process.exit(1)}console.log("ok")' } });
    const w = world(o.url, o.head);
    const s = await changeStart(w.b(), { project: "test-project", repo: "repo-a", paths: ["/src/calc.py"], prompt: "x" });
    await changeWrite(w.b(), s.id, "/src/calc.py", { content: "def two():\n    return 1 + 1\n" });
    const r = await changeVerify(w.b(), s.id, { tests: true });
    expect(r.checks.find((c) => c.kind === "test")).toMatchObject({ status: "passed" });
    expect(r.notes).toEqual([]);
  }, 120_000);

  it("knows which folders the lint copy needs and reads test failures", () => {
    expect(couldNotRun("ERROR tests/test_report.py\nE   ModuleNotFoundError: No module named 'context_fixture_a'\n!!! Interrupted: 1 error during collection !!!", 2, "python -m pytest tests/test_report.py")).toEqual({ missing: ["context_fixture_a"], reason: "missing dependency context_fixture_a" });
    expect(couldNotRun("FAILED tests/test_a.py::test_x - assert 3 == 2", 1, "python -m pytest")).toBeUndefined();
    expect(couldNotRun("tests/test_a.py F\nE   ModuleNotFoundError: No module named 'x'\n==== 1 failed in 0.1s ====", 1, "python -m pytest")).toBeUndefined();
    expect(couldNotRun("ERROR: usage: pytest [options]", 4, "python -m pytest")).toMatchObject({ missing: [] });
    expect(couldNotRun("collected 0 items", 5, "python -m pytest")).toEqual({ missing: [], reason: "no tests were collected" });
    expect(couldNotRun("some tool output", 4, "node tests/check.cjs")).toBeUndefined();
    expect(couldNotRun("[ ERROR ] Error in file 'tests/a.robot' on line 3: Importing library 'context_fixture_a' failed: ModuleNotFoundError", 252, "robot tests")).toMatchObject({ missing: ["context_fixture_a"] });
    expect(sparseFolders(["/src/a.py", "/src/sub/b.py", "/README.md"])).toEqual([".agents/skills/_shared/references", ".github/instructions", "src", "src/sub"]);
    expect(testErrors("collected 3 items\nFAILED tests/test_calc.py::test_two - AssertionError: assert 3 == 2\n1 failed")).toEqual([{ path: "/tests/test_calc.py", message: "AssertionError: assert 3 == 2" }]);
    expect(lintChecks({ base: "main", baseReason: "", files: ["a.py"], findings: [], skipped: [{ name: "ruff", why: "not installed" }], rules: [] }, 5, "aihub guidelines check")).toEqual([
      { name: "ruff", kind: "lint", status: "skipped", errors: [], tookMs: 0, reason: "not installed" },
      { name: "guidelines", kind: "lint", status: "passed", errors: [], tookMs: 5, command: "aihub guidelines check" },
    ]);
  });
});
