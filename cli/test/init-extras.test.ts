import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectAreas } from "../src/lib/initExtras.js";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, sh, write } from "./helpers.js";

function repo(files: Record<string, string> = {}) {
  const r = makeRepo();
  sh(r.dir, ["config", "user.name", "Test"]);
  sh(r.dir, ["config", "user.email", "test@example.com"]);
  sh(r.dir, ["config", "commit.gpgsign", "false"]);
  for (const [p, c] of Object.entries(files)) write(r.dir, p, c);
  if (Object.keys(files).length) {
    sh(r.dir, ["add", "."]);
    sh(r.dir, ["commit", "-m", "files"]);
    sh(r.dir, ["push", "origin", "main"]);
  }
  return r.dir;
}

async function init(dir: string, args: string[] = []) {
  const { ctx, lines, errs } = ctxFor(dir, fakeFetch([]).fn);
  const code = await main(["init", "--no-pr", ...(args.includes("--language") ? [] : ["--language", "en"]), ...args], ctx);
  return { code, out: lines.join("\n"), errs };
}

const read = (dir: string, p: string) => readFileSync(join(dir, p), "utf8");

describe("detectAreas", () => {
  it("picks up to three file types that really occur (at least 2 files), most files first; general when none", () => {
    expect(detectAreas(["a.py", "b.py", "c.py", "m.sql", "n.sql", "x.ts", "README.md"]).map((a) => a.key)).toEqual(["python", "sql"]);
    expect(detectAreas(["a.py", "b.py", "c.sql", "d.sql", "e.tf", "f.tf", "g.ts", "h.ts", "i.ts"]).map((a) => a.key)).toEqual(["typescript", "python", "sql"]);
    expect(detectAreas(["README.md", "one.py"]).map((a) => a.key)).toEqual(["general"]);
  });
});

describe("aihub init: .github/instructions skeletons", () => {
  it("proposes one skeleton per detected file type with applyTo front matter and empty rule bullets, plus a README", async () => {
    const dir = repo({ "models/a.sql": "select 1", "models/b.sql": "select 2", "src/x.py": "x=1", "src/y.py": "y=2", "src/z.py": "z=3" });
    const r = await init(dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain("created  .github/instructions/python.instructions.md");
    expect(r.out).toContain("created  .github/instructions/sql.instructions.md");
    const py = read(dir, ".github/instructions/python.instructions.md");
    expect(py.startsWith('---\napplyTo: "**/*.py"\n---\n')).toBe(true);
    expect(py).toContain("# Python rules");
    expect(py).toContain("aihub does not invent rules");
    expect(py).toMatch(/\n- \n- \n- \n$/); // empty bullets, no invented rules
    expect(read(dir, ".github/instructions/sql.instructions.md")).toContain('applyTo: "**/*.sql"');
    expect(read(dir, ".github/instructions/README.md")).toContain("GitHub Copilot loads them automatically");
    expect(existsSync(join(dir, ".github/instructions/typescript.instructions.md"))).toBe(false);
  });

  it("a repository without known file types gets one general skeleton; Dutch team files are Dutch", async () => {
    const dir = repo();
    const r = await init(dir, ["--language", "nl"]);
    expect(r.out).toContain("created  .github/instructions/general.instructions.md");
    expect(read(dir, ".github/instructions/general.instructions.md")).toContain('applyTo: "**"');
    expect(read(dir, ".github/instructions/general.instructions.md")).toContain("# General-regels");
    expect(read(dir, ".github/instructions/README.md")).toContain("Instructies per bestandstype");
  });

  it("an existing instructions file is left untouched and reported as skipped", async () => {
    const mine = '---\napplyTo: "**/*.py"\n---\n# Our rules\n- use ruff\n';
    const dir = repo({ ".github/instructions/python.instructions.md": mine, "a.py": "1", "b.py": "2" });
    const r = await init(dir);
    expect(read(dir, ".github/instructions/python.instructions.md")).toBe(mine);
    expect(r.out).toContain("skipped  .github/instructions/python.instructions.md (exists)");
  });

  it("--no-instructions writes none", async () => {
    const dir = repo({ "a.py": "1", "b.py": "2" });
    await init(dir, ["--no-instructions"]);
    expect(existsSync(join(dir, ".github/instructions"))).toBe(false);
    expect(read(dir, "AGENTS.md")).not.toContain("instructions");
  });
});

describe("aihub init: AGENTS.md block", () => {
  it("creates AGENTS.md with the marked block (team file and PR template paths, English)", async () => {
    const dir = repo();
    const r = await init(dir);
    expect(r.out).toContain("created  AGENTS.md");
    const a = read(dir, "AGENTS.md");
    expect(a.startsWith("# AGENTS.md\n\n<!-- aihub:begin -->\n## Working with aihub\n")).toBe(true);
    expect(a).toContain("npm i -g @ferronhooi/aihub");
    expect(a).toContain("aihub skills install");
    expect(a).toContain(".agents/skills/_shared/references/team.yaml");
    expect(a).toContain(".azuredevops/pull_request_template.md");
    expect(a).toContain(".github/instructions/*.instructions.md");
    expect(a.trimEnd().endsWith("<!-- aihub:end -->")).toBe(true);
  });

  it("Dutch team: Dutch block", async () => {
    const dir = repo();
    await init(dir, ["--language", "nl"]);
    const a = read(dir, "AGENTS.md");
    expect(a).toContain("## Werken met aihub");
    expect(a).toContain("Teamkennis:");
  });

  it("an existing AGENTS.md without an aihub line gets the block appended, the rest untouched", async () => {
    const mine = "# Our rules\n\n- be kind\n";
    const dir = repo({ "AGENTS.md": mine });
    const r = await init(dir);
    expect(r.out).toContain("updated  AGENTS.md (aihub block appended)");
    const a = read(dir, "AGENTS.md");
    expect(a.startsWith(mine.trimEnd())).toBe(true);
    expect(a).toContain("<!-- aihub:begin -->");
    // the second run proposes nothing again
    const again = await init(dir);
    expect(again.out).toContain("skipped  AGENTS.md (it already mentions aihub)");
    expect(read(dir, "AGENTS.md")).toBe(a);
  });

  it("an AGENTS.md that already mentions aihub is not touched", async () => {
    const mine = "# Rules\n\nUse the aihub skills.\n";
    const dir = repo({ "AGENTS.md": mine });
    const r = await init(dir);
    expect(read(dir, "AGENTS.md")).toBe(mine);
    expect(r.out).toContain("skipped  AGENTS.md (it already mentions aihub)");
  });

  it("--no-agents-md leaves AGENTS.md alone; an existing PR template path is used in the block", async () => {
    const dir = repo({ ".azuredevops/pull_request_template.md": "## Samenvatting\n" });
    await init(dir, ["--no-agents-md"]);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    const dir2 = repo({ ".azuredevops/pull_request_template.md": "## Samenvatting\n" });
    await init(dir2);
    expect(read(dir2, "AGENTS.md")).toContain(".azuredevops/pull_request_template.md");
  });

  it("--dry-run shows what would be written and writes nothing", async () => {
    const dir = repo({ "a.py": "1", "b.py": "2" });
    const r = await init(dir, ["--dry-run"]);
    expect(r.out).toContain("would write");
    expect(r.out).toContain("AGENTS.md");
    expect(r.out).toContain(".github/instructions/python.instructions.md");
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(dir, ".github/instructions"))).toBe(false);
  });
});
