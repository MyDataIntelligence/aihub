import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { promptsRoot } from "../src/lib/pack.js";
import { ACTIONS, findPrompt, listPrompts, promptText, splitFront, TEAM_PROMPT_DIR } from "../src/lib/e2e/prompts.js";
import { tmp } from "./helpers.js";
import { setup } from "./storiesWorld.js";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(cli, "..");

describe("default prompts in the package", () => {
  it("every action has a Dutch and an English default with a title, a goal and a body", () => {
    for (const dir of [join(repo, "prompts"), join(repo, "prompts", "en")]) {
      for (const a of ACTIONS) {
        const { meta, body } = splitFront(readFileSync(join(dir, `${a}.md`), "utf8"));
        expect([a, !!meta.title, !!meta.goal, !!meta.reads, !!meta.produces, body.includes("{{limits}}")]).toEqual([a, true, true, true, true, true]);
      }
    }
  });

  it("the npm package ships prompts/ and prompts/en/ under pack/ (what `npm i -g` installs)", () => {
    execFileSync(process.execPath, [join(cli, "scripts", "copy-pack.mjs")], { cwd: cli });
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const out = execFileSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: cli, encoding: "utf8", shell: process.platform === "win32" });
    const files = (JSON.parse(out.slice(out.indexOf("["))) as { files: { path: string; size: number }[] }[])[0].files;
    const byPath = new Map(files.map((f) => [f.path.split("\\").join("/"), f.size]));
    for (const a of ACTIONS) {
      expect(byPath.get(`pack/prompts/${a}.md`), a).toBeGreaterThan(200);
      expect(byPath.get(`pack/prompts/en/${a}.md`), `en ${a}`).toBeGreaterThan(200);
    }
  }, 120_000);

  it("the installed package's pack/prompts wins over a checkout around it; without prompts the error says so", () => {
    const pkg = tmp("aihub-pkg-");
    const lib = join(pkg, "dist", "lib");
    mkdirSync(lib, { recursive: true });
    expect(() => promptsRoot(lib)).toThrow(/default prompts are missing/);
    mkdirSync(join(pkg, "pack", "prompts"), { recursive: true });
    writeFileSync(join(pkg, "pack", "prompts", "story-run.md"), "---\ntitle: x\n---\n# Goal\n");
    expect(promptsRoot(lib)).toBe(join(pkg, "pack", "prompts"));
    // this source checkout: cli/src/lib -> <repo>/prompts
    expect(readdirSync(promptsRoot(join(cli, "src", "lib")))).toContain("story-test-fabric.md");
  });
});

describe("a prompt is never empty", () => {
  it("a missing or empty prompt file is a clear error", () => {
    expect(() => promptText(join(tmp(), "nope.md"))).toThrow(/prompt file not found/);
    const f = join(tmp(), "empty.md");
    writeFileSync(f, "---\ntitle: Leeg\n---\n\n");
    expect(() => promptText(f)).toThrow(/prompt file is empty/);
  });

  it("an empty team prompt is refused, not shown as an empty prompt", () => {
    const t = setup();
    const s = t.s();
    const root = tmp("aihub-team-");
    mkdirSync(join(root, TEAM_PROMPT_DIR), { recursive: true });
    writeFileSync(join(root, TEAM_PROMPT_DIR, "story-test-fabric.md"), "");
    s.root = root;
    expect(() => findPrompt(s, "story-test-fabric")).toThrow(/prompt file is empty/);
  });

  it("the Prompts page gets the full text of every prompt, also without a story", () => {
    const t = setup();
    const s = t.s();
    s.teamCfg = { language: "nl" } as never;
    const l = listPrompts(t.ctx, s);
    const fabric = l.prompts.find((p) => p.action === "story-test-fabric")!;
    expect(fabric.title).toBe("Test on Fabric");
    expect(fabric.goal).toContain("Bewijs per criterium");
    expect(fabric.text).toMatch(/^# Test on Fabric/);
    expect(fabric.text).toContain("{{workspace}}");
    for (const p of l.prompts) expect(p.text.length, p.action).toBeGreaterThan(100);
    // the list has no story: no raw placeholder in a summary
    for (const p of l.prompts) expect(`${p.goal} ${p.reads} ${p.produces}`, p.action).not.toContain("{{");
    expect(l.prompts.find((p) => p.action === "story-run")!.goal).toBe("Een groene pull request naar de doelbranch met alle acceptatiecriteria bewezen.");
    s.teamCfg = { language: "nl", repositories: [{ name: "", defaultTarget: "staging" }] } as never;
    expect(listPrompts(t.ctx, s).prompts.find((p) => p.action === "story-run")!.goal).toContain("naar staging");
  });
});
