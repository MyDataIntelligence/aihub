import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { closestKey, explainOf, parseSchema, teamSchema } from "../src/lib/teamSchema.js";
import { validateTeamText } from "../src/lib/teamValidate.js";
import { display, flatten, teamShow } from "../src/lib/teamSettings.js";
import { parseTeamRepo, setTeamRepo, teamRepoFor, writeCopy } from "../src/lib/teamSource.js";
import { fillTitle } from "../src/lib/teamPreview.js";
import { loadTeam, TEAM_FILE } from "../src/lib/team.js";
import type { Ctx } from "../src/lib/context.js";

const TEAM = `version: 1
language: nl
teamName: Synthetic Team
azureDevOps:
  organization: ferron-test
  project: test-project
repositories:
  - name: repo-a
    defaultTarget: main
    releaseBranches: ["release/*"]
  - name: repo-b
    defaultTarget: staging
pullRequest:
  template: .azuredevops/pull_request_template.md
  title: "{storyId}: {storyTitle}"
  emptySection: "n.v.t."
workItems:
  storyType: User Story
  states:
    active: Active
    finished: Done
branches:
  feature: "feature/{storyId}-{slug}"
  protected: [main, "release/*"]
cherryPick:
  groups:
    supported: ["release/1.2", "release/1.3"]
pipelines:
  - repository: repo-a
    name: repo-a-ci
    required: true
robot:
  pipeline: orders-robot
  targets:
    feature:
      branch: "feature/*"
      mergeMyBranchFirst: true
`;

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe" }).toString();

function repo(dir: string, team?: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "feature/4711-x");
  git(dir, "config", "user.email", "t@example.invalid");
  git(dir, "config", "user.name", "t");
  if (team) {
    mkdirSync(join(dir, ".agents/skills/_shared/references"), { recursive: true });
    writeFileSync(join(dir, TEAM_FILE), team);
  }
  writeFileSync(join(dir, "a.txt"), "a");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "first");
}

const ctxAt = (cwd: string, env: NodeJS.ProcessEnv): Ctx => ({ cwd, env, fetch: (async () => { throw new Error("no network in tests"); }) as never, out: () => {}, err: () => {} });

describe("team schema", () => {
  it("reads explanations, required keys, lists and placeholders", () => {
    const s = teamSchema();
    expect(explainOf(s, "branches.feature")).toMatch(/pattern for feature branches/i);
    expect(explainOf(s, "repositories[0].defaultTarget")).toMatch(/branch a new PR targets/i);
    expect(explainOf(s, "robot.targets.feature.mergeMyBranchFirst")).toMatch(/^True: merge my current branch/);
    const top = s.children.map((c) => c.key);
    expect(top).toContain("teamName");
    expect(s.children.find((c) => c.key === "repositories")?.kind).toBe("objectList");
    expect(s.children.find((c) => c.key === "branches")!.children.find((c) => c.key === "protected")?.kind).toBe("list");
    expect(s.children.filter((c) => c.key === "pullRequest")).toHaveLength(1); // the second block is merged
    expect(s.children.find((c) => c.key === "pullRequest")!.children.map((c) => c.key)).toContain("afterCreate");
  });

  it("parses a small schema", () => {
    const s = parseSchema("a: 1   # integer, one (required)\nb:   # group (optional)\n  c: true  # flag (optional)\n  <name>: []  # any (optional)\n");
    expect(s.children.map((c) => [c.key, c.kind, c.required])).toEqual([
      ["a", "integer", true],
      ["b", "object", false],
    ]);
    expect(s.children[1].children.map((c) => [c.path, c.kind])).toEqual([
      ["b.c", "boolean"],
      ["b.*", "list"],
    ]);
  });

  it("finds the closest key for a typo only", () => {
    expect(closestKey("branchs", ["version", "branches", "robot"])).toBe("branches");
    expect(closestKey("zzzz", ["version", "branches"])).toBeUndefined();
  });
});

describe("team validate", () => {
  it("accepts the team pack and the synthetic file", () => {
    expect(validateTeamText(TEAM).errors).toBe(0);
  });

  it("reports an unknown key with a rename fix, a wrong boolean with a fix, and a missing template as a warning", () => {
    const text = TEAM.replace("branches:\n", "branchs:\n").replace("mergeMyBranchFirst: true", "mergeMyBranchFirst: ja");
    const r = validateTeamText(text.replace("  storyType: User Story\n", "  storyType: User Story\n  templates:\n    Bug: .agents/skills/_shared/assets/bug-template.md\n"), {
      fileExists: (p) => !p.includes("bug-template"),
      packHas: () => true,
    });
    expect(r.ok).toBe(false);
    expect(r.errors).toBe(2);
    const unknown = r.problems.find((p) => p.code === "unknownKey")!;
    expect(unknown.message).toBe('Unknown key "branchs". Did you mean "branches"?');
    expect(unknown.line).toBe(text.split("\n").indexOf("branchs:") + 3);
    expect(unknown.fix?.replace).toMatchObject({ from: "branchs:", to: "branches:" });
    const bool = r.problems.find((p) => p.code === "type")!;
    expect(bool.message).toBe('mergeMyBranchFirst must be true or false, found "ja"');
    expect(bool.fix?.label).toBe("Use true");
    const warn = r.problems.find((p) => p.code === "missingFile")!;
    expect(warn.severity).toBe("warning");
    expect(warn.fix?.createFromPack).toContain("bug-template.md");
  });

  it("reports YAML syntax errors with a line", () => {
    const r = validateTeamText("version: 1\nbranches:\n  feature: [a\n");
    expect(r.ok).toBe(false);
    expect(r.problems[0].code).toBe("yaml");
    expect(r.problems[0].line).toBeGreaterThan(1);
  });
});

describe("team show", () => {
  it("formats values like the page", () => {
    expect(display(["main", "release/*"])).toBe("[main, release/*]");
    expect(display({ supported: ["a", "b"] })).toBe("supported (2)");
    expect(display({ active: "Active", finished: "Done" })).toBe("Active, Done");
    expect(display([{ repository: "r", name: "r-ci", required: true }], "pipelines")).toBe("r-ci, required");
  });

  it("flattens per repository with the repository's own values marked", async () => {
    const rows = flatten((await import("yaml")).parse(TEAM), teamSchema(), "repo-a");
    const by = (k: string) => rows.find((r) => r.key === k);
    expect(by("defaultTarget")).toMatchObject({ display: "main", repo: "repo-a", group: "branches" });
    expect(by("pipelines")).toMatchObject({ display: "repo-a-ci, required", repo: "repo-a", group: "pullRequests" });
    expect(by("cherryPick.groups")?.display).toBe("supported (2)");
    expect(by("workItems.states")?.display).toBe("Active, Done");
    expect(by("robot.targets.feature")?.display).toBe("feature/*, mergeMyBranchFirst");
    expect(by("pullRequest.template")).toBeUndefined(); // in the Templates card
    expect(rows.findIndex((r) => r.key === "branches.feature")).toBeLessThan(rows.findIndex((r) => r.key === "defaultTarget"));
  });

  it("reads a set: team repository copy, own files, overrides, templates, where it looked", async () => {
    const base = mkdtempSync(join(tmpdir(), "aihub-teamshow-"));
    const env = { AIHUB_CONFIG_HOME: join(base, "cfg") } as NodeJS.ProcessEnv;
    const set = join(base, "set");
    repo(join(set, "repo-a"), TEAM);
    repo(join(set, "repo-b"), TEAM);
    repo(join(set, "repo-c"));
    writeFileSync(
      join(set, ".aihub-set.json"),
      JSON.stringify({ story: 4711, branch: "feature/4711-x", storyTitle: "Orderexport", repos: ["repo-a", "repo-b", "repo-c"].map((n) => ({ name: n, source: join(set, n), path: join(set, n) })) }),
    );
    const ctx = ctxAt(join(set, "repo-a"), env);

    const none = await teamShow(ctx, {});
    expect(none.source.kind).toBe("repo");
    expect(none.looked[1].note).toBe("no team repository is set for #4711");
    expect(none.views["repo-c"]).toEqual([]);

    setTeamRepo(env, { project: "orders", repo: "team-config" }, set);
    const read = async () => ({ content: TEAM, commit: "a41f90c0000000000000000000000000000000ff", date: "2026-11-25T10:00:00Z", branch: "main", path: TEAM_FILE, readAt: "2026-11-27T14:21:00Z", files: { ".azuredevops/pull_request_template.md": true, ".agents/skills/_shared/assets/story-template.md": true } });
    const page = await teamShow(ctx, { read, repo: "repo-a" });
    expect(page.scope).toMatchObject({ kind: "set", story: 4711, current: "repo-a", title: "Orderexport" });
    expect(page.source).toMatchObject({ kind: "teamRepo", team: "Synthetic Team", label: "team-config", branch: "main", short: "a41f90c", schema: 1 });
    expect(page.repos.map((r) => [r.name, r.uses, r.teamFile.sameAsSource])).toEqual([
      ["repo-a", "own", true],
      ["repo-b", "own", true],
      ["repo-c", "teamRepo", undefined],
    ]);
    expect(page.overrides.map((o) => o.key)).toEqual(expect.arrayContaining(["defaultTarget", "releaseBranches", "pipelines"]));
    expect(page.overrides.find((o) => o.key === "defaultTarget")!.values).toEqual([
      { repo: "repo-a", display: "main" },
      { repo: "repo-b", display: "staging" },
      { repo: "repo-c", display: "–" },
    ]);
    expect(page.views["*"].find((r) => r.key === "defaultTarget")?.display).toBe("per repository");
    expect(page.templates.map((t) => [t.kind, t.exists])).toEqual([
      ["pr", true],
      ["story", true],
      ["bug", undefined],
      ["commit", undefined],
    ]);
    expect(page.groups.find((g) => g.id === "tests")?.title).toBe("Tests: Robot");

    // the copy is used without a read for 10 minutes; a repository without its own file loads it too
    const again = await teamShow(ctx, { read: async () => { throw new Error("must not read"); } });
    expect(again.source.short).toBe("a41f90c");
    const prev = process.env.AIHUB_CONFIG_HOME;
    process.env.AIHUB_CONFIG_HOME = env.AIHUB_CONFIG_HOME;
    try {
      expect(loadTeam(join(set, "repo-c")).repositories?.[1]?.defaultTarget).toBe("staging");
    } finally {
      if (prev === undefined) delete process.env.AIHUB_CONFIG_HOME;
      else process.env.AIHUB_CONFIG_HOME = prev;
    }
  });
});

describe("team source", () => {
  it("parses a team repository and stores it per set or for everything", () => {
    expect(parseTeamRepo("orders/team-config", () => false)).toEqual({ project: "orders", repo: "team-config" });
    expect(parseTeamRepo("org/orders/team-config", () => false)).toEqual({ org: "org", project: "orders", repo: "team-config" });
    expect(parseTeamRepo("orders/team-config@bench-abc123-teamcfg", () => false)).toEqual({ project: "orders", repo: "team-config", branch: "bench-abc123-teamcfg" });
    expect(() => parseTeamRepo("x", () => false)).toThrow(/not a team repository/);
    const env = { AIHUB_CONFIG_HOME: mkdtempSync(join(tmpdir(), "aihub-src-")) } as NodeJS.ProcessEnv;
    expect(teamRepoFor(env, "/a")).toBeUndefined();
    setTeamRepo(env, { project: "p", repo: "everywhere" });
    setTeamRepo(env, { project: "p", repo: "only-a" }, "/a");
    expect(teamRepoFor(env, "/a")?.repo).toBe("only-a");
    expect(teamRepoFor(env, "/b")?.repo).toBe("everywhere");
    writeCopy(env, { project: "p", repo: "only-a" }, { content: "x", commit: "c", branch: "main", path: TEAM_FILE, readAt: "" });
  });
});

describe("team preview", () => {
  it("fills the title pattern", () => {
    expect(fillTitle("{storyId}: {storyTitle}", { storyId: 4711, storyTitle: "Orderexport", branch: "b" })).toBe("4711: Orderexport");
    expect(fillTitle("{storyId}: {storyTitle}", { storyTitle: "X", branch: "b" })).toBe("X");
  });
});
