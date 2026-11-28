import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, tmp } from "./helpers.js";

function fakeHome() {
  const h = tmp("aihub-home-");
  const env: NodeJS.ProcessEnv = { HOME: h, USERPROFILE: h };
  return { h, env };
}

async function run(args: string[], env: NodeJS.ProcessEnv, cwd = tmp()) {
  const { ctx, lines, errs } = ctxFor(cwd, fakeFetch([]).fn);
  ctx.env = env;
  const code = await main(args, ctx);
  return { code, lines, errs };
}

describe("aihub skills install --global", () => {
  it("installs skills and commands for every client into fake homes", async () => {
    const { h, env } = fakeHome();
    const r = await run(["skills", "install", "--global"], env);
    expect(r.errs).toEqual([]);
    expect(r.code).toBe(0);
    expect(existsSync(join(h, ".config", "opencode", "skills", "start-here", "SKILL.md"))).toBe(true);
    expect(existsSync(join(h, ".config", "opencode", "command", "pr.md"))).toBe(true);
    expect(existsSync(join(h, ".codex", "skills", "start-here", "SKILL.md"))).toBe(true);
    expect(existsSync(join(h, ".codex", "prompts", "pr.md"))).toBe(true);
    expect(existsSync(join(h, ".copilot", "skills", "pr-create", "SKILL.md"))).toBe(true);
    // marker after the front matter, which stays first
    const skill = readFileSync(join(h, ".copilot", "skills", "pr-create", "SKILL.md"), "utf8");
    expect(skill.startsWith("---\n")).toBe(true);
    expect(skill).toMatch(/\n---\n<!-- aihub \S+ -->\n/);
  });

  it("puts the Copilot slash commands in VS Code's user prompts when VS Code is there, and nowhere when it is not", async () => {
    const { h, env } = fakeHome();
    const user = join(tmp(), "Code", "User");
    mkdirSync(user, { recursive: true });
    const r = await run(["skills", "install", "--global", "--client", "github-copilot"], { ...env, AIHUB_VSCODE_USER_DIR: user });
    expect(r.code).toBe(0);
    expect(existsSync(join(user, "prompts", "story-run.prompt.md"))).toBe(true);
    expect(existsSync(join(user, "prompts", "pr.prompt.md"))).toBe(true);
    const u = await run(["skills", "uninstall", "--global", "--client", "github-copilot"], { ...env, AIHUB_VSCODE_USER_DIR: user });
    expect(u.code).toBe(0);
    expect(existsSync(join(user, "prompts", "story-run.prompt.md"))).toBe(false);
    // no VS Code user folder: skills only, no prompt files anywhere
    const none = await run(["skills", "install", "--global", "--client", "github-copilot"], { ...env, AIHUB_VSCODE_USER_DIR: join(h, "no-vscode") });
    expect(none.code).toBe(0);
    expect(existsSync(join(h, "no-vscode"))).toBe(false);
  });
  it("respects OPENCODE_CONFIG_DIR, XDG_CONFIG_HOME and CODEX_HOME", async () => {
    const { h, env } = fakeHome();
    const oc = join(tmp(), "oc");
    const cx = join(tmp(), "cx");
    await run(["skills", "install", "--global", "--client", "opencode"], { ...env, OPENCODE_CONFIG_DIR: oc });
    expect(existsSync(join(oc, "skills", "start-here", "SKILL.md"))).toBe(true);
    const xdg = tmp();
    await run(["skills", "install", "--global", "--client", "opencode"], { ...env, XDG_CONFIG_HOME: xdg });
    expect(existsSync(join(xdg, "opencode", "command", "pr.md"))).toBe(true);
    await run(["skills", "install", "--global", "--client", "codex"], { ...env, CODEX_HOME: cx });
    expect(existsSync(join(cx, "prompts", "pr.md"))).toBe(true);
    expect(existsSync(join(h, ".codex"))).toBe(false);
  });

  it("is idempotent and never overwrites a file the user changed", async () => {
    const { h, env } = fakeHome();
    await run(["skills", "install", "--global", "--client", "opencode"], env);
    const file = join(h, ".config", "opencode", "skills", "pr-create", "SKILL.md");
    const second = await run(["skills", "install", "--global", "--client", "opencode"], env);
    expect(second.lines.join("\n")).toMatch(/created 0, updated 0/);
    writeFileSync(file, readFileSync(file, "utf8") + "\nMy team rule.\n", "utf8");
    const third = await run(["skills", "install", "--global", "--client", "opencode"], env);
    expect(readFileSync(file, "utf8")).toContain("My team rule.");
    expect(third.lines.join("\n")).toContain("changed by the user");
  });

  it("does not touch a foreign file with the same name", async () => {
    const { h, env } = fakeHome();
    const own = join(h, ".config", "opencode", "command", "pr.md");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(h, ".config", "opencode", "command"), { recursive: true });
    writeFileSync(own, "mine\n", "utf8");
    await run(["skills", "install", "--global", "--client", "opencode"], env);
    expect(readFileSync(own, "utf8")).toBe("mine\n");
    await run(["skills", "uninstall", "--global", "--client", "opencode"], env);
    expect(readFileSync(own, "utf8")).toBe("mine\n");
    expect(existsSync(join(h, ".config", "opencode", "skills"))).toBe(false);
  });

  it("uninstall removes only our unchanged files", async () => {
    const { h, env } = fakeHome();
    await run(["skills", "install", "--global"], env);
    const edited = join(h, ".codex", "skills", "pr-create", "SKILL.md");
    writeFileSync(edited, "changed\n", "utf8");
    writeFileSync(join(h, ".codex", "skills", "my-own.md"), "keep\n", "utf8");
    const r = await run(["skills", "uninstall", "--global"], env);
    expect(r.errs).toEqual([]);
    expect(existsSync(join(h, ".config", "opencode", "skills"))).toBe(false);
    expect(existsSync(join(h, ".copilot", "skills"))).toBe(false);
    expect(readFileSync(edited, "utf8")).toBe("changed\n");
    expect(existsSync(join(h, ".codex", "skills", "my-own.md"))).toBe(true);
    expect(existsSync(join(h, ".codex", "skills", "start-here"))).toBe(false);
  });

  it("--into-repo installs inside the repository", async () => {
    const { env } = fakeHome();
    const { dir } = makeRepo();
    const r = await run(["skills", "install", "--client", "github-copilot", "--into-repo"], env, dir);
    expect(r.errs).toEqual([]);
    expect(existsSync(join(dir, ".github", "skills", "start-here", "SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, ".github", "prompts", "pr.prompt.md"))).toBe(true);
  });

  it("update rewrites old copies of installed clients only and keeps edited files", async () => {
    const { h, env } = fakeHome();
    await run(["skills", "install", "--global", "--client", "codex"], env);
    const old = join(h, ".codex", "skills", "pr-create", "SKILL.md");
    const edited = join(h, ".codex", "skills", "pr-update", "SKILL.md");
    // simulate a copy written by an older aihub: same content, older marker, still unchanged since install
    const fs = await import("node:fs");
    const man = join(h, ".codex", "skills", ".aihub-manifest.json");
    const { createHash } = await import("node:crypto");
    const oldText = readFileSync(old, "utf8").replace(/aihub \S+ -->/, "aihub 0.0.1 -->");
    writeFileSync(old, oldText, "utf8");
    const m = JSON.parse(readFileSync(man, "utf8"));
    m.files["pr-create/SKILL.md"] = createHash("sha256").update(oldText, "utf8").digest("hex");
    writeFileSync(man, JSON.stringify(m), "utf8");
    writeFileSync(edited, readFileSync(edited, "utf8") + "\nMy rule.\n", "utf8");
    const r = await run(["skills", "update", "--global"], env);
    expect(r.errs).toEqual([]);
    expect(readFileSync(old, "utf8")).not.toContain("0.0.1");
    expect(readFileSync(edited, "utf8")).toContain("My rule.");
    expect(r.lines.join("\n")).toContain("changed by the user");
    expect(fs.existsSync(join(h, ".copilot"))).toBe(false); // not installed there, so not touched
  });

  it("update without any install explains what to do", async () => {
    const { env } = fakeHome();
    const r = await run(["skills", "update"], env);
    expect(r.code).toBe(1);
    expect(r.errs.join("")).toContain("aihub skills install");
  });
  it("rejects an unknown client", async () => {
    const { env } = fakeHome();
    const r = await run(["skills", "install", "--global", "--client", "nope"], env);
    expect(r.code).toBe(1);
    expect(r.errs.join("")).toContain("unknown client");
  });
});
