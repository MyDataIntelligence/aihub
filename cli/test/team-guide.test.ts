import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { main, type CommandFn } from "../src/router.js";
import { featurePattern } from "../src/lib/team-detect.js";
import { MISSING_SETTING_EXIT, missingSetting, teamSetting } from "../src/lib/team-guide.js";
import { ctxFor, fakeFetch, makeRepo, sh, write, type Route } from "./helpers.js";

/** ctxFor without the Fabric token cache of this machine */
function cx(dir: string, fn: typeof fetch) {
  const c = ctxFor(dir, fn);
  c.ctx.tokenCache = join(c.ctx.env.AIHUB_HOME!, "no-token");
  return c;
}

vi.setConfig({ testTimeout: 30_000 }); // git repositories and the doctor's process checks are slow under a full parallel run

const TEAM = ".agents/skills/_shared/references/team.yaml";

function repo() {
  const r = makeRepo();
  sh(r.dir, ["config", "user.name", "Test"]);
  sh(r.dir, ["config", "user.email", "test@example.com"]);
  sh(r.dir, ["config", "commit.gpgsign", "false"]);
  return r;
}

/** A Basic-process project: Issue with Doing/Done, a blocking policy and a build validation on main. */
const basic = (states = [{ name: "To Do", category: "Proposed" }, { name: "Doing", category: "InProgress" }, { name: "Done", category: "Completed" }]): Route[] => [
  { match: /\/_apis\/wit\/workitemtypes\?/, respond: () => ({ body: { value: [{ name: "Issue" }, { name: "Task" }, { name: "Epic" }] } }) },
  { match: /\/_apis\/wit\/workitemtypes\/Issue\/states\?/, respond: () => ({ body: { value: states } }) },
  { match: /\/_apis\/git\/repositories\/test-repo\?/, respond: () => ({ body: { id: "repo-1" } }) },
  {
    match: /\/_apis\/policy\/configurations\?/,
    respond: () => ({
      body: {
        value: [
          { isEnabled: true, isBlocking: true, type: { displayName: "Minimum number of reviewers" }, settings: { scope: [{ refName: "refs/heads/main", matchKind: "Exact", repositoryId: "repo-1" }] } },
          { isEnabled: true, isBlocking: true, type: { displayName: "Build" }, settings: { displayName: "test-repo-ci", scope: [{ refName: "refs/heads/main", matchKind: "Exact", repositoryId: "repo-1" }] } },
          { isEnabled: true, isBlocking: true, type: { displayName: "Build" }, settings: { displayName: "other-ci", scope: [{ refName: "refs/heads/main", matchKind: "Exact", repositoryId: "repo-2" }] } },
        ],
      },
    }),
  },
];

describe("featurePattern", () => {
  it("reads the pattern most story branches follow, sure only with a clear majority", () => {
    expect(featurePattern(["feature/101-add-export", "feature/102-fix-csv", "feature/103-x", "spike"])).toMatchObject({ value: "feature/{storyId}-{slug}", confidence: "sure" });
    expect(featurePattern(["story/7712_add-export", "feature/12-x"])).toMatchObject({ confidence: "guess", choices: ["feature/{storyId}-{slug}", "story/{storyId}_{slug}"] });
    expect(featurePattern(["bugfix/US-123-login", "bugfix/US-124-logout", "bugfix/US-125-x"])).toMatchObject({ value: "bugfix/US-{storyId}-{slug}" });
    expect(featurePattern(["spike", "main"])).toBeUndefined();
  });
});

describe("aihub team setup", () => {
  it("detects from git and Azure DevOps, writes a commented proposal and asks only the language", async () => {
    const { dir } = repo();
    for (const b of ["feature/101-add-export", "feature/102-fix-csv", "feature/103-tidy", "release/1.0"]) sh(dir, ["push", "origin", `HEAD:refs/heads/${b}`]);
    sh(dir, ["fetch", "origin"]);
    const f = fakeFetch(basic());
    const { ctx, lines } = cx(dir, f.fn);
    expect(await main(["team", "setup"], ctx)).toBe(0);
    const out = lines.join("\n");
    expect(Buffer.byteLength(out)).toBeLessThan(700);
    expect(out).toContain("none, wrote a proposal");
    expect(out).toMatch(/detected: org ferron-org, project test-project, repo test-repo, target main, story type Issue, start state Doing, finish state Done, branch pattern feature\/\{storyId\}-\{slug\}, protected main/);
    expect(out).toContain("1. Language of stories, PR text and comments? en | nl -> aihub team set language en");
    expect(out).toContain("aihub team set repositories[0].releaseBranches release/*");
    expect(out).not.toMatch(/^3\. /m);
    const text = readFileSync(join(dir, TEAM), "utf8");
    expect(text).toMatch(/^# Proposed by 'aihub init'/);
    expect(text).toMatch(/organization: ferron-org\s+# Azure DevOps organization/); // the explanations stay
    const team = parse(text);
    expect(team.workItems).toMatchObject({ storyType: "Issue", states: { active: "Doing", finished: "Done" } });
    expect(team.branches.protected).toEqual(["main"]);
    expect(team.pipelines).toEqual([{ repository: "test-repo", name: "test-repo-ci", required: true }]);

    // answered: the question is gone, the comment of the key stays
    const a = cx(dir, f.fn);
    a.ctx.env = ctx.env;
    expect(await main(["team", "set", "language", "nl"], a.ctx)).toBe(0);
    expect(a.lines[0]).toBe("language: en -> nl (" + TEAM + "; propose it with 'aihub init' or a pull request)");
    expect(readFileSync(join(dir, TEAM), "utf8")).toMatch(/language: nl\s+# language of stories/);
    const calls = f.calls.length;
    const again = cx(dir, f.fn);
    again.ctx.env = ctx.env;
    await main(["team", "setup"], again.ctx);
    expect(again.lines.join("\n")).toContain("exists, kept as is");
    expect(again.lines.join("\n")).not.toContain("Language of stories");
    expect(f.calls.slice(calls).map((c) => c.url)).toEqual([]); // detections come from the cache
  });

  it("asks which state when the process has several, and never touches an existing team.yaml", async () => {
    const { dir } = repo();
    write(dir, TEAM, "version: 1\nlanguage: en\n");
    const { ctx, lines } = cx(dir, fakeFetch(basic([{ name: "Doing", category: "InProgress" }, { name: "Review", category: "InProgress" }, { name: "Done", category: "Completed" }])).fn);
    await main(["team", "setup"], ctx);
    expect(readFileSync(join(dir, TEAM), "utf8")).toBe("version: 1\nlanguage: en\n");
    expect(lines.join("\n")).toContain("State of a story you start? Doing | Review -> aihub team set workItems.states.active Doing");
  });
});

describe("aihub team set / show", () => {
  it("sets nested and list keys, refuses secrets and changes that break the schema", async () => {
    const { dir } = repo();
    const { ctx } = cx(dir, fakeFetch([]).fn);
    await main(["init", "--no-pr", "--language", "en"], ctx);
    const r = cx(dir, fakeFetch([]).fn);
    expect(await main(["team", "set", "branches.protected", "main,release/*"], r.ctx)).toBe(0);
    expect(await main(["team", "set", "workItems.states.active", "In", "Progress"], r.ctx)).toBe(0);
    const team = parse(readFileSync(join(dir, TEAM), "utf8"));
    expect(team.branches.protected).toEqual(["main", "release/*"]);
    expect(team.workItems.states.active).toBe("In Progress");
    expect(await main(["team", "set", "fabric.token", "abc"], r.ctx)).toBe(1);
    expect(r.errs.join("\n")).toContain("secrets never go into team.yaml");
    expect(await main(["team", "set", "azureDevOps", "x"], r.ctx)).toBe(1);
    expect(r.errs.at(-1)).toContain("not set: missing azureDevOps.organization");
  });

  it("show --missing lists only what is open, with its source", async () => {
    const { dir } = repo();
    write(dir, TEAM, "version: 1\n");
    const { ctx, lines } = cx(dir, fakeFetch(basic()).fn);
    await main(["team", "show", "--missing"], ctx);
    expect(lines.some((l) => l.startsWith("language = en  (default)"))).toBe(true);
    expect(lines.some((l) => l.startsWith("azureDevOps.organization"))).toBe(false);
    const all = cx(dir, fakeFetch(basic()).fn);
    await main(["team", "show"], all.ctx);
    expect(all.lines).toContain("azureDevOps.organization = ferron-org  (detected, sure: git remote)");
    expect(all.lines).toContain("workItems.states.active = Doing  (detected, sure: states of Issue)");
  });
});

describe("teamSetting: the shared helper for commands", () => {
  it("uses team.yaml, else a sure detection silently, else asks with the choices (exit code 3)", async () => {
    const { dir } = repo();
    const one = cx(dir, fakeFetch(basic()).fn);
    expect(await teamSetting(one.ctx, dir, "workItems.states.active")).toBe("Doing");
    expect(await teamSetting(one.ctx, dir, "workItems.states.active", { workItems: { states: { active: "Started" } } } as never)).toBe("Started");
    const two = cx(dir, fakeFetch(basic([{ name: "Doing", category: "InProgress" }, { name: "Review", category: "InProgress" }])).fn);
    await expect(teamSetting(two.ctx, dir, "workItems.states.active")).rejects.toThrow('missing team setting workItems.states.active (found: Doing, Review): ask the user, then run: aihub team set workItems.states.active "<value>"');
    const offline = cx(dir, fakeFetch([]).fn);
    expect(await teamSetting(offline.ctx, dir, "workItems.states.active")).toBe("Active"); // nothing detectable: the documented default
  });

  it("the router turns MissingTeamSetting into exit code 3 and one line", async () => {
    const { ctx, errs } = cx(".", fakeFetch([]).fn);
    const reg: Record<string, CommandFn> = { x: async () => { throw missingSetting("fabric.workspaces", ["DEV-a", "DEV-b"]); } };
    expect(await main(["x"], ctx, reg)).toBe(MISSING_SETTING_EXIT);
    expect(errs).toEqual(['aihub: missing team setting fabric.workspaces (found: DEV-a, DEV-b): ask the user, then run: aihub team set fabric.workspaces "<value>"']);
  });
});

describe("aihub init without team.yaml", () => {
  it("is the setup: stops with the questions, then proposes the answered file as part of the pack", async () => {
    const { dir } = repo();
    const f = fakeFetch(basic());
    const { ctx, lines } = cx(dir, f.fn);
    expect(await main(["init", "--no-pr"], ctx)).toBe(0);
    expect(lines.join("\n")).toContain("1. Language of stories");
    expect(lines.at(-1)).toBe("then run 'aihub init' again: it proposes the team pack as a pull request");
    expect(existsSync(join(dir, ".azuredevops/pull_request_template.md"))).toBe(false);
    const s = cx(dir, f.fn);
    s.ctx.env = ctx.env;
    await main(["team", "set", "language", "nl"], s.ctx);
    const again = cx(dir, f.fn);
    again.ctx.env = ctx.env;
    expect(await main(["init", "--no-pr"], again.ctx)).toBe(0);
    expect(again.lines).toContain(`created  ${TEAM}`);
    expect(readFileSync(join(dir, ".agents/skills/_shared/assets/story-template.md"), "utf8")).toContain("Acceptatiecriteria"); // the answered language
    expect(parse(readFileSync(join(dir, TEAM), "utf8")).workItems.states).toEqual({ active: "Doing", finished: "Done" });
  });
});

describe("aihub doctor: team keys and Fabric", () => {
  it("reports a guessed key in the team set form and whether a Fabric token is at hand, without network", async () => {
    const { dir } = repo();
    write(dir, TEAM, "version: 1\nlanguage: en\n");
    const f = fakeFetch(basic([{ name: "Doing", category: "InProgress" }, { name: "Review", category: "InProgress" }, { name: "Done", category: "Completed" }]));
    const { ctx } = cx(dir, f.fn);
    await main(["team", "setup"], ctx); // fills the detection cache
    const d = cx(dir, f.fn);
    d.ctx.env = { ...ctx.env, AIHUB_FABRIC_TOKEN: "synthetic" };
    const calls = f.calls.length;
    await main(["doctor", "--json"], d.ctx);
    const checks = JSON.parse(d.lines[0]).checks as { name: string; status: string; detail: string; fix?: string }[];
    expect(f.calls.length).toBe(calls);
    expect(checks.find((c) => c.name === "team:workItems.states.active")).toMatchObject({ status: "FIX", fix: "ask the user, then: aihub team set workItems.states.active Doing" });
    expect(checks.find((c) => c.name === "fabric")?.detail).toMatch(/^token at hand/);
  });
});

describe("Fabric workspace detection", () => {
  it("only with a token at hand, one call, workspaces named after the repository", async () => {
    const { dir } = repo();
    const routes: Route[] = [
      ...basic(),
      { match: /api\.fabric\.microsoft\.com\/v1\/workspaces/, respond: () => ({ body: { value: [{ displayName: "DEV-test-repo" }, { displayName: "ACC test-repo" }, { displayName: "other" }] } }) },
    ];
    const without = fakeFetch(routes);
    const w = cx(dir, without.fn);
    await main(["team", "show"], w.ctx);
    expect(without.calls.some((c) => c.url.includes("fabric"))).toBe(false);
    const withToken = fakeFetch(routes);
    const t = cx(dir, withToken.fn);
    t.ctx.env.AIHUB_FABRIC_TOKEN = "synthetic";
    await main(["team", "show"], t.ctx);
    expect(withToken.calls.filter((c) => c.url.includes("fabric")).length).toBe(1);
    expect(t.lines).toContain("fabric.workspaces = DEV-test-repo,ACC test-repo  (detected, guess: Fabric workspaces named after the repository)");
  });
});
