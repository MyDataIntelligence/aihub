import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { makeRepo } from "./helpers.js";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(cli, "dist", "cli.js");
const version = (JSON.parse(readFileSync(join(cli, "package.json"), "utf8")) as { version: string }).version;

beforeAll(() => {
  const tsc = join(cli, "node_modules", "typescript", "bin", "tsc");
  expect(spawnSync(process.execPath, [tsc, "-p", "tsconfig.json"], { cwd: cli, encoding: "utf8" }).status).toBe(0);
  expect(spawnSync(process.execPath, [join(cli, "scripts", "copy-pack.mjs")], { cwd: cli, encoding: "utf8" }).status).toBe(0);
}, 120_000);

const run = (args: string[], cwd: string, env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });

describe("built cli", () => {
  it("prints the package.json version, not a hard-coded one", () => {
    const r = run(["--version"], cli);
    expect(r.stdout.trim()).toBe(version);
    expect(run(["--help"], cli).stdout).toContain(`aihub ${version}:`);
  });

  it("doctor --json works in a temp repository", () => {
    const { dir } = makeRepo();
    const r = run(["doctor", "--json"], dir, { AIHUB_ADO_PAT: "synthetic" });
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout) as { checks: { name: string; status: string }[] };
    expect(j.checks.find((c) => c.name === "auth")?.status).toBe("OK");
    expect(j.checks.find((c) => c.name === "team.yaml")?.status).toBe("FIX");
  });

  it("npm pack lists the bundled skills and commands", () => {
    const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: cli, encoding: "utf8", shell: true });
    expect(r.status).toBe(0);
    const files = (JSON.parse(r.stdout)[0].files as { path: string }[]).map((f) => f.path.replace(/\\/g, "/"));
    expect(files).toContain("pack/skills/start-here/SKILL.md");
    expect(files).toContain("pack/skills/_shared/references/team.schema.yaml");
    expect(files).toContain("pack/commands/opencode/pr.md");
    expect(files).toContain("pack/team-pack/.agents/skills/_shared/references/team.yaml");
    expect(files).toContain("pack/CHANGELOG.md");
    expect(files).toContain("dist/cli.js");
  });
});
