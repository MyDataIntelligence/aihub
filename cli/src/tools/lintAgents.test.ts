import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lintAgents } from "./lintSkills.js";

const repoAgents = path.resolve(import.meta.dirname, "../../../agents");
const repoSkills = path.resolve(import.meta.dirname, "../../../skills");
const skillNames = fs.readdirSync(repoSkills, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith("_")).map((e) => e.name);

const BODY = "Load the `start-here` skill and run its one `aihub` command.";

/** One valid agent "demo" for every client; `tweak` may change the text of one client. */
function files(body = BODY): Record<string, { file: string; text: string }> {
  return {
    opencode: { file: "demo.md", text: `---\ndescription: Demo\nmode: primary\npermission:\n  bash:\n    "*": ask\n    "aihub *": allow\n---\n${body}\n` },
    opencode2: { file: "demo.md", text: `---\ndescription: Demo\nmode: primary\npermissions:\n  - action: shell\n    resource: "aihub *"\n    effect: allow\n---\n${body}\n` },
    copilot: { file: "demo.agent.md", text: `---\nname: demo\ndescription: Demo\ntools: ["execute", "read"]\n---\n${body}\n` },
    codex: { file: "demo.toml", text: `name = "demo"\ndescription = "Demo"\ndeveloper_instructions = """\n${body}\n"""\n` },
    claude: { file: "demo.md", text: `---\nname: demo\ndescription: Demo\ntools: Bash, Read\n---\n${body}\n` },
  };
}

function pack(tweak: (f: ReturnType<typeof files>) => void = () => undefined): string {
  const f = files();
  tweak(f);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lint-agents-"));
  for (const [kind, { file, text }] of Object.entries(f)) {
    fs.mkdirSync(path.join(root, kind));
    if (text) fs.writeFileSync(path.join(root, kind, file), text);
  }
  return root;
}

const lint = (tweak?: (f: ReturnType<typeof files>) => void) => lintAgents(pack(tweak), skillNames).join("\n");

describe("lintAgents", () => {
  it("the agents of this repository pass", () => {
    expect(lintAgents(repoAgents, skillNames)).toEqual([]);
  });

  it("accepts a valid set", () => {
    expect(lint()).toBe("");
  });

  it("rejects broken front matter and missing keys per client", () => {
    expect(lint((f) => (f.opencode.text = "no front matter\n"))).toContain("front matter missing");
    expect(lint((f) => (f.opencode.text = f.opencode.text.replace("mode: primary", "mode: [unclosed")))).toContain("not valid YAML");
    expect(lint((f) => (f.opencode.text = f.opencode.text.replace("mode: primary", "mode: sideways")))).toContain("mode must be");
    expect(lint((f) => (f.opencode.text = f.opencode.text.replace('"aihub *": allow', '"aihub *": maybe')))).toContain("must be allow, ask or deny");
    expect(lint((f) => (f.opencode2.text = f.opencode2.text.replace("effect: allow", "effect: maybe")))).toContain("permissions[0]");
    expect(lint((f) => (f.copilot.text = f.copilot.text.replace("name: demo", "name: other")))).toContain("must equal the file name");
    expect(lint((f) => (f.copilot.text = f.copilot.text.replace('tools: ["execute", "read"]\n', "")))).toContain("tools must be");
    expect(lint((f) => (f.claude.text = f.claude.text.replace("tools: Bash, Read\n", "")))).toContain("tools must be a comma separated string");
    expect(lint((f) => (f.codex.text = f.codex.text.replace('name = "demo"\n', "")))).toContain("expected name, description and developer_instructions");
    expect(lint((f) => (f.codex.text = f.codex.text.replace('name = "demo"', 'name = "other"')))).toContain("must equal the file name");
    expect(lint((f) => (f.claude.text = f.claude.text.replace("description: Demo\n", "")))).toContain("description missing");
  });

  it("rejects a body over the budget", () => {
    const long = Array.from({ length: 30 }, (_, i) => `- rule number ${i}`).join("\n");
    const f = files(long);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lint-agents-"));
    for (const [kind, { file, text }] of Object.entries(f)) {
      fs.mkdirSync(path.join(root, kind));
      fs.writeFileSync(path.join(root, kind, file), text);
    }
    expect(lintAgents(root, skillNames).join("\n")).toContain("lines, max");
  });

  it("rejects absolute paths, real names and skills that do not exist", () => {
    const bad = (body: string) => lint((f) => (f.claude.text = f.claude.text.replace(BODY, body)));
    expect(bad("Read C:\\Users\\someone\\notes.")).toContain("absolute path");
    expect(bad("Use the `nope-skill` skill.")).toContain('names the skill "nope-skill"');
    expect(bad("Ask IQBS.")).toContain("forbidden name");
  });

  it("rejects bodies that differ between the clients or a client folder that lacks the agent", () => {
    expect(lint((f) => (f.codex.text = f.codex.text.replace(BODY, BODY + "\nextra")))).toContain("bodies differ");
    expect(lint((f) => (f.opencode2.text = ""))).toContain("missing for opencode2");
  });
});
