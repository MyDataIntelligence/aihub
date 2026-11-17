import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { requiredPaths, validateTeam } from "../src/lib/schema.js";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, sh, write } from "./helpers.js";

const TEAM = ".agents/skills/_shared/references/team.yaml";

function repo() {
  const r = makeRepo();
  sh(r.dir, ["config", "user.name", "Test"]);
  sh(r.dir, ["config", "user.email", "test@example.com"]);
  sh(r.dir, ["config", "commit.gpgsign", "false"]);
  return r;
}

describe("aihub init --no-pr", () => {
  it("writes the team pack, prefilled from the remote", async () => {
    const { dir } = repo();
    const { ctx, lines, errs } = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(["init", "--no-pr"], ctx)).toBe(0);
    expect(errs).toEqual([]);
    const team = parse(readFileSync(join(dir, TEAM), "utf8"));
    expect(team.azureDevOps).toEqual({ organization: "ferron-org", project: "test-project" });
    expect(team.repositories[0]).toMatchObject({ name: "test-repo", defaultTarget: "main" });
    expect(existsSync(join(dir, ".azuredevops/pull_request_template.md"))).toBe(true);
    expect(existsSync(join(dir, ".agents/skills/_shared/assets/story-template.md"))).toBe(true);
    // only team knowledge goes into the repository: no skills, no slash commands
    expect(existsSync(join(dir, ".opencode"))).toBe(false);
    expect(existsSync(join(dir, ".github"))).toBe(false);
    expect(lines.some((l) => l.startsWith("created  " + TEAM))).toBe(true);
    // the file we wrote passes our own doctor schema
    const schema = readFileSync(join(__dirname, "..", "..", "skills/_shared/references/team.schema.yaml"), "utf8");
    expect(validateTeam(team, requiredPaths(schema))).toEqual([]);
  });

  it("prefills workItems.states from the process of the project (live: Basic has Doing/Done, not Active)", async () => {
    const { dir } = repo();
    const f = fakeFetch([
      {
        match: /\/_apis\/wit\/workitemtypes\/User%20Story\/states\?/,
        respond: () => ({ body: { value: [{ name: "Todo", category: "Proposed" }, { name: "Doing", category: "InProgress" }, { name: "Done", category: "Completed" }] } }),
      },
    ]);
    const { ctx } = ctxFor(dir, f.fn);
    expect(await main(["init", "--no-pr"], ctx)).toBe(0);
    const team = parse(readFileSync(join(dir, TEAM), "utf8"));
    expect(team.workItems.states).toEqual({ active: "Doing", finished: "Done" });
  });

  it("keeps the default states when Azure DevOps cannot be asked", async () => {
    const { dir } = repo();
    const { ctx } = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(["init", "--no-pr"], ctx)).toBe(0);
    const team = parse(readFileSync(join(dir, TEAM), "utf8"));
    expect(team.workItems.states).toEqual({ active: "Active", finished: "Done" });
  });

  it("never overwrites and reports existing files as skipped", async () => {
    const { dir } = repo();
    write(dir, TEAM, "mine: true\n");
    write(dir, "docs/pull_request_template.md", "## Eigen\n");
    write(dir, ".opencode/command/pr.md", "eigen\n");
    const { ctx, lines } = ctxFor(dir, fakeFetch([]).fn);
    await main(["init", "--no-pr", "--into-repo"], ctx);
    expect(existsSync(join(dir, ".github/prompts/story.prompt.md"))).toBe(true);
    expect(readFileSync(join(dir, TEAM), "utf8")).toBe("mine: true\n");
    expect(readFileSync(join(dir, ".opencode/command/pr.md"), "utf8")).toBe("eigen\n");
    expect(existsSync(join(dir, ".azuredevops/pull_request_template.md"))).toBe(false);
    expect(lines).toContain("skipped  " + TEAM + " (exists)");
    expect(lines.join("\n")).toMatch(/skipped  .azuredevops\/pull_request_template.md \(a pull request template already exists \(docs\/pull_request_template.md\)\)/);
  });

  it("uses the Dutch templates with --language nl", async () => {
    const { dir } = repo();
    const { ctx } = ctxFor(dir, fakeFetch([]).fn);
    await main(["init", "--no-pr", "--language", "nl"], ctx);
    expect(readFileSync(join(dir, ".agents/skills/_shared/assets/story-template.md"), "utf8")).toContain("Acceptatiecriteria");
    expect(parse(readFileSync(join(dir, TEAM), "utf8")).language).toBe("nl");
  });

  it("rejects an unknown language", async () => {
    const { dir } = repo();
    const { ctx, errs } = ctxFor(dir, fakeFetch([]).fn);
    expect(await main(["init", "--no-pr", "--language", "fr"], ctx)).toBe(1);
    expect(errs.join("")).toContain("--language");
  });
});

describe("aihub init (pull request)", () => {
  it("creates branch, commit, push and a pull request listing created and skipped files", async () => {
    const { dir, bare } = repo();
    write(dir, ".opencode/command/pr.md", "eigen\n");
    const { fn, calls } = fakeFetch([
      { match: /pullrequests\?.*searchCriteria/, respond: () => ({ body: { value: [] } }) },
      { method: "POST", match: /pullrequests\?/, respond: () => ({ body: { pullRequestId: 9 } }) },
    ]);
    const { ctx, lines, errs } = ctxFor(dir, fn);
    const code = await main(["init", "--language", "nl", "--into-repo"], ctx);
    expect(errs).toEqual([]);
    expect(code).toBe(0);
    expect(errs).toEqual([]);
    expect(sh(bare, ["rev-parse", "--verify", "chore/aihub-team-pack"])).toMatch(/^[0-9a-f]{40}$/);
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body.sourceRefName).toBe("refs/heads/chore/aihub-team-pack");
    expect(post.body.targetRefName).toBe("refs/heads/main");
    expect(post.body.description).toContain(TEAM);
    expect(post.body.description).toMatch(/Overgeslagen[\s\S]*\.opencode\/command\/pr\.md/);
    expect(lines.join("\n")).toContain("pullrequest/9");
    // back on the original branch; the user's own file is untouched and uncommitted work is not swept in
    expect(sh(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(readFileSync(join(dir, ".opencode/command/pr.md"), "utf8")).toBe("eigen\n");
  });

  it("does nothing when everything exists", async () => {
    const { dir } = repo();
    const a = ctxFor(dir, fakeFetch([]).fn);
    await main(["init", "--no-pr"], a.ctx);
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-m", "pack"]);
    sh(dir, ["push", "origin", "main"]);
    const { fn, calls } = fakeFetch([]);
    const b = ctxFor(dir, fn);
    expect(await main(["init"], b.ctx)).toBe(0);
    expect(calls).toEqual([]);
    expect(b.lines.join("\n")).toContain("nothing to create");
    expect(sh(dir, ["branch", "--list", "chore/aihub-team-pack"])).toBe("");
  });
});

describe("team schema", () => {
  it("lists required paths from the schema comments and reports missing ones", () => {
    const schema = readFileSync(join(__dirname, "..", "..", "skills/_shared/references/team.schema.yaml"), "utf8");
    const req = requiredPaths(schema);
    expect(req).toContain("azureDevOps.project");
    expect(req).toContain("repositories[].defaultTarget");
    expect(validateTeam({ version: 1, language: "nl", repositories: [{ name: "x" }] }, req)).toEqual(
      expect.arrayContaining(["missing azureDevOps.organization", "missing repositories[].defaultTarget", "missing branches.feature"]),
    );
  });
});
