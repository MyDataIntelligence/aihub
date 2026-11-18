import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const has = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: "utf8" }).status === 0;
const ps = ["powershell", "pwsh"].find((c) => has(c, ["-NoProfile", "-Command", "exit 0"]));
const sh = has("sh", ["-c", "exit 0"]);

const PLAN = ["check that Node 18 or newer", "npm i -g @ferronhooi/aihub@latest", "aihub skills install --global --client all", "aihub doctor"];

describe("installers", () => {
  it.skipIf(!ps)("install.ps1 -WhatIf prints the plan and runs nothing", () => {
    const r = spawnSync(ps!, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "install.ps1"), "-WhatIf"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    for (const p of PLAN) expect(r.stdout).toContain(`PLAN: ${p}`);
    expect(r.stdout).not.toContain("==>");
  });

  it.skipIf(!ps)("install.ps1 -WhatIf -Next -Uninstall, and a team package from the environment", () => {
    const run = (args: string[], env: Record<string, string> = {}) =>
      spawnSync(ps!, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "install.ps1"), ...args], { encoding: "utf8", env: { ...process.env, ...env } }).stdout;
    expect(run(["-WhatIf", "-Next"])).toContain("npm i -g @ferronhooi/aihub@next");
    expect(run(["-WhatIf"], { AIHUB_PACKAGE: "@org/aihub" })).toContain("PLAN: npm i -g @org/aihub@latest");
    const un = run(["-WhatIf", "-Uninstall"]);
    expect(un).toContain("PLAN: aihub skills uninstall");
    expect(un).toContain("PLAN: npm rm -g @ferronhooi/aihub");
  });

  it.skipIf(!sh)("install.sh --dry-run prints the same plan and runs nothing", () => {
    const r = spawnSync("sh", [join(root, "install.sh"), "--dry-run"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    for (const p of PLAN) expect(r.stdout).toContain(`PLAN: ${p}`);
    expect(r.stdout).not.toContain("==>");
    expect(spawnSync("sh", [join(root, "install.sh"), "--dry-run", "--next"], { encoding: "utf8" }).stdout).toContain("@next");
    expect(spawnSync("sh", [join(root, "install.sh"), "--dry-run", "--uninstall"], { encoding: "utf8" }).stdout).toContain("PLAN: aihub skills uninstall");
    expect(spawnSync("sh", [join(root, "install.sh"), "--bogus"], { encoding: "utf8" }).status).toBe(2);
  });

  it("the cmd launcher runs install.ps1 with the execution policy bypassed and passes the flags on", () => {
    const cmd = readFileSync(join(root, "Install-aihub.cmd"), "utf8");
    expect(cmd).toContain("-ExecutionPolicy Bypass");
    expect(cmd).toContain("install.ps1");
    expect(cmd).toContain("%*");
  });

  it("never installs Node silently", () => {
    for (const f of ["install.ps1", "install.sh"]) {
      const t = readFileSync(join(root, f), "utf8");
      expect(t).not.toMatch(/^\s*&?\s*(winget|brew)\s+install/m);
    }
  });
});