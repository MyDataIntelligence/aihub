import { describe, expect, it } from "vitest";
import {
  codeKindOf,
  compose,
  editSection,
  mergeSections,
  parseSections,
  resolveTemplate,
  templateCandidates,
} from "../src/lib/templates.js";
import { makeRepo, sh, write } from "./helpers.js";
import { showFile } from "../src/lib/git.js";

const NL_TEMPLATE = `<!-- Vul alle onderdelen in -->
## Beschrijving
<!-- Wat en waarom -->

## Story
<!-- link -->

## Wijzigingen (optioneel)

## Tests
<!-- hoe getest -->

## Commits

## Screenshots (optioneel)
`;

const EN_TEMPLATE = `## Summary

## Work item

## Testing

## Related pull requests
`;

describe("template resolution", () => {
  it("orders candidates like Azure DevOps: branch-specific first, then default", () => {
    const c = templateCandidates("main");
    expect(c[0]).toBe(".azuredevops/pull_request_template/branches/main.md");
    expect(c[3]).toBe("pull_request_template/branches/main.md");
    expect(c[4]).toBe(".azuredevops/pull_request_template.md");
    expect(c[7]).toBe("pull_request_template.md");
  });

  it("reads origin/<target> before the working tree, branch template before default", () => {
    const { dir } = makeRepo();
    write(dir, ".azuredevops/pull_request_template.md", "## Default\n");
    write(dir, ".azuredevops/pull_request_template/branches/main.md", "## Branch template\n");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "templates"]);
    sh(dir, ["push", "origin", "main"]);
    // local edit that must NOT win over origin/main
    write(dir, ".azuredevops/pull_request_template/branches/main.md", "## Local edit\n");
    const t = resolveTemplate("main", { readRef: (b, p) => showFile(dir, b, p), localRoot: dir });
    expect(t?.from).toBe("ref");
    expect(t?.content).toContain("Branch template");
  });

  it("falls back to the working tree and to other directories", () => {
    const { dir } = makeRepo();
    write(dir, "docs/pull_request_template.md", "## Docs template\n");
    const t = resolveTemplate("develop", { readRef: (b, p) => showFile(dir, b, p), localRoot: dir });
    expect(t).toMatchObject({ from: "local", path: "docs/pull_request_template.md" });
    expect(resolveTemplate("develop", { localRoot: "/nonexistent-aihub" })).toBeUndefined();
  });
});

describe("parseSections", () => {
  it("splits on ## headings and ignores fenced code", () => {
    const p = parseSections("intro\n## A\ntext\n```\n## not a heading\n```\n### sub\n## B\n");
    expect(p.preamble).toBe("intro");
    expect(p.sections.map((s) => s.heading)).toEqual(["A", "B"]);
    expect(p.sections[0].body).toContain("## not a heading");
    expect(p.sections[0].body).toContain("### sub");
  });
});

describe("compose", () => {
  it("fills a Dutch template in template order (golden)", () => {
    const body = [
      "## tests",
      "Unit-tests groen; handmatig geprobeerd met ë, é en ü.",
      "",
      "## beschrijving",
      "Voegt de zoekfunctie toe.",
      "",
      "## Wijzigingen",
      "- nieuwe module",
    ].join("\n");
    const r = compose({
      template: NL_TEMPLATE,
      body,
      code: { story: "AB#1234", commits: "- feat: zoek (abc1234)\n- test: zoek (def5678)" },
    });
    expect(r.text).toBe(
      [
        "## Beschrijving",
        "",
        "Voegt de zoekfunctie toe.",
        "",
        "## Story",
        "",
        "AB#1234",
        "",
        "## Wijzigingen (optioneel)",
        "",
        "- nieuwe module",
        "",
        "## Tests",
        "",
        "Unit-tests groen; handmatig geprobeerd met ë, é en ü.",
        "",
        "## Commits",
        "",
        "- feat: zoek (abc1234)",
        "- test: zoek (def5678)",
        "",
        "## Screenshots (optioneel)",
        "",
        "n.v.t.",
        "",
      ].join("\n"),
    );
    expect(r.filled.map((f) => f.by)).toEqual(["body", "code", "body", "body", "code", "empty"]);
  });

  it("fills an English template, custom empty text, linked PRs by code", () => {
    const r = compose({
      template: EN_TEMPLATE,
      body: "## Summary\nAdds search.\n",
      code: { story: "AB#7", linked: "- !12" },
      emptyText: "Not applicable",
    });
    expect(r.text).toBe(
      "## Summary\n\nAdds search.\n\n## Work item\n\nAB#7\n\n## Testing\n\nNot applicable\n\n## Related pull requests\n\n- !12\n",
    );
  });

  it("matches headings leniently (case, diacritics, optional suffix, containment)", () => {
    const r = compose({
      template: "## Wijzigingen (optioneel)\n\n## Beschrijving van de wijziging\n",
      body: "## WIJZIGINGEN\nA\n\n## Beschrijving\nB\n",
      code: {},
    });
    expect(r.text).toBe("## Wijzigingen (optioneel)\n\nA\n\n## Beschrijving van de wijziging\n\nB\n");
  });

  it("puts free text without headings in the first non-code section and keeps unknown sections", () => {
    const free = compose({ template: EN_TEMPLATE, body: "Just prose.", code: {} });
    expect(free.text.startsWith("## Summary\n\nJust prose.\n")).toBe(true);
    const extra = compose({ template: EN_TEMPLATE, body: "## Risks\nNone.\n", code: {} });
    expect(extra.text.endsWith("## Risks\n\nNone.\n")).toBe(true);
    expect(extra.filled.at(-1)?.by).toBe("extra");
  });

  it("treats a comment-only body section as empty", () => {
    const r = compose({ template: EN_TEMPLATE, body: "## Summary\n<!-- todo -->\n", code: {} });
    expect(r.filled[0].by).toBe("empty");
  });

  it("stays within the 4000 character limit by shrinking the commit list", () => {
    const commits = Array.from({ length: 200 }, (_, i) => `- commit number ${i} with a long subject line (sha${i})`).join("\n");
    const r = compose({ template: "## Beschrijving\n\n## Commits\n", body: "## Beschrijving\nx", code: { commits } });
    expect(r.text.length).toBeLessThanOrEqual(4000);
    expect(r.text).toContain("## Commits");
  });

  it("classifies code-filled headings", () => {
    expect(codeKindOf("Story")).toBe("story");
    expect(codeKindOf("Gekoppelde story")).toBe("story");
    expect(codeKindOf("Work item")).toBe("story");
    expect(codeKindOf("Gekoppelde stories")).toBe("story");
    expect(codeKindOf("Linked stories")).toBe("story");
    expect(codeKindOf("Work items")).toBe("story");
    expect(codeKindOf("Commits")).toBe("commits");
    expect(codeKindOf("Related pull requests")).toBe("linked");
    expect(codeKindOf("Related")).toBe("story");
    expect(codeKindOf("Gerelateerd")).toBe("story");
    expect(codeKindOf("Gerelateerde PR's")).toBe("linked");
    expect(codeKindOf("Beschrijving van de story en context erbij")).toBeUndefined();
    expect(codeKindOf("Tests")).toBeUndefined();
  });
});

describe("editSection / mergeSections", () => {
  const desc = "## Beschrijving\n\nEerste.\n\n## Tests\n\nn.v.t.\n";
  it("appends to a section and keeps the others", () => {
    const out = editSection(desc, "beschrijving", { append: "Tweede." });
    expect(out).toBe("## Beschrijving\n\nEerste.\n\nTweede.\n\n## Tests\n\nn.v.t.\n");
  });
  it("replaces the n.v.t. placeholder when appending", () => {
    expect(editSection(desc, "Tests", { append: "Alles groen" })).toContain("## Tests\n\nAlles groen\n");
  });
  it("replaces a section and adds a missing one", () => {
    const out = editSection(editSection(desc, "Tests", { replace: "Opnieuw" }), "Risico's", { append: "Geen" });
    expect(out).toBe("## Beschrijving\n\nEerste.\n\n## Tests\n\nOpnieuw\n\n## Risico's\n\nGeen\n");
  });
  it("merges a body file section-wise", () => {
    expect(mergeSections(desc, "## Tests\nNieuw\n")).toBe("## Beschrijving\n\nEerste.\n\n## Tests\n\nNieuw\n");
  });
});

describe("mergeSections keeps the sections the CLI fills", () => {
  it("a body that repeats the template's story placeholder does not replace the real story link (live: /pr-update in opencode)", () => {
    const desc = "## Summary\n\nOld\n\n## Changes\n\n- a\n\n## Related\n\nAB#2787\n";
    const body = "## Changes\n\n- a\n- b\n\n## Related\n\nStory: <work item link>\n";
    const out = mergeSections(desc, body);
    expect(out).toContain("- b");
    expect(out).toContain("AB#2787");
    expect(out).not.toContain("<work item link>");
  });
});

describe("review evidence", () => {
  it("omits empty optional sections and preserves required team sections", () => {
    const template = "## Summary\n## Verification\n## Rollout\n<!-- aihub:optional -->\n## Team";
    const input = { template, code: {}, body: "## Summary\nExport ready\n## Verification\nCSV has three rows" };
    const small = compose(input).text;
    expect(small).toContain("CSV has three rows");
    expect(small).toContain("## Team");
    expect(small).not.toContain("## Rollout");
    expect(compose({ ...input, body: input.body + "\n## Rollout\nDeploy API first" }).text).toContain("Deploy API first");
  });

  it("edits an exact heading before a longer heading containing it", () => {
    const current = "## Tests overview\n\nManual link\n\n## Tests\n\nPending\n";
    expect(editSection(current, "Tests", { replace: "Passed" })).toBe(current.replace("Pending", "Passed"));
  });
});
