import { describe, expect, it } from "vitest";
import { commands, main } from "../src/router.js";
import { changesText } from "../src/lib/pr.js";
import { compose, fallbackKindOf } from "../src/lib/templates.js";
import { ctxFor, fakeFetch, makeRepo, sh, write } from "./helpers.js";

const EN = "## Summary\n<what and why>\n\n## Changes\n- <change 1>\n\n## Tests\n| Test | Result |\n|---|---|\n| <test> | <result> |\n\nNot run: <what>\n\n## Related\nStory: <link>\n";

describe("fallbackKindOf", () => {
  it("recognises Changes and Tests headings in English and Dutch", () => {
    expect(fallbackKindOf("Changes")).toBe("changes");
    expect(fallbackKindOf("Wijzigingen")).toBe("changes");
    expect(fallbackKindOf("Tests")).toBe("tests");
    expect(fallbackKindOf("Functionele tests")).toBeUndefined();
    expect(fallbackKindOf("Testen")).toBe("tests");
    expect(fallbackKindOf("Changes (optional)")).toBe("changes");
    expect(fallbackKindOf("Summary")).toBeUndefined();
  });
});

describe("compose fallback for Changes and Tests", () => {
  const fallback = { changes: "- feat: a (abc1234)\n\n2 files changed, +10 -1", tests: "Not run yet." };

  it("fills an empty Changes section from the commits and an empty Tests section with the honest not-run line", () => {
    const c = compose({ template: EN, body: "## Summary\nWhy.\n", code: { story: "AB#7" }, emptyText: "-", fallback });
    expect(c.text).toContain("## Changes\n\n- feat: a (abc1234)\n\n2 files changed, +10 -1");
    expect(c.text).toContain("## Tests\n\nNot run yet.");
    expect(c.text).toContain("## Related\n\nAB#7");
    expect(c.filled.filter((f) => f.by === "code").map((f) => f.heading)).toEqual(["Changes", "Tests", "Related"]);
  });

  it("never overrides what the agent wrote", () => {
    const body = "## Summary\nWhy.\n\n## Changes\n- own change\n\n## Tests\n| Test | Result |\n|---|---|\n| vitest | pass |\n";
    const c = compose({ template: EN, body, code: {}, emptyText: "-", fallback });
    expect(c.text).toContain("- own change");
    expect(c.text).not.toContain("feat: a (abc1234)");
    expect(c.text).toContain("| vitest | pass |");
    expect(c.text).not.toContain("Not run yet.");
  });

  it("other empty sections still get the team's empty text", () => {
    const c = compose({ template: "## Summary\n\n## Screenshots\n", body: "", code: {}, emptyText: "n.v.t.", fallback });
    expect(c.text).toContain("## Screenshots\n\nn.v.t.");
  });
});

describe("changesText", () => {
  it("lists the commits and the size of the diff; nothing without commits", () => {
    expect(changesText([{ sha: "abc", subject: "feat: a" }, { sha: "def", subject: "fix: b" }], "3 files changed, +5 -2")).toBe("- feat: a (abc)\n- fix: b (def)\n\n3 files changed, +5 -2");
    expect(changesText([], "x")).toBeUndefined();
  });
});

describe("aihub pr create without Changes/Tests in the body", () => {
  function repoWith(template: string, language: "nl" | "en") {
    const { dir } = makeRepo();
    write(dir, ".azuredevops/pull_request_template.md", template);
    write(dir, ".agents/skills/_shared/references/team.yaml", `language: ${language}\nrepositories:\n  - name: test-repo\n    defaultTarget: main\n`);
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "chore: templates"]);
    sh(dir, ["push", "origin", "main"]);
    sh(dir, ["checkout", "-b", "feature/9-x"]);
    write(dir, "a.py", "print(1)\nprint(2)\n");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "feat: eerste wijziging"]);
    write(dir, "b.py", "print(3)\n");
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "fix: tweede wijziging"]);
    return dir;
  }
  const routes = [
    { match: /_apis\/wit\/workitems\/9\?/, respond: () => ({ body: { fields: { "System.Title": "Story negen" } } }) },
    { match: /pullrequests\?.*searchCriteria/, respond: () => ({ body: { value: [] } }) },
  ];

  async function dry(dir: string) {
    const { ctx, lines } = ctxFor(dir, fakeFetch(routes).fn);
    const code = await main(["pr", "create", "--dry-run"], ctx, commands);
    return { code, text: lines.join("\n") };
  }

  it("English team: Changes from the commits and the diff size, Tests 'Not run yet.'", async () => {
    const r = await dry(repoWith(EN, "en"));
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/## Changes\n\n- feat: eerste wijziging \(\w+\)\n- fix: tweede wijziging \(\w+\)\n\n2 files changed, \+3 -0/);
    expect(r.text).toContain("## Tests\n\nNot run yet.");
  });

  it("Dutch team: the not-run line is Dutch", async () => {
    const r = await dry(repoWith("## Beschrijving\n\n## Wijzigingen\n\n## Tests\n", "nl"));
    expect(r.text).toContain("## Wijzigingen\n\n- feat: eerste wijziging");
    expect(r.text).toContain("## Tests\n\nNog niet uitgevoerd.");
  });
});
