import { describe, expect, it } from "vitest";
import { checkCli, CliError, killTree, makeRunner, readJson, versionAtLeast } from "../src/cli";
import { stubRunner } from "./helpers";

describe("versionAtLeast", () => {
  it("compares major, minor and patch", () => {
    expect(versionAtLeast("1.0.2", "1.0.2")).toBe(true);
    expect(versionAtLeast("1.0.10", "1.0.2")).toBe(true);
    expect(versionAtLeast("1.0.1", "1.0.2")).toBe(false);
    expect(versionAtLeast("2.0.0", "1.9.9")).toBe(true);
    expect(versionAtLeast("1.1.0-next.5", "1.0.2")).toBe(true);
  });
});

describe("runner", () => {
  it("ends at its time limit even when a process it started keeps the output open (a git push waiting for a sign-in)", async () => {
    // the CLI stands in as node: it starts a grandchild that holds stdout for 6 s and exits itself at once
    const script = "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6000)'], { stdio: 'inherit' })";
    const run = makeRunner({ command: process.execPath, prefixArgs: ["-e", script], timeoutMs: 800 });
    const t0 = Date.now();
    await expect(run(["pr", "create"], process.cwd())).rejects.toMatchObject({ kind: "timeout", message: expect.stringContaining("took longer than") });
    expect(Date.now() - t0).toBeLessThan(4000);
  }, 10_000);

  it("a timed-out call stops the whole process tree on Windows (taskkill /T), elsewhere the child", () => {
    const killed: string[] = [];
    killTree({ pid: undefined, kill: (s?: NodeJS.Signals | number) => (killed.push(String(s)), true) }, "linux");
    expect(killed).toEqual(["SIGKILL"]);
    const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "../src/cli.ts"), "utf8") as string;
    expect(src).toMatch(/spawn\("taskkill", \["\/T", "\/F", "\/PID", String\(child\.pid\)\]/);
  });

  it("parses JSON from a command", async () => {
    const s = await readJson<{ branch: string }>(stubRunner(), ["status"], process.cwd());
    expect(s.branch).toBe("feat/1234-add-export");
  });

  it("says missing, with the install command, when the command does not exist", async () => {
    const run = makeRunner({ command: "aihub-does-not-exist-xyz", timeoutMs: 5000 }, "linux");
    await expect(run(["--version"], process.cwd())).rejects.toMatchObject({ kind: "missing", message: expect.stringContaining("npm i -g @ferronhooi/aihub") });
  });

  it("times out", async () => {
    const run = stubRunner({ FAKE_AIHUB_SLEEP: "3000" }, 300);
    await expect(run(["status"], process.cwd())).rejects.toMatchObject({ kind: "timeout" });
  });

  it("reports a failing command with its last stderr line", async () => {
    const run = stubRunner({ FAKE_AIHUB_FAIL: "status" });
    await expect(run(["status"], process.cwd())).rejects.toMatchObject({ kind: "failed", message: expect.stringContaining("no single workspace") });
  });

  it("rejects an old CLI with the update command", async () => {
    await expect(checkCli(stubRunner({ FAKE_AIHUB_VERSION: "0.9.0" }), process.cwd())).rejects.toMatchObject({ kind: "old", message: expect.stringContaining("npm i -g") });
    await expect(checkCli(stubRunner(), process.cwd())).resolves.toBe("1.0.2");
  });

  it("fails with a CliError for an unknown command", async () => {
    await expect(readJson(stubRunner(), ["nope"], process.cwd())).rejects.toBeInstanceOf(CliError);
  });
});

describe("the CLI version check", () => {
  it("is skipped for a day once the same command was new enough", async () => {
    const { cliVersionStillKnown } = await import("../src/cli");
    const known = { command: "aihub", version: "1.0.9", at: 1_000_000 };
    expect(cliVersionStillKnown(known, "aihub", 1_000_000 + 3_600_000)).toBe(true);
    expect(cliVersionStillKnown(known, "aihub", 1_000_000 + 25 * 3_600_000)).toBe(false);
    expect(cliVersionStillKnown(known, "C:/tools/aihub.cmd", 1_000_001)).toBe(false);
    expect(cliVersionStillKnown({ ...known, version: "0.9.0" }, "aihub", 1_000_001)).toBe(false);
    expect(cliVersionStillKnown(undefined, "aihub", 1)).toBe(false);
  });
});
