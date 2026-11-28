import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { commands, main } from "../src/router.js";
import { addedLines, applyToOf, collectGuidelines, guidelinesSettings, parseLinterOutput, rulesOf } from "../src/lib/guidelines.js";
import { ctxFor, fakeFetch, makeRepo, sh, tmp, write } from "./helpers.js";

vi.setConfig({ testTimeout: 30_000 });

/** A repository with rules in every place an agent reads them. */
function world() {
  const { dir } = makeRepo();
  for (const [k, v] of [["user.name", "Test"], ["user.email", "test@example.com"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) sh(dir, ["config", k, v]);
  write(dir, "AGENTS.md", "# Repository rules\n\n- Write docstrings in English.\n- Never log secrets.\n\n```\n- not a rule (code)\n```\n");
  write(dir, "src/etl/AGENTS.md", "# ETL rules\n\n- Use snake_case for column names.\n- Never log secrets.\n");
  write(dir, "CLAUDE.md", "- Keep functions under 40 lines.\n");
  write(dir, ".github/copilot-instructions.md", "Prefer small pull requests.\n");
  write(dir, ".github/instructions/sql.instructions.md", '---\napplyTo: "**/*.sql"\n---\n- Uppercase SQL keywords.\n');
  write(dir, ".github/instructions/python.instructions.md", '---\napplyTo: "**/*.py,scripts/**"\n---\n- Type hints on public functions.\n');
  write(dir, "docs/team-guide.md", "# Team guide\n\n1. Name tests test_<what>.\n");
  write(dir, ".agents/skills/_shared/references/team.yaml", "guidelines:\n  - docs/team-guide.md\n");
  write(dir, "src/etl/orders.py", "def export():\n    return 1\n");
  write(dir, "src/etl/orders.sql", "select 1\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-q", "-m", "rules"]);
  sh(dir, ["push", "-q", "origin", "main"]);
  sh(dir, ["fetch", "-q", "origin"]);
  return dir;
}

describe("aihub guidelines show: the rules for the files you are about to change", () => {
  it("nested AGENTS.md first, the higher ones add, CLAUDE.md, copilot instructions, applyTo globs and team.yaml files; de-duplicated with the source", () => {
    const dir = world();
    const r = collectGuidelines(dir, ["src/etl/orders.py"]);
    expect(r.sources.map((s) => s.path)).toEqual([
      "src/etl/AGENTS.md",
      "AGENTS.md",
      "CLAUDE.md",
      ".github/copilot-instructions.md",
      ".github/instructions/python.instructions.md",
      "docs/team-guide.md",
    ]);
    const texts = r.rules.map((x) => x.text);
    expect(texts).toEqual([
      "Use snake_case for column names.",
      "Never log secrets.",
      "Write docstrings in English.",
      "Keep functions under 40 lines.",
      "Prefer small pull requests.",
      "Type hints on public functions.",
      "Name tests test_<what>.",
    ]);
    // the duplicate keeps the nearest source; code blocks are no rules
    expect(r.rules.find((x) => x.text === "Never log secrets.")?.source).toBe("src/etl/AGENTS.md:4");
    expect(texts).not.toContain("not a rule (code)");
    expect(texts).not.toContain("Uppercase SQL keywords.");
  });

  it("the SQL file gets the SQL instructions and not the Python ones; a root file gets only the root AGENTS.md", () => {
    const dir = world();
    const sql = collectGuidelines(dir, ["src/etl/orders.sql"]).rules.map((x) => x.text);
    expect(sql).toContain("Uppercase SQL keywords.");
    expect(sql).not.toContain("Type hints on public functions.");
    const top = collectGuidelines(dir, ["README.md"]).sources.map((s) => s.path);
    expect(top).not.toContain("src/etl/AGENTS.md");
    expect(top[0]).toBe("AGENTS.md");
  });

  it("the command: compact text with the source per rule, and --json", async () => {
    const dir = world();
    const { ctx, lines } = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(["guidelines", "show", "--paths", "src/etl/orders.py,src/etl/orders.sql"], ctx, commands)).toBe(0);
    const out = lines.join("\n");
    expect(out).toMatch(/^Guidelines for 2 file\(s\); on a conflict the nearest AGENTS.md wins\./);
    expect(out).toContain("[src/etl/AGENTS.md]");
    expect(out).toContain("- Use snake_case for column names. (3)");
    expect(out).toContain("[.github/instructions/sql.instructions.md] (for src/etl/orders.sql)");
    expect(out.length).toBeLessThan(1200);
    lines.length = 0;
    expect(await main(["guidelines", "show", "--paths", "src/etl/orders.py", "--json"], ctx, commands)).toBe(0);
    const j = JSON.parse(lines[0]);
    expect(j.paths).toEqual(["src/etl/orders.py"]);
    expect(j.rules[0]).toEqual({ text: "Use snake_case for column names.", source: "src/etl/AGENTS.md:3" });
  });

  it("small parts: applyTo, list items and plain lines, the settings in both forms", () => {
    expect(applyToOf('---\napplyTo: "**/*.py, **/*.ipynb"\n---\n')).toEqual(["**/*.py", "**/*.ipynb"]);
    expect(applyToOf("- no front matter")).toEqual([]);
    expect(rulesOf("# t\n\n* one\n2) two\nplain\n", "x.md").map((r) => r.text)).toEqual(["one", "two"]);
    expect(rulesOf("# t\nonly prose here\n", "x.md")).toEqual([{ text: "only prose here", source: "x.md:2" }]);
    expect(guidelinesSettings({ guidelines: ["a.md"] } as never)).toEqual({ files: ["a.md"], linters: [] });
    const s = guidelinesSettings({ guidelines: { files: ["a.md"], linters: ["ruff", { name: "stub", command: "node s.js {files}", files: ["**/*.txt"] }] } } as never);
    expect(s.linters.map((l) => l.name)).toEqual(["ruff", "stub"]);
    expect(s.linters[0].files).toEqual(["**/*.py"]);
    expect(() => guidelinesSettings({ guidelines: { linters: ["eslintish"] } } as never)).toThrow(/not a known linter/);
  });
});

describe("aihub guidelines check: the changed lines of the branch, the team's linters, exit 1 on a violation", () => {
  /** a linter stub: every line with TODO is a finding "file:line: TODO left" */
  function withStub(dir: string) {
    const stub = join(tmp("aihub-lint-"), "stub.js");
    writeFileSync(
      stub,
      "const fs=require('fs');for(const f of process.argv.slice(2)){fs.readFileSync(f,'utf8').split(/\\r?\\n/).forEach((l,i)=>{if(l.includes('TODO'))console.log(f+':'+(i+1)+': TODO left')})}",
    );
    write(
      dir,
      ".agents/skills/_shared/references/team.yaml",
      `guidelines:\n  files:\n    - docs/team-guide.md\n  linters:\n    - name: todo-stub\n      command: node "${stub.replace(/\\/g, "/")}" {files}\n      files: ["**/*.py"]\n    - name: missing-linter\n      command: definitely-not-a-linter-xyz {files}\n      files: ["**/*.py"]\n`,
    );
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-q", "-m", "team linters"]);
    sh(dir, ["push", "-q", "origin", "main"]);
    sh(dir, ["fetch", "-q", "origin"]);
  }

  it("only findings on changed lines (an old TODO is not the agent's), new untracked files count; the rules for the changed files come along", async () => {
    const dir = world();
    write(dir, "src/etl/orders.py", "def export():\n    # TODO old\n    return 1\n");
    sh(dir, ["commit", "-qam", "old todo"]);
    sh(dir, ["push", "-q", "origin", "main"]);
    withStub(dir);
    sh(dir, ["switch", "-q", "-c", "feature/4711-orderexport"]);
    write(dir, "src/etl/orders.py", "def export():\n    # TODO old\n    return 2  # TODO new\n");
    write(dir, "src/etl/new_step.py", "x = 1\n# TODO also new\n");
    const { ctx, lines, errs } = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(["guidelines", "check"], ctx, commands)).toBe(1);
    const out = lines.join("\n");
    expect(out).toContain("2 changed file(s) against main");
    expect(out).toContain("- todo-stub: src/etl/orders.py:3: TODO left");
    expect(out).toContain("- todo-stub: src/etl/new_step.py:2: TODO left");
    expect(out).not.toContain("orders.py:2");
    expect(out).toMatch(/skipped missing-linter/);
    expect(out).toContain("Check the changed lines against these rules yourself:");
    expect(out).toContain("Use snake_case for column names. (src/etl/AGENTS.md:3)");
    expect(errs.join("\n")).toContain("guideline violations on the changed lines");
  });

  it("clean changes: exit 0; --json carries the files, findings and rules", async () => {
    const dir = world();
    withStub(dir);
    sh(dir, ["switch", "-q", "-c", "feature/4712-orderexport"]);
    write(dir, "src/etl/orders.py", "def export():\n    return 3\n");
    const { ctx, lines } = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(["guidelines", "check"], ctx, commands)).toBe(0);
    expect(lines.join("\n")).toContain("No linter violations on the changed lines.");
    lines.length = 0;
    expect(await main(["guidelines", "check", "--base", "main", "--json"], ctx, commands)).toBe(0);
    const j = JSON.parse(lines[0]);
    expect(j).toMatchObject({ base: "main", baseReason: "given with --base", files: ["src/etl/orders.py"], findings: [] });
    expect(j.rules.length).toBeGreaterThan(0);
  });

  it("linter output: ruff concise and sqlfluff, paths made repository-relative; added lines from a diff", () => {
    const root = "C:/repo";
    expect(parseLinterOutput("ruff", "src/a.py:3:5: F401 [*] `os` imported but unused\nFound 1 error.", root)).toEqual([{ source: "ruff", file: "src/a.py", line: 3, message: "F401 [*] `os` imported but unused" }]);
    expect(parseLinterOutput("sqlfluff", "== [models/b.sql] FAIL\nL:   2 | P:   1 | LT01 | Expected only single space.\nAll Finished!", root)).toEqual([
      { source: "sqlfluff", file: "models/b.sql", line: 2, message: "LT01 Expected only single space." },
    ]);
    const lines = addedLines("diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -2,0 +3,2 @@\n+a\n+b\n@@ -9 +11 @@\n-c\n+d\n");
    expect([...lines.get("x.py")!]).toEqual([3, 4, 11]);
  });
});
