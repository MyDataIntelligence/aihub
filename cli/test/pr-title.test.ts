import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { prTitle } from "../src/lib/prTitle.js";
import { ctxFor, fakeFetch, makeRepo, sh, write } from "./helpers.js";

const TEAM = (title: string) => `repositories:\n  - name: test-repo\n    defaultTarget: main\npullRequest:\n  title: "${title}"\n`;

function setup(team: string, branch = "feature/1234-zoekfunctie") {
  const { dir, bare } = makeRepo();
  write(dir, ".agents/skills/_shared/references/team.yaml", team);
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "chore: team"]);
  sh(dir, ["push", "origin", "main"]);
  sh(dir, ["checkout", "-b", branch]);
  write(dir, "zoek.py", "print('zoë')\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-m", "feat: zoekfunctie met ë"]);
  return { dir, bare };
}

const routes = [
  { match: /_apis\/wit\/workitems\/1234\?.*fields=/, respond: () => ({ body: { fields: { "System.Title": "Zoekfunctie bouwen" } } }) },
  { match: /expand=relations/, respond: () => ({ body: { relations: [] } }) },
  { match: /pullrequests\?.*searchCriteria/, respond: () => ({ body: { value: [] } }) },
];

async function dryTitle(dir: string, extra: string[] = []): Promise<string> {
  const { fn } = fakeFetch(routes);
  const { ctx, lines } = ctxFor(dir, fn);
  expect(await main(["pr", "create", "--dry-run", "--json", ...extra], ctx)).toBe(0);
  return JSON.parse(lines[0]).title;
}

describe("pull request title from team.yaml pullRequest.title", () => {
  it("aihub pr create fills {storyId} and {storyTitle}", async () => {
    const { dir } = setup(TEAM("{storyId}: {storyTitle}"));
    expect(await dryTitle(dir)).toBe("1234: Zoekfunctie bouwen");
  });

  it("fills {branch}, and --title still wins", async () => {
    const { dir } = setup(TEAM("[{branch}] {storyTitle}"));
    expect(await dryTitle(dir)).toBe("[feature/1234-zoekfunctie] Zoekfunctie bouwen");
    expect(await dryTitle(dir, ["--title", "Eigen titel"])).toBe("Eigen titel");
  });

  it("a branch without a story keeps the first commit instead of an empty pattern", async () => {
    const { dir } = setup(TEAM("{storyId}: {storyTitle}"), "feature/zonder-story");
    expect(await dryTitle(dir)).toBe("feat: zoekfunctie met ë");
  });

  it("prTitle: no pattern is the old title; a story-free pattern works without a story", () => {
    expect(prTitle({ storyId: 7, storyTitle: "T", branch: "b" })).toBe("7 T");
    expect(prTitle({ pattern: "", branch: "b", firstCommit: "c" })).toBe("c");
    expect(prTitle({ pattern: "Wijziging {branch}", branch: "feature/x" })).toBe("Wijziging feature/x");
    expect(prTitle({ pattern: "{storyId}: {storyTitle}", storyId: 7, branch: "b" })).toBe("b");
  });
});
