import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { ctxFor, fakeFetch, makeRepo, tmp } from "./helpers.js";
import { permissionState, skillsPattern } from "../src/lib/opencodePermission.js";

async function router(args: string[], env: NodeJS.ProcessEnv) {
  const { ctx, lines, errs } = ctxFor(tmp(), fakeFetch([]).fn);
  ctx.env = env;
  const code = await main(args, ctx);
  return { code, lines, errs };
}

function fakeHome() {
  const h = tmp("aihub-home-");
  const env: NodeJS.ProcessEnv = { HOME: h, USERPROFILE: h };
  const cfgDir = join(h, ".config", "opencode");
  return { h, env, cfgDir, cfg: join(cfgDir, "opencode.json"), pattern: skillsPattern(join(cfgDir, "skills")) };
}

const read = (f: string) => JSON.parse(readFileSync(f, "utf8"));

describe("aihub skills install --client opencode sets a scoped external_directory permission", () => {
  it("creates opencode.json with an allow for the skills folder only", async () => {
    const t = fakeHome();
    const r = await router(["skills", "install", "--client", "opencode"], t.env);
    expect(r.code).toBe(0);
    expect(r.lines.join("\n")).toContain("permission");
    expect(read(t.cfg).permission.external_directory).toEqual({ [t.pattern]: "allow" });
    expect(t.pattern.endsWith("/skills/**")).toBe(true);
    expect(JSON.stringify(read(t.cfg))).not.toContain('"external_directory":"allow"');
  });

  it("keeps the other keys, turns a string rule into the * rule, and is idempotent", async () => {
    const t = fakeHome();
    mkdirSync(t.cfgDir, { recursive: true });
    writeFileSync(t.cfg, JSON.stringify({ model: "openai/x", permission: { bash: "ask", external_directory: "ask" } }));
    await router(["skills", "install", "--client", "opencode"], t.env);
    const once = read(t.cfg);
    expect(once.model).toBe("openai/x");
    expect(once.permission.bash).toBe("ask");
    expect(once.permission.external_directory).toEqual({ "*": "ask", [t.pattern]: "allow" });
    const r2 = await router(["skills", "install", "--client", "opencode"], t.env);
    expect(read(t.cfg)).toEqual(once);
    expect(r2.lines.join("\n")).toMatch(/permission\n\s+created 0, updated 0, unchanged 1/);
  });

  it("does not edit a config with comments; it says what to add", async () => {
    const t = fakeHome();
    mkdirSync(t.cfgDir, { recursive: true });
    const text = '{\n  // my notes\n  "model": "x"\n}\n';
    writeFileSync(t.cfg, text);
    const r = await router(["skills", "install", "--client", "opencode"], t.env);
    expect(readFileSync(t.cfg, "utf8")).toBe(text);
    expect(r.lines.join("\n")).toContain('add "permission": {"external_directory"');
    expect(permissionState(t.env).state).toBe("unreadable");
  });

  it("an existing global allow is left alone", async () => {
    const t = fakeHome();
    mkdirSync(t.cfgDir, { recursive: true });
    writeFileSync(t.cfg, JSON.stringify({ permission: { external_directory: "allow" } }));
    await router(["skills", "install", "--client", "opencode"], t.env);
    expect(read(t.cfg).permission.external_directory).toBe("allow");
  });

  it("uninstall removes only our rule", async () => {
    const t = fakeHome();
    mkdirSync(t.cfgDir, { recursive: true });
    writeFileSync(t.cfg, JSON.stringify({ permission: { external_directory: { "/other/**": "allow" } } }));
    await router(["skills", "install", "--client", "opencode"], t.env);
    expect(Object.keys(read(t.cfg).permission.external_directory).sort()).toEqual(["/other/**", t.pattern].sort());
    await router(["skills", "uninstall", "--client", "opencode"], t.env);
    expect(read(t.cfg).permission.external_directory).toEqual({ "/other/**": "allow" });
  });

  it("uninstall deletes the permission block it created, and --dry-run writes nothing", async () => {
    const t = fakeHome();
    await router(["skills", "install", "--client", "opencode", "--dry-run"], t.env).catch(() => undefined);
    expect(existsSync(t.cfg)).toBe(false);
    await router(["skills", "install", "--client", "opencode"], t.env);
    await router(["skills", "uninstall", "--client", "opencode"], t.env);
    expect(read(t.cfg).permission).toBeUndefined();
  });

  it("OPENCODE_CONFIG_DIR is honoured", async () => {
    const t = fakeHome();
    const dir = join(tmp(), "oc");
    const env = { ...t.env, OPENCODE_CONFIG_DIR: dir };
    await router(["skills", "install", "--client", "opencode"], env);
    expect(read(join(dir, "opencode.json")).permission.external_directory[skillsPattern(join(dir, "skills"))]).toBe("allow");
    expect(existsSync(t.cfg)).toBe(false);
  });
});

describe("aihub doctor reports the opencode permission", () => {
  async function doctor(env: NodeJS.ProcessEnv) {
    const { dir } = makeRepo();
    const { ctx, lines } = ctxFor(dir, fakeFetch([]).fn);
    ctx.env = { ...ctx.env, ...env };
    await main(["doctor"], ctx);
    return lines.join("\n");
  }

  it("FIX before the permission exists, OK after the install", async () => {
    const t = fakeHome();
    await router(["skills", "install", "--client", "opencode"], t.env);
    writeFileSync(t.cfg, JSON.stringify({ model: "x" })); // the permission is gone
    expect(await doctor(t.env)).toMatch(/FIX\s+permission:opencode: opencode will ask before a skill reads its templates .* -> aihub skills install --client opencode/);
    await router(["skills", "install", "--client", "opencode"], t.env);
    expect(await doctor(t.env)).toMatch(/OK\s+permission:opencode: skills folder may be read without a prompt/);
  });

  it("no opencode skills installed: no permission check", async () => {
    const t = fakeHome();
    expect(await doctor(t.env)).not.toContain("permission:opencode");
  });
});
