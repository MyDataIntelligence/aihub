import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { requiredPaths, validateTeam } from "../src/lib/schema.js";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo } from "./helpers.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pack = join(root, "team-pack");
const read = (rel: string) => readFileSync(join(pack, rel), "utf8");
const all = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? all(join(d, n)) : [join(d, n)]));

describe("team-pack", () => {
  it("has the documented files", () => {
    for (const f of [
      ".agents/skills/_shared/references/team.yaml",
      ".agents/skills/_shared/assets/story-template.md",
      ".agents/skills/_shared/assets/story-template.en.md",
      ".agents/skills/_shared/assets/commit-template.txt",
      ".agents/skills/_shared/assets/commit-template.en.txt",
      ".azuredevops/pull_request_template.md",
      ".azuredevops/pull_request_template.en.md",
      ".github/instructions/aihub.instructions.md",
      ".github/guidelines/aihub.md",
      "README.md",
    ]) expect(existsSync(join(pack, f)), f).toBe(true);
  });

  it("team.yaml is valid against the schema and only holds synthetic names", () => {
    const team = parse(read(".agents/skills/_shared/references/team.yaml"));
    const schema = readFileSync(join(root, "skills/_shared/references/team.schema.yaml"), "utf8");
    expect(validateTeam(team, requiredPaths(schema))).toEqual([]);
    expect(team.azureDevOps).toEqual({ organization: "ferron-test", project: "test-project" });
    expect(team.guidelines).toEqual([".github/guidelines/aihub.md"]);
  });

  it("every key of team.yaml is explained on its own line", () => {
    const lines = read(".agents/skills/_shared/references/team.yaml").split("\n").filter((l) => /^\s*(- )?[A-Za-z]+:/.test(l));
    const unexplained = lines.filter((l) => !l.includes("#") && !/:\s*$/.test(l) && !/^\s+- /.test(l));
    expect(unexplained).toEqual([]);
  });

  it("contains no real names or URLs", () => {
    for (const f of all(pack)) {
      const t = readFileSync(f, "utf8");
      expect(t, f).not.toMatch(/dev\.azure\.com\/(?!ferron-test)[A-Za-z0-9]/);
      expect(t, f).not.toMatch(/visualstudio\.com|@[a-z0-9-]+\.(com|nl)\b/i);
    }
  });
});

describe("aihub init uses team-pack as its only source", () => {
  it("writes the same files (Dutch by default in the pack, English variants for --language en) with the repository values", async () => {
    const { dir } = makeRepo();
    const { ctx } = ctxFor(dir, fakeFetch([]).fn);
    await main(["init", "--no-pr", "--language", "nl"], ctx);
    for (const [src, dst] of [
      [".agents/skills/_shared/assets/story-template.md", ".agents/skills/_shared/assets/story-template.md"],
      [".agents/skills/_shared/assets/commit-template.txt", ".agents/skills/_shared/assets/commit-template.txt"],
      [".azuredevops/pull_request_template.md", ".azuredevops/pull_request_template.md"],
    ]) expect(readFileSync(join(dir, dst), "utf8").replace(/\r\n/g, "\n")).toBe(read(src).replace(/\r\n/g, "\n"));
    const team = readFileSync(join(dir, ".agents/skills/_shared/references/team.yaml"), "utf8");
    expect(team).toContain("# Proposed by 'aihub init'");
    expect(team).toMatch(/organization: ferron-org\s+# Azure DevOps organization/); // the explanations stay
    const parsed = parse(team);
    expect(parsed.repositories[0]).toMatchObject({ name: "test-repo", defaultTarget: "main" });
    expect(parsed.guidelines).toBeUndefined();
    expect(parsed.pipelines).toBeUndefined();
    expect(existsSync(join(dir, ".github"))).toBe(false);

    const en = makeRepo().dir;
    await main(["init", "--no-pr", "--language", "en"], ctxFor(en, fakeFetch([]).fn).ctx);
    expect(readFileSync(join(en, ".agents/skills/_shared/assets/story-template.md"), "utf8").replace(/\r\n/g, "\n")).toBe(
      read(".agents/skills/_shared/assets/story-template.en.md").replace(/\r\n/g, "\n"),
    );
    expect(existsSync(join(en, ".azuredevops/pull_request_template.en.md"))).toBe(false);
  });
});