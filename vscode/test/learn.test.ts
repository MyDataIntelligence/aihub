import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lessonBody, lessonLabel, lessonPage, tourSteps, type Lesson } from "../src/learnModel";
import { here } from "./helpers";

const LESSON: Lesson = {
  meta: { id: "abc-pr-137", title: "Betaalkosten met minimum", savedAt: "2026-11-18T21:00:00Z", repo: "test-project", source: { pr: 137, branch: "feature/91-x" }, concepts: 1, quiz: 1 },
  explanation: {
    oneSentence: "Betaalkosten krijgen een minimum <en> maximum.",
    before: "Alleen rate en fixed.",
    after: "Minimum en cap daarna.",
    diagram: { before: "flowchart LR\n  A[bedrag] --> B[kosten]", after: "flowchart LR\n  A[bedrag] --> B[kosten] --> C[min]:::changed --> D[cap]:::changed" },
    diagrams: [{ title: "Wie gebruikt dit", kind: "architecture", mermaid: "flowchart TD\n  api --> calc" }],
    designChoices: [{ choice: "Cap wint", alternatives: [{ option: "Min wint", whyNot: "kosten boven cap" }] }],
    tellAColleague: ["Nieuwe functie.", "Cap wint."],
    risks: ["Geen caller gevonden."],
    quiz: [{ question: "Wie wint?", options: ["min", "cap"], answerIndex: 1, explanation: "Cap." }],
    concepts: [{ name: "Guard", eli5: "Eerst de rare gevallen.", exampleFromThisChange: "if cap" }],
    hunkReasons: [
      { path: "/orders/payment_costs.py", line: 21, reason: "minimum toepassen", how: "max(cost, min)", findings: [{ severity: "minor", text: "min > cap?" }] },
      { path: "tests/test_payment_costs.py", line: 0, reason: "tests", watchOut: "float", askYourself: { question: "Wat bij 0?", answer: "0" } },
    ],
  },
  facts: { impact: { callers: [{ symbol: "calculate_payment_cost", file: "app/api.py", line: 7 }], tests: [{ file: "tests/test_payment_costs.py" }] } },
};

describe("lesson page", () => {
  const body = lessonBody(LESSON);

  it("puts the pictures first: before and after as Mermaid sources, then the extra diagrams", () => {
    expect(body.indexOf("<h2>Before</h2>")).toBeLessThan(body.indexOf("What changed, and why"));
    expect(body.match(/class="mermaid"/g)).toHaveLength(3);
    expect(body).toContain("flowchart LR");
    expect(body).toContain("--&gt; C[min]:::changed");
    expect(body).toContain("Wie gebruikt dit (architecture)");
  });

  it("escapes text from the lesson", () => {
    expect(body).toContain("&lt;en&gt;");
    expect(body).not.toContain("<en>");
  });

  it("links changed pieces and callers to files, and has the tour, quiz and concept buttons", () => {
    expect(body).toContain('data-open="orders/payment_costs.py" data-line="21"');
    expect(body).toContain('data-open="app/api.py" data-line="7"');
    expect(body).toContain('data-tour="1"');
    expect(body).toContain('class="opt" data-q="0" data-o="1"');
    expect(body).toContain('data-answer="1"');
    expect(body).toContain('data-learned="Guard"');
    expect(body).toContain("minor: min &gt; cap?");
  });

  it("is one page with a strict CSP, the bundled Mermaid and no remote script", () => {
    const page = lessonPage(LESSON, "N0NCE", "vscode-resource:", "vscode-resource:/mermaid.min.js");
    expect(page).toContain("script-src vscode-resource: 'nonce-N0NCE'");
    expect(page).toContain("default-src 'none'");
    expect(page).toContain("style-src vscode-resource: 'unsafe-inline'");
    expect(page).toContain('<script src="vscode-resource:/mermaid.min.js">');
    expect(page).not.toMatch(/https?:\/\/[^"' ]*\.js/);
    expect(page).toContain("securityLevel: 'strict'");
  });
});

describe("tour", () => {
  it("has one step per changed piece, repo-relative, with line 1 when no line is given", () => {
    const steps = tourSteps(LESSON);
    expect(steps.map((s) => `${s.path}:${s.line}`)).toEqual(["orders/payment_costs.py:21", "tests/test_payment_costs.py:1"]);
    expect(steps[0].detail).toContain("How: max(cost, min)");
    expect(steps[1].detail).toContain("Ask yourself: Wat bij 0?");
  });

  it("labels a lesson by its PR, else its branch", () => {
    expect(lessonLabel(LESSON.meta)).toBe("PR !137");
    expect(lessonLabel({ ...LESSON.meta, source: { branch: "feature/x" } })).toBe("feature/x");
  });
});

describe("package.json learn contributions", () => {
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
  const c = pkg.contributes;
  it("has the Learn view in the Explorer, its commands and the item menus", () => {
    expect(c.views.explorer.map((v: { id: string }) => v.id)).toContain("aihub.learn");
    const declared = new Set<string>(c.commands.map((x: { command: string }) => x.command));
    for (const id of ["open", "tour", "refresh", "forget", "markConcept"]) expect(declared.has(`aihub.learn.${id}`)).toBe(true);
    const items = c.menus["view/item/context"].filter((m: { when: string }) => m.when.includes("aihub.learn")).map((m: { command: string }) => m.command);
    expect(items).toEqual(expect.arrayContaining(["aihub.learn.tour", "aihub.learn.forget", "aihub.learn.markConcept"]));
  });
});

describe("Play story", () => {
  it("shows Play story and Open in iDiagram links when the diagram has them, and only iDiagram links open outside", async () => {
    const l = JSON.parse(JSON.stringify(LESSON));
    l.explanation.diagrams = [{ title: "Flow", kind: "flow", mermaid: "flowchart LR\n A-->B", idiagramUrl: "https://idiagram.vercel.app/#board=x", playUrl: "https://idiagram.vercel.app/#board=x&play=1" }];
    const body = lessonBody(l);
    expect(body).toContain('data-ext="https://idiagram.vercel.app/#board=x&amp;play=1">Play story</a>');
    expect(body).toContain("Open in iDiagram");
    expect(lessonBody(LESSON)).not.toContain("Play story");
    const src = readFileSync(join(here, "..", "src", "learnUi.ts"), "utf8");
    expect(src).toContain("isIDiagramLink(m.url)");
  });
});
