import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isTestPath, parseHunks } from "../src/lib/learn.js";
import { mermaidProblem, validateExplanation } from "../src/lib/learnSchema.js";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, sh, tmp, write } from "./helpers.js";

/** A repo with main plus a feature branch that adds a guard to a Python function, a test and a dbt model change. */
function world() {
  const { dir } = makeRepo();
  write(dir, "app/scale.py", "def scale(value, factor):\n    return value * factor\n");
  write(dir, "app/report.py", "from app.scale import scale\n\ndef report(v):\n    return scale(v, 2)\n");
  write(dir, "dbt/models/orders.sql", "select * from {{ source('raw', 'orders') }}\n");
  write(dir, "dbt/models/revenue.sql", "select * from {{ ref('orders') }}\n");
  write(dir, "dbt/dbt_project.yml", "name: demo\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "base"]);
  sh(dir, ["push", "origin", "main"]);
  sh(dir, ["switch", "-c", "feature/42-guard"]);
  write(dir, "app/scale.py", "def scale(value, factor):\n    if factor < 0:\n        raise ValueError('factor must be >= 0')\n    return value * factor\n");
  write(dir, "tests/test_scale.py", "from app.scale import scale\n\ndef test_negative():\n    pass\n");
  write(dir, "dbt/models/orders.sql", "select id, amount from {{ source('raw', 'orders') }}\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "guard negative factor"]);
  return dir;
}

function go(dir: string, args: string[]) {
  const f = fakeFetch([]);
  const { ctx, lines, errs } = ctxFor(dir, f.fn);
  return main(args, ctx).then((code) => ({ code, out: lines.join("\n"), errs: errs.join("\n") }));
}

describe("aihub learn change", () => {
  it("gives the files, hunks and changed names of the branch against its target, as JSON", async () => {
    const dir = world();
    const r = await go(dir, ["learn", "change", "--json"]);
    expect(r.code).toBe(0);
    const f = JSON.parse(r.out);
    expect(f.kind).toBe("change-facts");
    expect(f.story).toEqual({ id: 42 });
    expect(f.commits[0].subject).toBe("guard negative factor");
    expect(f.files.map((x: { path: string }) => x.path).sort()).toEqual(["app/scale.py", "dbt/models/orders.sql", "tests/test_scale.py"]);
    const scale = f.files.find((x: { path: string }) => x.path === "app/scale.py");
    expect(scale).toMatchObject({ status: "modified", additions: 2, language: "python" });
    expect(scale.hunks[0].added.join("\n")).toContain("raise ValueError");
    expect(f.symbols.map((s: { name: string }) => s.name)).toContain("scale");
  });

  it("finds who uses the changed function, the tests that mention it, and the dbt lineage", async () => {
    const f = JSON.parse((await go(world(), ["learn", "change", "--json"])).out);
    expect(f.impact.callers.map((c: { file: string }) => c.file)).toContain("app/report.py");
    expect(f.impact.tests.map((c: { file: string }) => c.file)).toContain("tests/test_scale.py");
    expect(f.impact.dbt).toEqual([{ name: "orders", file: "dbt/models/orders.sql", upstream: [], downstream: ["revenue"], sources: ["raw.orders"] }]);
    expect(f.notes.join(" ")).toContain("text search");
  });

  it("accepts --range and refuses an unknown revision", async () => {
    const dir = world();
    const ok = JSON.parse((await go(dir, ["learn", "change", "--range", "main..HEAD", "--json"])).out);
    expect(ok.stats.files).toBe(3);
    const bad = await go(dir, ["learn", "change", "--range", "nope..HEAD"]);
    expect(bad.code).toBe(1);
    expect(bad.errs).toContain("unknown revision");
  });

  it("prints a short text summary without --json, and runs in well under a few seconds", async () => {
    const t = Date.now();
    const r = await go(world(), ["learn", "change"]);
    expect(r.out).toContain("3 file(s)");
    expect(r.out).toContain("changed names: scale");
    expect(Date.now() - t).toBeLessThan(8000);
  });
});

describe("aihub learn repo", () => {
  it("gives folders, languages, tests and the dbt graph", async () => {
    const f = JSON.parse((await go(world(), ["learn", "repo", "--json"])).out);
    expect(f.kind).toBe("repo-facts");
    expect(f.languages.python).toBeGreaterThanOrEqual(2);
    expect(f.dbt).toMatchObject({ models: 2, sources: ["raw.orders"] });
    expect(f.dbt.edges).toEqual(expect.arrayContaining([{ from: "raw.orders", to: "orders" }, { from: "orders", to: "revenue" }]));
  });
});

describe("helpers", () => {
  it("parses hunks with their header and lines", () => {
    const h = parseHunks("@@ -1,2 +1,4 @@ def scale(value, factor):\n+    if factor < 0:\n+        raise\n-old\n");
    expect(h).toEqual([{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 4, header: "def scale(value, factor):", added: ["    if factor < 0:", "        raise"], removed: ["old"] }]);
  });

  it("knows test paths", () => {
    for (const p of ["tests/test_a.py", "src/a.test.ts", "test_x.py", "app/foo_test.go"]) expect(isTestPath(p)).toBe(true);
    for (const p of ["app/latest.py", "src/contest.ts"]) expect(isTestPath(p)).toBe(false);
  });
});

const GOOD = {
  kind: "change-explanation",
  oneSentence: "scale weigert een negatieve factor.",
  before: "Elke factor werd gebruikt.",
  after: "Een negatieve factor geeft een ValueError.",
  diagram: { before: "flowchart LR\n  A[waarde] --> B[x factor]", after: "flowchart LR\n  A[waarde] --> G{factor negatief?}\n  G -- ja --> E[ValueError]\n  G -- nee --> B[x factor]" },
  diagrams: [{ title: "Wie gebruikt scale", kind: "architecture", mermaid: "flowchart TD\n  report --> scale" }],
  designChoices: [{ choice: "Guard clause", alternatives: [{ option: "Stil op 0 zetten", whyNot: "verbergt de fout" }] }],
  tellAColleague: ["Er is een guard bij.", "Negatieve factor geeft ValueError."],
  risks: ["Wie bewust negatief rekent moet dit niet gebruiken."],
  quiz: [{ question: "Wat geeft scale(1, -1)?", options: ["-1", "ValueError"], answerIndex: 1, explanation: "Guard." }],
  concepts: [{ name: "Guard clause", eli5: "Eerst de rare gevallen.", exampleFromThisChange: "if factor < 0" }],
  hunkReasons: [{ path: "app/scale.py", line: 2, reason: "zodat een negatieve factor meteen faalt" }],
};

describe("aihub learn validate", () => {
  it("accepts the port of the old explanation schema, and warns that tryIt is ignored", () => {
    expect(validateExplanation(GOOD)).toEqual({ ok: true, errors: [], warnings: [] });
    expect(validateExplanation({ ...GOOD, tryIt: [{}] }).warnings).toEqual(["tryIt is ignored: Learn does not run code"]);
  });

  it("names every problem: missing parts, a bad quiz index, broken Mermaid", () => {
    const bad = { ...GOOD, oneSentence: "", diagram: { before: "not mermaid", after: "flowchart LR\n A[x --> B" }, quiz: [{ question: "q", options: ["a", "b"], answerIndex: 5, explanation: "e" }], tellAColleague: ["één"] };
    const r = validateExplanation(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toContain("oneSentence is required");
    expect(r.errors.join("\n")).toContain("diagram.before does not start with a Mermaid diagram type");
    expect(r.errors.join("\n")).toContain("diagram.after has unbalanced []");
    expect(r.errors.join("\n")).toContain("quiz[0].answerIndex");
    expect(r.errors.join("\n")).toContain("tellAColleague must be a list of at least 2");
  });

  it("cross-checks hunkReasons against the facts so no file is invented", () => {
    const facts = { files: [{ path: "app/scale.py" }] } as never;
    expect(validateExplanation(GOOD, facts).warnings).toEqual([]);
    const r = validateExplanation({ ...GOOD, hunkReasons: [{ path: "app/ghost.py", line: 1, reason: "x" }] }, facts);
    expect(r.warnings[0]).toContain("not a changed file");
  });

  it("checks Mermaid size and fences", () => {
    expect(mermaidProblem("flowchart LR\n A-->B")).toBeUndefined();
    expect(mermaidProblem("flowchart LR\n" + "A-->B\n".repeat(900))).toContain("longer than");
    expect(mermaidProblem("```mermaid\nflowchart LR\n```")).toBeDefined();
  });

  it("the CLI command validates a file and fails with the errors", async () => {
    const dir = tmp();
    const f = join(dir, "e.json");
    writeFileSync(f, JSON.stringify(GOOD));
    expect((await go(makeRepo().dir, ["learn", "validate", "--file", f])).out).toBe("OK");
    writeFileSync(f, JSON.stringify({ ...GOOD, kind: "x" }));
    const bad = await go(makeRepo().dir, ["learn", "validate", "--file", f]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("kind must be");
  });
});
