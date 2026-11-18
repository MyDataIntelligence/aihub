import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { commandsFor, planTests } from "../src/lib/testChanged.js";
import { ctxFor, fakeFetch, makeRepo, sh, write } from "./helpers.js";

const ALL = [
  "src/orders/discount.py",
  "src/orders/export.py",
  "src/orders/__init__.py",
  "src/billing/tax.py",
  "tests/unit/orders/test_discount.py",
  "tests/unit/test_export_flow.py",
  "tests/unit/billing/tax_test.py",
  "tests/robot/orders.robot",
  "web/src/cart.ts",
  "web/src/cart.test.ts",
  "web/src/price.ts",
  "web/tests/checkout.spec.ts",
  "README.md",
];
const CONTENT: Record<string, string> = {
  "tests/unit/test_export_flow.py": "from orders import export\n\ndef test_flow():\n    assert export\n",
  "web/tests/checkout.spec.ts": "import { price } from '../src/price';\n",
};
const read = (rel: string) => CONTENT[rel] ?? "";

describe("planTests heuristics", () => {
  it("Python: test_<module>.py, <module>_test.py and tests that import the module", () => {
    const p = planTests(".", ["src/orders/discount.py", "src/orders/export.py", "src/billing/tax.py"], ALL, {}, read);
    expect(p.tests.map((t) => t.file)).toEqual(["tests/unit/billing/tax_test.py", "tests/unit/orders/test_discount.py", "tests/unit/test_export_flow.py"]);
    expect(p.tests.find((t) => t.file.endsWith("test_export_flow.py"))!.for).toEqual(["src/orders/export.py"]);
    expect(p.commands).toEqual(["pytest tests/unit/billing/tax_test.py tests/unit/orders/test_discount.py tests/unit/test_export_flow.py"]);
    expect(p.unmapped).toEqual([]);
  });

  it("JS/TS: <name>.test.ts next to the file, and specs that import it", () => {
    const p = planTests(".", ["web/src/cart.ts", "web/src/price.ts"], ALL, {}, read);
    expect(p.tests.map((t) => t.file)).toEqual(["web/src/cart.test.ts", "web/tests/checkout.spec.ts"]);
    expect(p.commands).toEqual(["npx vitest run web/src/cart.test.ts web/tests/checkout.spec.ts"]);
  });

  it("a changed test file runs itself; Python code is never matched to JS tests", () => {
    const p = planTests(".", ["tests/unit/orders/test_discount.py", "src/orders/__init__.py"], ALL, {}, read);
    expect(p.tests.map((t) => t.file)).toEqual(["tests/unit/orders/test_discount.py", "tests/unit/test_export_flow.py"]);
  });

  it("code without a test is reported, docs and config are ignored, nothing falls back to the whole suite", () => {
    const all = [...ALL, "src/orders/new_thing.py"];
    const p = planTests(".", ["src/orders/new_thing.py", "README.md"], all, {}, read);
    expect(p.tests).toEqual([]);
    expect(p.unmapped).toEqual(["src/orders/new_thing.py"]);
    expect(p.commands).toEqual([]);
  });

  it("team.yaml tests.map and tests.command win: a Robot suite for a flow, a custom command", () => {
    const p = planTests(".", ["src/orders/new_thing.py"], [...ALL, "src/orders/new_thing.py"], { command: "python -m pytest -q {tests}", map: [{ source: "src/orders/**", tests: ["tests/robot/*.robot"] }] }, read);
    expect(p.tests.map((t) => t.file)).toEqual(["tests/robot/orders.robot"]);
    expect(p.commands).toEqual(["python -m pytest -q tests/robot/orders.robot"]);
  });

  it("quotes paths with spaces", () => {
    expect(commandsFor(["tests/my tests/test_a.py"])).toEqual(['pytest "tests/my tests/test_a.py"']);
    expect(commandsFor([])).toEqual([]);
  });
});

function repo(team = "repositories:\n  - name: test-repo\n    defaultTarget: main\n") {
  const { dir } = makeRepo();
  write(dir, ".agents/skills/_shared/references/team.yaml", team);
  write(dir, "src/orders/discount.py", "def d(): return 1\n");
  write(dir, "src/orders/other.py", "def o(): return 1\n");
  write(dir, "tests/unit/test_discount.py", "from src.orders import discount\n");
  write(dir, "tests/unit/test_other.py", "from src.orders import other\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "base"]);
  sh(dir, ["push", "origin", "main"]);
  sh(dir, ["checkout", "-b", "feature/5-x"]);
  return dir;
}

async function run(dir: string, args: string[]) {
  const { ctx, lines, errs } = ctxFor(dir, fakeFetch([]).fn);
  const code = await main(["test", ...args], ctx);
  return { code, out: lines.join("\n"), errs };
}

describe("aihub test changed", () => {
  it("lists the tests of what the branch changed (committed, uncommitted and untracked) and not the rest", async () => {
    const dir = repo();
    write(dir, "src/orders/discount.py", "def d(): return 2\n");
    sh(dir, ["commit", "-am", "feat: change discount"]);
    write(dir, "src/orders/brand_new.py", "x = 1\n");
    const r = await run(dir, ["changed"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("changed vs main");
    expect(r.out).toContain("tests/unit/test_discount.py  (for src/orders/discount.py)");
    expect(r.out).not.toContain("test_other.py");
    expect(r.out).toContain("command: pytest tests/unit/test_discount.py");
    expect(r.out).toContain("no test found for: src/orders/brand_new.py");
  });

  it("--json and --base", async () => {
    const dir = repo();
    write(dir, "src/orders/other.py", "def o(): return 3\n");
    const r = await run(dir, ["changed", "--json", "--base", "main"]);
    const j = JSON.parse(r.out);
    expect(j.tests.map((t: any) => t.file)).toEqual(["tests/unit/test_other.py"]);
    expect(j.ran).toBe(false);
  });

  it("--run executes only the mapped command and fails when it fails", async () => {
    const dir = repo("repositories:\n  - name: test-repo\n    defaultTarget: main\ntests:\n  command: \"node check.js {tests}\"\n");
    write(dir, "check.js", "process.exit(process.argv.length > 2 ? 3 : 0);\n");
    write(dir, "src/orders/other.py", "def o(): return 3\n");
    const { ctx, lines } = ctxFor(dir, fakeFetch([]).fn);
    await expect(main(["test", "changed", "--run"], ctx)).resolves.toBe(1);
    expect(lines.join("\n")).toContain("running: node check.js tests/unit/test_other.py");
  });

  it("nothing mapped: prints that nothing runs locally and --run runs nothing", async () => {
    const dir = repo();
    write(dir, "README.md", "# docs\n");
    const r = await run(dir, ["changed", "--run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("no tests map to the changed files: run nothing locally, the pipeline runs the full suite");
  });

  it("usage", async () => {
    const dir = repo();
    expect((await run(dir, ["--help"])).out).toContain("aihub test changed");
    expect((await run(dir, ["nope"])).code).toBe(1);
  });
});
