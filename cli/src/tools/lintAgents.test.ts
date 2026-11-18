import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lintAgents } from "./lintSkills.js";

const repoAgents = path.resolve(import.meta.dirname, "../../../agents");
const repoSkills = path.resolve(import.meta.dirname, "../../../skills");
const skillNames = fs.readdirSync(repoSkills, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith("_")).map((e) => e.name);

const BODY = "Load the `start-here` skill and run its one `aihub` command.\n";
const OC = `---\ndescription: Demo\nmode: primary\npermissions:\n  - action: shell\n    resource: "aihub *"\n    effect: allow\n---\n${BODY}`;
const CP = `---\nname: demo\ndescription: Demo\ntools: ["execute", "read"]\n---\n${BODY}`;

function pack(oc: string | undefined, cp: string | undefined): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lint-agents-"));
  fs.mkdirSync(path.join(root, "opencode"));
  fs.mkdirSync(path.join(root, "copilot"));
  if (oc !== undefined) fs.writeFileSync(path.join(root, "opencode", "demo.md"), oc);
  if (cp !== undefined) fs.writeFileSync(path.join(root, "copilot", "demo.agent.md"), cp);
  return root;
}

describe("lintAgents", () => {
  it("the agents of this repository pass", () => {
    expect(lintAgents(repoAgents, skillNames)).toEqual([]);
  });

  it("accepts a valid pair", () => {
    expect(lintAgents(pack(OC, CP), skillNames)).toEqual([]);
  });

  it("rejects broken front matter and missing keys", () => {
    expect(lintAgents(pack("no front matter\n", CP), skillNames).join("\n")).toContain("front matter missing");
    expect(lintAgents(pack(OC.replace("mode: primary", "mode: [unclosed"), CP), skillNames).join("\n")).toContain("not valid YAML");
    expect(lintAgents(pack(OC.replace("mode: primary", "mode: sideways"), CP), skillNames).join("\n")).toContain("mode must be");
    expect(lintAgents(pack(OC.replace("effect: allow", "effect: maybe"), CP), skillNames).join("\n")).toContain("permissions[0]");
    expect(lintAgents(pack(OC, CP.replace("name: demo", "name: other")), skillNames).join("\n")).toContain("must equal the file name");
    expect(lintAgents(pack(OC, CP.replace('tools: ["execute", "read"]\n', "")), skillNames).join("\n")).toContain("tools must be");
    expect(lintAgents(pack(OC, CP.replace("description: Demo\n", "")), skillNames).join("\n")).toContain("description missing");
  });

  it("rejects a body over the budget", () => {
    const long = Array.from({ length: 30 }, (_, i) => `- rule number ${i}`).join("\n") + "\n";
    const errs = lintAgents(pack(OC.replace(BODY, long), CP.replace(BODY, long)), skillNames).join("\n");
    expect(errs).toContain("lines, max");
  });

  it("rejects absolute paths, real names and skills that do not exist", () => {
    const bad = "Read C:\\Users\\someone\\notes and use the `nope-skill` skill.\n";
    const errs = lintAgents(pack(OC.replace(BODY, bad), CP.replace(BODY, bad)), skillNames).join("\n");
    expect(errs).toContain("absolute path");
    expect(errs).toContain('names the skill "nope-skill"');
    expect(lintAgents(pack(OC.replace(BODY, "Ask IQBS.\n"), CP.replace(BODY, "Ask IQBS.\n")), skillNames).join("\n")).toContain("forbidden name");
  });

  it("rejects bodies that differ between the clients or a client file that is missing", () => {
    expect(lintAgents(pack(OC, CP.replace(BODY, BODY + "extra\n")), skillNames).join("\n")).toContain("bodies differ");
    expect(lintAgents(pack(OC, undefined), skillNames).join("\n")).toContain("needs both");
  });
});
