import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COMMANDS, commandFileName, expectedCommand, lintSkills, parseFrontMatter } from "./lintSkills.js";

const repoSkills = path.resolve(import.meta.dirname, "../../../skills");

function body(extra = ""): string {
  const para = "Run the command and report the printed link. Never ask about template sections. ".repeat(12);
  return `# T\n\n## When\n${para}\n## Steps\nx\n## What the CLI fills\ny\n## If it fails\nz\n${extra}`;
}

function pack(skill: string, text: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lint-"));
  fs.mkdirSync(path.join(root, "skills", skill), { recursive: true });
  fs.mkdirSync(path.join(root, "commands"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", skill, "SKILL.md"), text);
  return path.join(root, "skills");
}

const good = (extra = "") => `---\nname: demo\ndescription: "Use when testing"\n---\n${body(extra)}`;
const lint = (dir: string) => lintSkills(dir).filter((e) => !e.includes("commands") && !e.includes("skill \"") && !e.includes(".md: missing"));

describe("lintSkills", () => {
  it("accepts a valid skill", () => {
    expect(lint(pack("demo", good()))).toEqual([]);
  });
  it("requires Use when", () => {
    const t = good().replace("Use when testing", "Does things");
    expect(lint(pack("demo", t)).join()).toMatch(/Use when/);
  });
  it("requires name equal to folder", () => {
    expect(lint(pack("other", good())).join()).toMatch(/must equal folder/);
  });
  it("checks the token budget", () => {
    expect(lint(pack("demo", good("x".repeat(4000)))).join()).toMatch(/max 500/);
  });
  it("flags broken links, absolute paths and forbidden names", () => {
    const e = lint(pack("demo", good("[a](nope.md) C:\\Users\\x IQBS"))).join("\n");
    expect(e).toMatch(/link does not resolve/);
    expect(e).toMatch(/absolute path/);
    expect(e).toMatch(/forbidden name "iqbs"/);
  });
  it("accepts a configurable forbidden list", () => {
    const dir = pack("demo", good("Acme"));
    expect(lintSkills(dir, { forbidden: ["acme"] }).join()).toMatch(/forbidden name "acme"/);
  });
  it("does not treat https links as absolute paths", () => {
    expect(lint(pack("demo", good("[x](https://example.com/a)")))).toEqual([]);
  });
  it("parses front matter", () => {
    expect(parseFrontMatter(good())?.data.name).toBe("demo");
  });
  it("detects commands that drift from the generated text", () => {
    const dir = pack("demo", good());
    const cmds = path.join(dir, "..", "commands", "opencode");
    fs.mkdirSync(cmds, { recursive: true });
    fs.writeFileSync(path.join(cmds, "pr.md"), "edited");
    expect(lintSkills(dir).join("\n")).toMatch(/pr.md: does not match|skill "pr-create" does not exist/);
  });
});

describe("the real pack", () => {
  it("lints clean", () => {
    expect(lintSkills(repoSkills)).toEqual([]);
  });
  it("has command files equal to the generated text", () => {
    for (const kind of ["opencode", "copilot"] as const) {
      for (const c of COMMANDS) {
        const f = path.join(repoSkills, "..", "commands", kind, commandFileName(kind, c));
        expect(fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n")).toBe(expectedCommand(kind, c));
      }
    }
  });
});
