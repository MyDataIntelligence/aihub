import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, tmp } from "./helpers.js";

/** A fake home: every variable that could point at the real one is overridden. */
function fakeHome() {
  const h = tmp("aihub-agents-home-");
  const env: NodeJS.ProcessEnv = {
    HOME: h,
    USERPROFILE: h,
    XDG_CONFIG_HOME: join(h, ".config"),
    XDG_DATA_HOME: join(h, ".local", "share"),
    CODEX_HOME: join(h, ".codex"),
    COPILOT_HOME: join(h, ".copilot"),
    OPENCODE_CONFIG_DIR: join(h, ".config", "opencode"),
    AIHUB_OPENCODE_VERSION: "1.19.5",
    CLAUDE_CONFIG_DIR: join(h, ".claude"),
  };
  return { h, env };
}

async function run(args: string[], env: NodeJS.ProcessEnv, cwd = tmp()) {
  const { ctx, lines, errs } = ctxFor(cwd, fakeFetch([]).fn);
  ctx.env = env;
  const code = await main(args, ctx);
  return { code, lines, errs };
}

describe("aihub skills install: optional agents", () => {
  it("installs aihub and aihub-runner for opencode, github-copilot and codex, not for claude unless asked", async () => {
    const { h, env } = fakeHome();
    const r = await run(["skills", "install", "--global"], env);
    expect(r.errs).toEqual([]);
    expect(r.code).toBe(0);
    const oc = join(h, ".config", "opencode", "agent");
    expect(existsSync(join(oc, "aihub.md"))).toBe(true);
    expect(existsSync(join(oc, "aihub-runner.md"))).toBe(true);
    expect(existsSync(join(h, ".copilot", "agents", "aihub.agent.md"))).toBe(true);
    expect(existsSync(join(h, ".copilot", "agents", "aihub-runner.agent.md"))).toBe(true);
    expect(existsSync(join(h, ".codex", "agents", "aihub.toml"))).toBe(true);
    expect(existsSync(join(h, ".claude"))).toBe(false);
    // the version marker comes after the front matter, which stays first
    const text = readFileSync(join(oc, "aihub.md"), "utf8");
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toMatch(/\n---\n<!-- aihub \S+ -->\n/);
    // the manifest records every agent file with its checksum
    const man = JSON.parse(readFileSync(join(oc, ".aihub-manifest.json"), "utf8")) as { files: Record<string, string> };
    expect(Object.keys(man.files).sort()).toEqual(["aihub-runner.md", "aihub.md"]);
  });

  it("accepts --client copilot as an alias for github-copilot", async () => {
    const { h, env } = fakeHome();
    await run(["skills", "install", "--global", "--client", "copilot"], env);
    expect(existsSync(join(h, ".copilot", "agents", "aihub.agent.md"))).toBe(true);
    expect(existsSync(join(h, ".config", "opencode"))).toBe(false);
  });

  it("--no-agents skips them, and update does not add them afterwards", async () => {
    const { h, env } = fakeHome();
    await run(["skills", "install", "--global", "--no-agents"], env);
    expect(existsSync(join(h, ".config", "opencode", "skills", "start-here", "SKILL.md"))).toBe(true);
    expect(existsSync(join(h, ".config", "opencode", "agent"))).toBe(false);
    expect(existsSync(join(h, ".copilot", "agents"))).toBe(false);
    await run(["skills", "update"], env);
    expect(existsSync(join(h, ".config", "opencode", "agent"))).toBe(false);
  });

  it("never touches the user's own agents, nor an edited aihub agent", async () => {
    const { h, env } = fakeHome();
    const dir = join(h, ".config", "opencode", "agent");
    await run(["skills", "install", "--global", "--client", "opencode"], env);
    writeFileSync(join(dir, "mine.md"), "---\ndescription: mine\n---\nmy agent\n");
    const edited = readFileSync(join(dir, "aihub.md"), "utf8") + "\nMy extra rule.\n";
    writeFileSync(join(dir, "aihub.md"), edited);
    const r = await run(["skills", "install", "--global", "--client", "opencode"], env);
    expect(r.lines.join("\n")).toMatch(/skipped .*aihub\.md \(changed by the user\)/);
    expect(readFileSync(join(dir, "aihub.md"), "utf8")).toBe(edited);
    const u = await run(["skills", "uninstall", "--client", "opencode"], env);
    expect(u.code).toBe(0);
    expect(existsSync(join(dir, "aihub-runner.md"))).toBe(false);
    expect(readFileSync(join(dir, "aihub.md"), "utf8")).toBe(edited);
    expect(existsSync(join(dir, "mine.md"))).toBe(true);
  });

  it("an existing file with the same name that aihub did not write is skipped", async () => {
    const { h, env } = fakeHome();
    const dir = join(h, ".copilot", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "aihub.agent.md"), "---\nname: aihub\ndescription: own\ntools: []\n---\nown\n");
    const r = await run(["skills", "install", "--global", "--client", "copilot"], env);
    expect(r.lines.join("\n")).toContain("exists and is not an aihub file");
    expect(readFileSync(join(dir, "aihub.agent.md"), "utf8")).toContain("own");
    expect(existsSync(join(dir, "aihub-runner.agent.md"))).toBe(true);
  });

  it("uninstall removes the agents and the now empty folders", async () => {
    const { h, env } = fakeHome();
    await run(["skills", "install", "--global"], env);
    await run(["skills", "uninstall"], env);
    expect(existsSync(join(h, ".config", "opencode", "agent"))).toBe(false);
    expect(existsSync(join(h, ".copilot", "agents"))).toBe(false);
  });

  it("update refreshes agents that are installed", async () => {
    const { h, env } = fakeHome();
    await run(["skills", "install", "--global", "--client", "opencode"], env);
    const dir = join(h, ".config", "opencode", "agent");
    const f = join(dir, "aihub-runner.md");
    const stamped = readFileSync(f, "utf8");
    // an older aihub version in the marker, otherwise as aihub wrote it: update rewrites it
    writeFileSync(f, stamped.replace(/<!-- aihub \S+ -->/, "<!-- aihub 0.0.1 -->"));
    const man = join(dir, ".aihub-manifest.json");
    const m = JSON.parse(readFileSync(man, "utf8")) as { files: Record<string, string> };
    m.files["aihub-runner.md"] = createHash("sha256").update(readFileSync(f, "utf8"), "utf8").digest("hex");
    writeFileSync(man, JSON.stringify(m));
    await run(["skills", "update"], env);
    expect(readFileSync(f, "utf8")).toBe(stamped);
  });

  it("--into-repo writes .opencode/agent and .github/agents in the repository", async () => {
    const { env } = fakeHome();
    const { dir: repo } = makeRepo();
    const r = await run(["skills", "install", "--into-repo"], env, repo);
    expect(r.errs).toEqual([]);
    expect(existsSync(join(repo, ".opencode", "agent", "aihub.md"))).toBe(true);
    expect(existsSync(join(repo, ".github", "agents", "aihub.agent.md"))).toBe(true);
    expect(existsSync(join(repo, ".agents", "agents"))).toBe(false);
  });

  it("the opencode 1.x agent allows aihub and git and asks before force pushes and rm -rf (permission map)", async () => {
    const { h, env } = fakeHome();
    await run(["skills", "install", "--global", "--client", "opencode"], env);
    const text = readFileSync(join(h, ".config", "opencode", "agent", "aihub.md"), "utf8");
    expect(text).toContain("permission:\n  bash:\n");
    const effect = (pattern: string) => new RegExp(`^    "${pattern.replace(/[*]/g, "\\*")}": (\\w+)$`, "m").exec(text)?.[1];
    for (const r of ["aihub *", "git *", "az repos *", "az boards *", "az pipelines *"]) expect(effect(r), r).toBe("allow");
    for (const r of ["git push *--force*", "rm -rf*"]) expect(effect(r), r).toBe("ask");
  });

  it("opencode 2.x gets agents/ with a permissions list, and a switch moves the unmodified files", async () => {
    const { h, env } = fakeHome();
    const base = join(h, ".config", "opencode");
    await run(["skills", "install", "--global", "--client", "opencode"], env);
    expect(existsSync(join(base, "agent", "aihub.md"))).toBe(true);
    const v2 = { ...env, AIHUB_OPENCODE_VERSION: "2.0.1" };
    await run(["skills", "install", "--global", "--client", "opencode"], v2);
    const text = readFileSync(join(base, "agents", "aihub.md"), "utf8");
    expect(text).toContain("permissions:\n  - action: shell");
    expect(text).not.toContain("permission:\n  bash");
    expect(existsSync(join(base, "agent"))).toBe(false);
    // and back; uninstall finds either folder
    await run(["skills", "install", "--global", "--client", "opencode"], env);
    expect(existsSync(join(base, "agent", "aihub.md"))).toBe(true);
    expect(existsSync(join(base, "agents"))).toBe(false);
    await run(["skills", "install", "--global", "--client", "opencode"], v2);
    await run(["skills", "uninstall", "--client", "opencode"], env);
    expect(existsSync(join(base, "agents"))).toBe(false);
  });

  it("codex agents are TOML in CODEX_HOME/agents; claude is opt-in and gets skills, commands and agents", async () => {
    const { h, env } = fakeHome();
    await run(["skills", "install", "--global", "--client", "codex"], env);
    const toml = readFileSync(join(h, ".codex", "agents", "aihub-runner.toml"), "utf8");
    expect(toml).toMatch(/^# aihub \S+\nname = "aihub-runner"\n/);
    expect(toml).toContain('developer_instructions = """');
    await run(["skills", "install", "--global", "--client", "claude"], env);
    expect(existsSync(join(h, ".claude", "skills", "start-here", "SKILL.md"))).toBe(true);
    expect(existsSync(join(h, ".claude", "commands", "pr.md"))).toBe(true);
    const agent = readFileSync(join(h, ".claude", "agents", "aihub.md"), "utf8");
    expect(agent).toMatch(/^---\nname: aihub\n/);
    expect(agent).toContain("tools: Bash, Read");
    await run(["skills", "uninstall", "--client", "claude"], env);
    expect(existsSync(join(h, ".claude", "agents"))).toBe(false);
  });
});

describe("aihub doctor: agents", () => {
  type Row = { name: string; status: string; detail: string };
  async function doctor(env: NodeJS.ProcessEnv): Promise<Row[]> {
    const { ctx, lines } = ctxFor(tmp(), fakeFetch([]).fn);
    ctx.env = env;
    await main(["doctor", "--json"], ctx);
    const parsed = JSON.parse(lines.join("\n")) as Row[] | { checks: Row[] };
    return Array.isArray(parsed) ? parsed : parsed.checks;
  }

  it("reports agents as optional when absent and by folder when installed", async () => {
    const { env } = fakeHome();
    const by = (r: Row[], n: string) => r.find((c) => c.name === n)!;
    const before = await doctor(env);
    expect(by(before, "agents:opencode").status).toBe("OK");
    expect(by(before, "agents:opencode").detail).toContain("not installed");
    expect(by(before, "agents:codex").status).toBe("OK");
    expect(before.find((c) => c.name === "agents:claude")).toBeUndefined();
    await run(["skills", "install", "--global"], env);
    const after = await doctor(env);
    expect(by(after, "agents:opencode").detail).not.toContain("not installed");
    expect(by(after, "agents:opencode").detail).toContain("1.x format");
    expect(by(after, "agents:github-copilot").status).toBe("OK");
  });
});
