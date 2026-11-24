import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/router.js";
import { decide, safeExclusionPath, safeExclusionProcess, type Facts } from "../src/lib/perfAdvisor.js";
import { applyFinding, readApplied, recordFile, undoApplied, type Runner } from "../src/lib/perfApply.js";

const home = "C:\\Users\\dev";
const repo = "C:\\git\\test-project";
const base = (over: Partial<Facts> = {}): Facts => ({
  platform: "win32",
  nodeStartMs: 60,
  gitStartMs: 40,
  avProbe: { scannedMs: 6, plainMs: 5 },
  defender: { realtime: true, exclusionsReadable: false },
  nodePath: "C:\\Program Files\\nodejs\\node.exe",
  gitPath: "C:\\Program Files\\Git\\cmd\\git.exe",
  home,
  repos: [{ path: repo, oneDrive: false, indexed: false, network: false, trackedFiles: 200, longestPath: 80, git: {} }],
  ...over,
});
const ids = (f: Facts) => decide(f).map((x) => x.id);
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

describe("advisor rules on simulated measurements", () => {
  it("finds nothing on a fast machine with a small local repository", () => {
    expect(decide(base())).toEqual([]);
  });

  it("suspects Defender only with slow starts AND a scan signal, and proposes narrow exclusions", () => {
    expect(ids(base({ gitStartMs: 240 }))).toEqual(["defender"]); // real-time on
    expect(ids(base({ gitStartMs: 240, defender: undefined, avProbe: { scannedMs: 40, plainMs: 6 } }))).toEqual(["defender"]); // other antivirus, measured
    expect(ids(base({ gitStartMs: 240, defender: undefined }))).toEqual([]); // slow, but no sign of scanning: no guess
    expect(ids(base({ defender: { realtime: true, exclusionsReadable: true }, avProbe: { scannedMs: 60, plainMs: 5 } }))).toEqual([]); // scanning, but fast enough
    const d = decide(base({ gitStartMs: 240, nodeStartMs: 420 }))[0];
    expect(d).toMatchObject({ scope: "admin", cause: "defender" });
    expect(d.evidence.join(" ")).toMatch(/git starts in 240 ms.*node starts in 420 ms|node starts in 420 ms/);
    expect(d.apply[0]).toBe("Add-MpPreference -ExclusionPath 'C:\\git\\test-project' -ExclusionProcess 'C:\\Program Files\\nodejs\\node.exe','C:\\Program Files\\Git\\cmd\\git.exe'");
    expect(d.revert[0]).toMatch(/^Remove-MpPreference -ExclusionPath 'C:\\git\\test-project'/);
    expect(d.itRequest).toBeUndefined();
  });

  it("uses the performance log as evidence too", () => {
    const d = decide(base({ logGitMs: 180 }))[0];
    expect(d.id).toBe("defender");
    expect(d.evidence[0]).toMatch(/git calls of aihub took 180 ms/);
  });

  it("never proposes a broad path, and skips what is already excluded", () => {
    const broad = base({ gitStartMs: 240, repos: [{ path: "C:\\", oneDrive: false, network: false, git: {} }, { path: home, oneDrive: false, network: false, git: {} }] });
    const d = decide(broad)[0];
    expect(d.apply[0]).not.toMatch(/ExclusionPath/); // only the node/git processes remain
    const done = decide(base({ gitStartMs: 240, nodePath: undefined, gitPath: undefined, defender: { realtime: true, exclusionsReadable: true, exclusionPaths: [repo] } }));
    expect(done).toEqual([]);
  });

  it("gives an IT request text when Defender is managed by policy", () => {
    const d = decide(base({ gitStartMs: 240, defender: { realtime: true, managedByPolicy: true, exclusionsReadable: false } }))[0];
    expect(d.itRequest).toMatch(/Request: Microsoft Defender exclusions/);
    expect(d.itRequest).toContain(`- folder: ${repo}`);
    expect(d.itRequest).toContain("git starts in 240 ms");
  });

  it("finds OneDrive, network drives, indexing, git settings for large repositories and long paths, each with evidence", () => {
    const f = base({ repos: [{ path: repo, oneDrive: true, indexed: true, network: true, trackedFiles: 12000, longestPath: 250, git: { "core.fscache": "false" } }] });
    const found = decide(f);
    expect(found.map((x) => x.id)).toEqual(["onedrive:test-project", "network:test-project", "indexing:test-project", "git:test-project", "longpaths:test-project"]);
    for (const x of found) expect(x.evidence.length).toBeGreaterThan(0);
    const git = found.find((x) => x.cause === "git")!;
    expect(git.apply).toEqual([
      `git -C "${repo}" config core.fsmonitor true`,
      `git -C "${repo}" config core.untrackedCache true`,
      `git -C "${repo}" config feature.manyFiles true`,
      `git -C "${repo}" config core.fscache true`,
    ]);
    expect(git.revert[0]).toBe(`git -C "${repo}" config --unset core.fsmonitor`);
    expect(found.find((x) => x.cause === "indexing")!.apply).toEqual([`attrib +I "${repo}" /S /D`]);
    expect(found.filter((x) => x.scope === "info").map((x) => x.cause)).toEqual(["onedrive", "network"]);
  });

  it("leaves git alone when the settings are on or the repository is small", () => {
    expect(ids(base({ repos: [{ path: repo, oneDrive: false, network: false, trackedFiles: 12000, git: { "core.fsmonitor": "true", "core.untrackedcache": "true", "feature.manyfiles": "true" } }] }))).toEqual([]);
    expect(ids(base({ repos: [{ path: repo, oneDrive: false, network: false, trackedFiles: 4000, git: {} }] }))).toEqual([]);
  });

  it("only allows narrow exclusions", () => {
    for (const p of ["C:\\", "C:\\Users", home, "C:\\Users\\dev\\", "C:\\Windows\\System32\\x", "C:\\Program Files\\x\\y", "relative\\path", "C:\\git\\*"]) expect(safeExclusionPath(p, home), p).toBe(false);
    for (const p of [repo, "C:\\Users\\dev\\source\\repo-a", "D:\\work\\repos\\b"]) expect(safeExclusionPath(p, home), p).toBe(true);
    expect(safeExclusionProcess("C:\\Program Files\\nodejs\\node.exe")).toBe(true);
    expect(safeExclusionProcess("C:\\Windows\\System32\\cmd.exe")).toBe(false);
    expect(safeExclusionProcess("node.exe")).toBe(false);
  });
});

describe("apply and undo", () => {
  const indexing = () => decide(base({ repos: [{ path: repo, oneDrive: false, indexed: true, network: false, git: {} }] }))[0];

  it("runs a user change directly, records it with its undo, and undoes it", () => {
    const env = { AIHUB_HOME: tmp("aihub-home-") };
    const ran: [string, boolean][] = [];
    const run: Runner = (c, admin) => (ran.push([c, admin]), { ok: true, output: "" });
    applyFinding(env, indexing(), { run, now: () => 0 });
    expect(ran).toEqual([[`attrib +I "${repo}" /S /D`, false]]);
    expect(readApplied(env)).toMatchObject([{ id: "indexing:test-project", scope: "user", revert: [`attrib -I "${repo}" /S /D`] }]);
    expect(JSON.parse(readFileSync(recordFile(env), "utf8")).applied).toHaveLength(1);
    undoApplied(env, "indexing:test-project", { run });
    expect(ran[1]).toEqual([`attrib -I "${repo}" /S /D`, false]);
    expect(readApplied(env)).toEqual([]);
  });

  it("never runs an administrator change without elevate; a dry-run only shows it", () => {
    const env = { AIHUB_HOME: tmp("aihub-home-") };
    const d = decide(base({ gitStartMs: 240 }))[0];
    let calls = 0;
    const run: Runner = () => (calls++, { ok: true, output: "" });
    expect(() => applyFinding(env, d, { run })).toThrow(/needs an administrator/);
    expect(applyFinding(env, d, { run, dryRun: true }).join("\n")).toMatch(/would run as administrator \(UAC prompt\):\n  Add-MpPreference/);
    expect(calls).toBe(0);
    applyFinding(env, d, { run, elevate: true });
    expect(calls).toBe(1);
    expect(() => undoApplied(env, "defender", { run })).toThrow(/needs an administrator/);
  });

  it("refuses to apply an information-only finding", () => {
    const od = decide(base({ repos: [{ path: repo, oneDrive: true, network: false, git: {} }] }))[0];
    expect(() => applyFinding({ AIHUB_HOME: tmp("h-") }, od, { run: () => ({ ok: true, output: "" }) })).toThrow(/nothing to apply/);
  });
});

describe("aihub doctor --perf", () => {
  it("prints the findings with evidence, change, risk, undo and the apply command, and the JSON", async () => {
    const lines: string[] = [];
    const ctx = { cwd: ".", env: { AIHUB_HOME: tmp("aihub-home-") }, fetch, out: (l: string) => lines.push(l), err: (l: string) => lines.push(`ERR ${l}`), perfFacts: () => base({ gitStartMs: 240 }) } as never;
    const code = await main(["doctor", "--perf"], ctx);
    expect(code, lines.join("\n")).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("defender [admin]");
    expect(text).toContain("evidence: git starts in 240 ms");
    expect(text).toContain("apply: aihub doctor --perf --apply defender --elevate");
    lines.length = 0;
    expect(await main(["doctor", "--perf", "--json"], ctx)).toBe(0);
    const j = JSON.parse(lines.join(""));
    expect(j.findings.map((f: { id: string }) => f.id)).toEqual(["defender"]);
    expect(j.facts.home).toBeUndefined();
    lines.length = 0;
    expect(await main(["doctor", "--perf", "--apply", "defender", "--dry-run"], ctx)).toBe(0);
    expect(lines.join("\n")).toMatch(/dry-run: would run as administrator/);
  });
});
