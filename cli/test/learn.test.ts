import { existsSync, writeFileSync } from "node:fs";
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

function goHome(dir: string, home: string, args: string[]) {
  const f = fakeFetch([]);
  const { ctx, lines, errs } = ctxFor(dir, f.fn);
  ctx.env = { ...ctx.env, AIHUB_LEARN_HOME: home };
  return main(args, ctx).then((code) => ({ code, out: lines.join("\n"), errs: errs.join("\n"), home }));
}

describe("the personal learn store", () => {
  it("saves a validated lesson under the user home, never in the repository, and lists and shows it", async () => {
    const dir = world();
    const home = tmp("aihub-learn-");
    const ex = join(tmp(), "e.json");
    const facts = join(tmp(), "f.json");
    writeFileSync(ex, JSON.stringify(GOOD));
    writeFileSync(facts, (await go(dir, ["learn", "change", "--json"])).out);
    const saved = await goHome(dir, home, ["learn", "save", "--file", ex, "--facts", facts, "--json"]);
    expect(saved.code).toBe(0);
    const meta = JSON.parse(saved.out);
    expect(meta).toMatchObject({ repo: "work", concepts: 1, quiz: 1, source: { branch: "feature/42-guard" } });
    expect(existsSync(join(home, "lessons", `${meta.id}.json`))).toBe(true);
    expect(sh(dir, ["status", "--porcelain"])).not.toContain("learn");
    const list = JSON.parse((await goHome(dir, home, ["learn", "list", "--json"])).out);
    expect(list.map((m: { id: string }) => m.id)).toEqual([meta.id]);
    const shown = JSON.parse((await goHome(dir, home, ["learn", "show", "--id", meta.id, "--json"])).out);
    expect(shown.explanation.oneSentence).toBe(GOOD.oneSentence);
    expect(shown.facts.files.length).toBe(3);
    expect((await goHome(dir, home, ["learn", "list", "--all", "--json"])).out).toContain(meta.id);
  });

  it("refuses to save an invalid explanation and says why", async () => {
    const ex = join(tmp(), "bad.json");
    writeFileSync(ex, JSON.stringify({ ...GOOD, kind: "nope" }));
    const home = tmp("aihub-learn-");
    const r = await goHome(makeRepo().dir, home, ["learn", "save", "--file", ex]);
    expect(r.code).toBe(1);
    expect(r.errs).toContain("nothing was saved");
    expect(existsSync(join(home, "lessons"))).toBe(false);
  });

  it("keeps lessons of another repository out of list unless --all", async () => {
    const home = tmp("aihub-learn-");
    const ex = join(tmp(), "e.json");
    writeFileSync(ex, JSON.stringify(GOOD));
    await goHome(world(), home, ["learn", "save", "--file", ex]);
    expect(JSON.parse((await goHome(makeRepo().dir, home, ["learn", "list", "--json"])).out)).toEqual([]);
    expect(JSON.parse((await goHome(makeRepo().dir, home, ["learn", "list", "--all", "--json"])).out)).toHaveLength(1);
  });

  it("lists concepts, marks one as learned, and keeps quiz scores", async () => {
    const dir = world();
    const home = tmp("aihub-learn-");
    const ex = join(tmp(), "e.json");
    writeFileSync(ex, JSON.stringify(GOOD));
    const id = JSON.parse((await goHome(dir, home, ["learn", "save", "--file", ex, "--json"])).out).id;
    let rows = JSON.parse((await goHome(dir, home, ["learn", "concepts", "--json"])).out);
    expect(rows).toEqual([{ name: "Guard clause", eli5: "Eerst de rare gevallen.", example: "if factor < 0", lessons: [id], learned: false }]);
    await goHome(dir, home, ["learn", "concepts", "--mark", "guard clause"]);
    rows = JSON.parse((await goHome(dir, home, ["learn", "concepts", "--json"])).out);
    expect(rows[0].learned).toBe(true);
    const quiz = JSON.parse((await goHome(dir, home, ["learn", "quiz", "--id", id, "--json"])).out);
    expect(quiz[0].item.answerIndex).toBe(1);
    expect((await goHome(dir, home, ["learn", "quiz", "--score", id, "--correct", "1", "--of", "1"])).out).toContain("kept 1/1");
    expect((await goHome(dir, home, ["learn", "quiz", "--score", id, "--correct", "3", "--of", "1"])).code).toBe(1);
    await goHome(dir, home, ["learn", "forget", "--id", id]);
    expect(JSON.parse((await goHome(dir, home, ["learn", "list", "--json"])).out)).toEqual([]);
  });
});

describe("learn diagram, flow, glossary, week, onboarding, item", () => {
  it("draws the architecture from the facts: changed names, callers and tests, nothing invented", async () => {
    const r = JSON.parse((await go(world(), ["learn", "diagram", "--kind", "architecture", "--json"])).out);
    expect(r.kind).toBe("architecture");
    expect(r.mermaid).toMatch(/^flowchart LR/);
    expect(r.mermaid).toContain("app/report.py");
    expect(r.mermaid).toContain(":::changed");
    expect(r.mermaid).toContain("-.->");
    expect(r.basedOn).toContain("text search");
    expect(mermaidProblem(r.mermaid)).toBeUndefined();
  });

  it("draws dbt lineage of the change and of the whole repository, and says when there is nothing to draw", async () => {
    const dir = world();
    const ch = JSON.parse((await go(dir, ["learn", "diagram", "--kind", "lineage", "--branch", "feature/42-guard", "--json"])).out);
    expect(ch.mermaid).toContain("raw_orders");
    expect(ch.mermaid).toContain("class n_orders changed");
    const all = JSON.parse((await go(dir, ["learn", "diagram", "--kind", "lineage", "--json"])).out);
    expect(all.empty).toBe(false);
    const none = JSON.parse((await go(makeRepo().dir, ["learn", "diagram", "--kind", "lineage", "--json"])).out);
    expect(none.empty).toBe(true);
  });

  it("draws the repository and the team flow (from team.yaml when there is one)", async () => {
    const { dir } = makeRepo();
    write(dir, ".agents/skills/_shared/references/team.yaml", "repositories:\n  - name: test-repo\n    defaultTarget: staging\nbranches:\n  feature: 'feature/<id>-<slug>'\n  protected: [staging]\n");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "team"]);
    const f = JSON.parse((await go(dir, ["learn", "flow", "--json"])).out);
    expect(f.source).toContain("team.yaml");
    expect(f.steps.find((s: { name: string }) => s.name === "Pull request").detail).toContain("staging");
    expect(f.steps.find((s: { name: string }) => s.name === "Branch").detail).toContain("feature/<id>-<slug>");
    expect(JSON.parse((await go(makeRepo().dir, ["learn", "flow", "--json"])).out).source).toContain("generic");
    expect(JSON.parse((await go(world(), ["learn", "diagram", "--kind", "repo", "--json"])).out).mermaid).toContain("flowchart TD");
  });

  it("glossary uses only the repository's own files", async () => {
    const dir = world();
    write(dir, "README.md", "# Demo\n\n## Betaalkosten\n\n- **Cap**: het maximum dat een betaling kost\n");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "readme"]);
    const g = JSON.parse((await go(dir, ["learn", "glossary", "--json"])).out);
    const t = Object.fromEntries(g.terms.map((x: { term: string; meaning: string }) => [x.term, x.meaning]));
    expect(t["Cap"]).toBe("het maximum dat een betaling kost");
    expect(t["raw.orders"]).toBe("dbt source");
    expect(g.notes[0]).toContain("unverified");
  });

  it("week lists my commits of the last days and the most touched files", async () => {
    const dir = world();
    sh(dir, ["config", "user.email", "test@example.com"]);
    const w = JSON.parse((await go(dir, ["learn", "week", "--json"])).out);
    expect(w.commits.map((c: { subject: string }) => c.subject)).toContain("guard negative factor");
    expect(w.files.map((f: { path: string }) => f.path)).toContain("app/scale.py");
  });

  it("item: a python file, a dbt model, a pipeline yaml and a Fabric item folder", async () => {
    const dir = world();
    write(dir, "azure-pipelines.yml", "trigger: [main]\nstages:\n  - stage: Build\n    jobs:\n      - job: Test\n  - stage: Deploy\n    jobs:\n      - job: Ship\n");
    write(dir, "fab/nb_load.Notebook/notebook-content.py", "# notebook\nspark.read.table('x')\n");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "more"]);
    const file = JSON.parse((await go(dir, ["learn", "item", "app/scale.py", "--json"])).out);
    expect(file).toMatchObject({ type: "file", language: "python" });
    expect(file.details.definitions).toContain("scale");
    expect(file.usedBy.map((u: { file: string }) => u.file)).toContain("app/report.py");
    const model = JSON.parse((await go(dir, ["learn", "item", "dbt/models/orders.sql", "--json"])).out);
    expect(model.details).toMatchObject({ name: "orders", sources: ["raw.orders"], downstream: ["revenue"] });
    expect(mermaidProblem(model.mermaid)).toBeUndefined();
    const pipe = JSON.parse((await go(dir, ["learn", "item", "azure-pipelines.yml", "--json"])).out);
    expect(pipe.type).toBe("pipeline");
    expect(pipe.details.stages).toEqual([{ stage: "Build", jobs: ["Test"] }, { stage: "Deploy", jobs: ["Ship"] }]);
    expect(pipe.mermaid).toContain("Build");
    write(dir, "ci-pipeline.yaml", "stages:\n  - stage: Validate\n    jobs:\n      - job: Check\n      - template: /cicd/verify.yaml@shared\n        parameters:\n          jobName: Verify\n");
    const tpl = JSON.parse((await go(dir, ["learn", "item", "ci-pipeline.yaml", "--json"])).out);
    expect(tpl.details.stages).toEqual([{ stage: "Validate", jobs: ["Check", "template /cicd/verify.yaml@shared"] }]);
    const fab = JSON.parse((await go(dir, ["learn", "item", "fab/nb_load.Notebook/notebook-content.py", "--json"])).out);
    expect(fab).toMatchObject({ type: "fabric-item", path: "fab/nb_load.Notebook" });
    const bad = await go(dir, ["learn", "item", "nope.py"]);
    expect(bad.code).toBe(1);
  });

  it("onboarding bundles the repository, the flow, terms and pictures", async () => {
    const b = JSON.parse((await go(world(), ["learn", "onboarding", "--json"])).out);
    expect(b.kind).toBe("onboarding");
    expect(b.diagrams.length).toBeGreaterThanOrEqual(3);
    for (const d of b.diagrams) expect(mermaidProblem(d.mermaid)).toBeUndefined();
  });
});

describe("iDiagram links in an explanation", () => {
  it("accepts https links on a diagram and refuses others", () => {
    const d = { title: "t", kind: "flow", mermaid: "flowchart LR\n A-->B" };
    expect(validateExplanation({ ...GOOD, diagrams: [{ ...d, idiagramUrl: "https://idiagram.vercel.app/#board=x", playUrl: "https://idiagram.vercel.app/#board=x&play=1" }] }).ok).toBe(true);
    expect(validateExplanation({ ...GOOD, diagrams: [{ ...d, playUrl: "javascript:alert(1)" }] }).errors.join(" ")).toContain("playUrl must be an https link");
  });
});
