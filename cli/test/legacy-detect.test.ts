import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { legacyFootprint } from "../src/lib/legacy.js";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, fixtureText, tmp } from "./helpers.js";

const put = (p: string, c: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, c, "utf8");
};

function fakeHome() {
  const h = tmp("aihub-detect-");
  const env: NodeJS.ProcessEnv = {
    HOME: h,
    USERPROFILE: h,
    LOCALAPPDATA: join(h, "AppData", "Local"),
    APPDATA: join(h, "AppData", "Roaming"),
    XDG_CONFIG_HOME: join(h, ".config"),
    CODEX_HOME: join(h, ".codex"),
    COPILOT_HOME: join(h, ".copilot"),
    OPENCODE_CONFIG_DIR: join(h, ".config", "opencode"),
    AIHUB_OPENCODE_VERSION: "1.19.5",
    AIHUB_HOME: join(h, ".aihub-new"),
    PATH: "",
  };
  return { h, env };
}

function oldHub(h: string, env: NodeJS.ProcessEnv) {
  put(join(h, ".copilot", "skills", "aihub-setup", "SKILL.md"), fixtureText("legacy/aihub-setup.SKILL.md"));
  put(join(h, ".copilot", "agents", "hub.agent.md"), fixtureText("legacy/hub.agent.md"));
  put(join(h, ".copilot", "hooks", "aihub.json"), JSON.stringify({ version: 1, hooks: { sessionStart: [{ type: "command", bash: "'/h/hooks/hub-hook' copilot sessionStart" }] } }));
  const bin = join(h, "bin");
  put(join(bin, "hub.cmd"), "@echo off");
  put(join(bin, "HUB_COMMANDS.md"), "x");
  env.PATH = bin;
}

describe("old AI Context Hub detection", () => {
  it("a clean machine reports nothing", () => {
    const { env } = fakeHome();
    expect(legacyFootprint(env, tmp()).found).toEqual([]);
  });

  it("finds the hub CLI on the PATH, old skills, the hub agent and hooks, and ignores look-alikes", () => {
    const { h, env } = fakeHome();
    oldHub(h, env);
    put(join(h, ".copilot", "skills", "aihub-mine", "SKILL.md"), "---\nname: aihub-mine\n---\nmine\n");
    put(join(h, "other", "hub.cmd"), "@echo off"); // a hub.cmd of something else, not on the PATH
    const f = legacyFootprint(env, tmp());
    expect(f.cli).toBe(true);
    expect(f.skills).toBe(1);
    expect(f.rules).toBe(1);
    expect(f.hooks).toBe(1);
    expect(f.found).toEqual(["the old hub CLI", "1 old Hub skill", "1 Hub agent/rules file", "1 Hub hook"]);
  });

  it("aihub doctor says FIX with the legacy command on a machine with the old Hub, OK without", async () => {
    const a = fakeHome();
    const clean = ctxFor(tmp(), fakeFetch([]).fn);
    clean.ctx.env = a.env;
    await main(["doctor"], clean.ctx);
    expect(clean.lines.join("\n")).toContain("OK   legacy-hub: no old AI Context Hub found");

    const b = fakeHome();
    oldHub(b.h, b.env);
    const old = ctxFor(tmp(), fakeFetch([]).fn);
    old.ctx.env = b.env;
    await main(["doctor"], old.ctx);
    const line = old.lines.find((l) => l.includes("legacy-hub:")) ?? "";
    expect(line).toContain("FIX  legacy-hub: the old AI Context Hub is still installed (the old hub CLI, 1 old Hub skill");
    expect(line).toContain("'hub call' instead of aihub");
    expect(line).toContain("-> aihub legacy remove --dry-run");
  });

  it("aihub skills install warns once about the old Hub and prints the auto-approve notes per client", async () => {
    const { h, env } = fakeHome();
    oldHub(h, env);
    const c = ctxFor(tmp(), fakeFetch([]).fn);
    c.ctx.env = env;
    await main(["skills", "install", "--global", "--client", "all"], c.ctx);
    const out = c.lines.join("\n");
    expect(out.match(/warning: the old AI Context Hub is still installed/g)).toHaveLength(1);
    expect(out).toContain("Run: aihub legacy remove --dry-run");
    expect(out).toContain("note: the opencode aihub agent runs commands without asking");
    expect(out).toContain('"chat.tools.terminal.autoApprove"');
    expect(out).toContain('approval_policy = "never"');

    const clean = fakeHome();
    const d = ctxFor(tmp(), fakeFetch([]).fn);
    d.ctx.env = clean.env;
    await main(["skills", "install", "--global", "--client", "opencode"], d.ctx);
    expect(d.lines.join("\n")).not.toContain("warning: the old AI Context Hub");
  });
});
