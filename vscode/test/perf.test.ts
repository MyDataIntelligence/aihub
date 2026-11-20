import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { makeRunner } from "../src/cli";
import { fileDay, PerfLog, readEvents, type PerfEvent } from "../src/perf/log";
import { clearTrackedInterval, count, resetProbe, setPerfLog, span, startMonitor, subcommand, trackedExecFile, trackedInterval, trackedWatcher } from "../src/perf/probe";
import { findSecrets, Scrubber } from "../src/perf/scrub";
import { renderReport, summarize, summaryLine } from "../src/perf/summary";
import { instrumentApi } from "../src/perf/instrument";
import { Refresher } from "../src/refresher";
import { buildModel } from "../src/model";
import { STUB } from "./helpers";

const tmp = () => mkdtempSync(join(tmpdir(), "aihub-perf-"));
const lines = (dir: string) =>
  readdirSync(dir)
    .filter((n) => n.endsWith(".jsonl"))
    .flatMap((n) => readFileSync(join(dir, n), "utf8").split("\n").filter(Boolean))
    .map((l) => JSON.parse(l) as PerfEvent);
const allText = (dir: string) => readdirSync(dir).map((n) => readFileSync(join(dir, n), "utf8")).join("\n");

// synthetic secrets only: shaped like the real ones so the patterns must catch them
const PAT = "abcdefghij0123456789klmnopqrstuvwxyz0123456789abcdef"; // 52 chars like an Azure DevOps PAT
const GH = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0LXVzZXIifQ.c2lnbmF0dXJlLXRlc3Q";
const MAIL = "dev.person@example.test";

afterEach(() => {
  setPerfLog(undefined);
  resetProbe();
});

describe("Scrubber", () => {
  const s = new Scrubber({ roots: ["C:\\work\\test-project"], home: "C:\\Users\\someone" });

  it("removes tokens, PATs, JWTs, bearer headers and e-mail addresses", () => {
    const out = s.text(`token ${PAT} gh ${GH} jwt ${JWT} Authorization: Bearer ${PAT} mail ${MAIL} AIHUB_ADO_PAT=${PAT}`);
    expect(out).not.toContain(PAT);
    expect(out).not.toContain(GH);
    expect(out).not.toContain(JWT);
    expect(out).not.toContain(MAIL);
    expect(findSecrets(out)).toEqual([]);
    expect(out).toContain("<email>");
  });

  it("drops URL queries and user info but keeps host and path", () => {
    expect(s.text("GET https://user:pw@dev.azure.com/ferron-test/_apis/git?api-version=7.1&sig=abc")).toBe("GET https://dev.azure.com/ferron-test/_apis/git");
  });

  it("masks the value after a secret flag and free text after -m, keeps the rest", () => {
    expect(s.args(["commit", "-m", "fix for the order report", "--token", PAT, "--pat=" + PAT, "--json"])).toEqual(["commit", "-m", "<text>", "--token", "<redacted>", "--pat=<redacted>", "--json"]);
    expect(s.args(["comments", "reply", "--reply", "12:fixed:done, see the diff"])).toEqual(["comments", "reply", "--reply", "<text>"]);
  });

  it("makes paths relative to the workspace and the home folder ~, in both slash styles", () => {
    expect(s.text("C:\\work\\test-project\\src\\a.py")).toBe("src\\a.py");
    expect(s.text("c:/work/test-project/src/a.py")).toBe("src/a.py");
    expect(s.text("C:\\work\\test-project")).toBe(".");
    expect(s.text("C:\\Users\\someone\\git\\other")).toBe("~\\git\\other");
  });

  it("keeps git object ids, plain words and normal args", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(s.args(["rev-parse", sha, "--abbrev-ref", "HEAD", "refs/heads/feature/12345-add-a-rather-long-branch-name"])).toEqual(["rev-parse", sha, "--abbrev-ref", "HEAD", "refs/heads/feature/12345-add-a-rather-long-branch-name"]);
    expect(s.text("path=src/x.py")).toBe("path=src/x.py");
  });
});

describe("PerfLog", () => {
  it("buffers writes and only touches the disk on flush", async () => {
    const dir = tmp();
    const log = new PerfLog({ dir, flushMs: 60_000, flushAt: 1000 });
    for (let i = 0; i < 10; i++) log.write("x", { i });
    expect(readdirSync(dir)).toEqual([]);
    await log.flush();
    expect(lines(dir).map((e) => e.i)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await log.dispose();
  });

  it("starts a flush by itself when the buffer reaches flushAt", async () => {
    const dir = tmp();
    const log = new PerfLog({ dir, flushMs: 60_000, flushAt: 5 });
    for (let i = 0; i < 5; i++) log.write("x", { i });
    await log.flush();
    expect(lines(dir)).toHaveLength(5);
    await log.dispose();
  });

  it("stops at the day limit with one log.cap line and counts what it dropped", async () => {
    const dir = tmp();
    const log = new PerfLog({ dir, flushMs: 60_000, maxBytesPerDay: 2000 });
    for (let i = 0; i < 100; i++) log.write("x", { pad: "y".repeat(50), i });
    await log.flush();
    log.write("x", { after: true });
    await log.flush();
    const ev = lines(dir);
    expect(ev.filter((e) => e.type === "log.cap")).toHaveLength(1);
    expect(ev.some((e) => e.after)).toBe(false);
    expect(log.dropped).toBeGreaterThan(50);
    const size = readdirSync(dir).reduce((n, f) => n + readFileSync(join(dir, f)).length, 0);
    expect(size).toBeLessThan(2000 + 300);
    await log.dispose();
  });

  it("writes one file per day and deletes files older than 7 days", async () => {
    const dir = tmp();
    const day = 86_400_000;
    let now = new Date(2026, 10, 20, 23, 59, 59).getTime();
    for (const back of [3, 6, 7, 10]) writeFileSync(join(dir, `aihub-perf-${fileDay(now - back * day)}.jsonl`), "{}\n");
    const log = new PerfLog({ dir, flushMs: 60_000, now: () => now });
    log.write("late");
    now += 2000; // past midnight
    log.write("early");
    await log.flush();
    const names = readdirSync(dir).sort();
    // the flush ran on the 21st: the 7 days kept are the 15th to the 21st
    expect(names).toEqual([3, 0, -1].map((b) => `aihub-perf-${fileDay(new Date(2026, 10, 20, 12).getTime() - b * day)}.jsonl`).sort());
    expect((await readEvents(dir, 0, now)).map((e) => e.type).filter((t) => t)).toEqual(expect.arrayContaining(["late", "early"]));
    await log.dispose();
  });
});

describe("the log never holds a token", () => {
  it("masks what a child process, a notification and a command carry, end to end on disk", async () => {
    const dir = tmp();
    const root = tmp();
    const log = new PerfLog({ dir, flushMs: 60_000, scrubber: new Scrubber({ roots: [root] }) });
    setPerfLog(log);
    const run = makeRunner({ command: process.execPath, prefixArgs: [STUB], timeoutMs: 10_000 });
    await run(["--version", "--token", PAT, `--note=${MAIL}`, `https://x.test/a?access_token=${PAT}`, GH], root).catch(() => undefined);
    const fakeApi = { commands: { registerCommand: (_id: string, cb: (...a: unknown[]) => unknown) => ({ dispose() {}, cb }) as never }, window: { showErrorMessage: async (m: string) => m } as Record<string, unknown> };
    instrumentApi(fakeApi);
    await (fakeApi.window.showErrorMessage as (m: string) => Promise<string>)(`Push failed for ${MAIL}: remote said Bearer ${JWT}`);
    span("task", `sync ${GH}`, { url: `https://dev.azure.com/ferron-test/_apis?sig=${PAT}` })(true);
    await log.dispose();
    const text = allText(dir);
    for (const secret of [PAT, GH, JWT, MAIL, root]) expect(text).not.toContain(secret);
    expect(findSecrets(text)).toEqual([]);
    const proc = lines(dir).find((e) => e.type === "proc")!;
    expect(proc).toMatchObject({ cmd: "aihub", cwd: ".", windowsHide: true });
  });
});

describe("probe", () => {
  it("logs each child process with its program, duration, exit code, windowsHide and parallel count", async () => {
    const dir = tmp();
    const log = new PerfLog({ dir, flushMs: 60_000 });
    setPerfLog(log);
    const run = (args: string[]) => new Promise<void>((ok) => trackedExecFile(process.execPath, args, { windowsHide: true }, () => ok(), { cmd: "git", args: ["status", "--porcelain"] }));
    await Promise.all([run(["-e", "1"]), run(["-e", "setTimeout(()=>{},200)"]), run(["-e", "process.exit(3)"])]);
    const mon = startMonitor(60_000);
    mon.sample();
    mon.stop();
    await log.dispose();
    const ev = lines(dir);
    const procs = ev.filter((e) => e.type === "proc");
    expect(procs).toHaveLength(3);
    expect(procs.every((p) => p.cmd === "git" && p.sub === "status" && p.windowsHide === true && typeof p.ms === "number")).toBe(true);
    expect(procs.map((p) => p.code).sort()).toEqual([0, 0, 3]);
    expect(Math.max(...procs.map((p) => p.parallel as number))).toBe(3);
    const sample = ev.find((e) => e.type === "sample")!;
    expect(sample.procs).toMatchObject({ spawned: 3, failed: 1, maxParallel: 3 });
  });

  it("lists timers with interval and fires, watchers with glob and events, and counters, in the sample", async () => {
    const dir = tmp();
    const log = new PerfLog({ dir, flushMs: 60_000 });
    setPerfLog(log);
    const h = trackedInterval("bar.refresh", () => undefined, 10);
    const w = trackedWatcher("bar.gitBranch", ".git/{HEAD,refs/heads/**}");
    w.hit();
    w.hit();
    count("refresh.skip.timer.unfocused", 4);
    await new Promise((r) => setTimeout(r, 60));
    const mon = startMonitor(60_000);
    mon.sample();
    mon.stop();
    clearTrackedInterval(h);
    await log.dispose();
    const s = lines(dir).find((e) => e.type === "sample")!;
    const timer = (s.timers as { name: string; ms: number; fires: number }[]).find((t) => t.name === "bar.refresh")!;
    expect(timer.ms).toBe(10);
    expect(timer.fires).toBeGreaterThan(2);
    expect(s.watchers).toEqual([{ name: "bar.gitBranch", glob: ".git/{HEAD,refs/heads/**}", events: 2 }]);
    expect(s.counters).toEqual({ "refresh.skip.timer.unfocused": 4 });
    expect(s.loop === undefined || typeof (s.loop as { p99: number }).p99 === "number").toBe(true);
    expect((s.mem as { rssMb: number }).rssMb).toBeGreaterThan(0);
  });

  it("names the subcommand of git and aihub calls", () => {
    expect(subcommand("git", ["-C", "x", "status", "--porcelain"])).toBe("status");
    expect(subcommand("aihub", ["pr", "checks", "--pr", "12", "--json"])).toBe("pr checks");
    expect(subcommand("aihub", ["--version"])).toBe("");
  });

  it("is a no-op without a log", async () => {
    const end = span("x", "y");
    end(true);
    count("z");
    await new Promise<void>((ok) => trackedExecFile(process.execPath, ["-e", "1"], {}, () => ok()));
  });

  it("logs every status read with its trigger, and the skipped ones as counts", async () => {
    const dir = tmp();
    const log = new PerfLog({ dir, flushMs: 60_000 });
    setPerfLog(log);
    const r = new Refresher(async () => buildModel({ status: { branch: "x" } }), () => undefined, { minGapMs: () => 60_000 });
    await r.request("start");
    await r.request("timer"); // still fresh: skipped
    r.focused = false;
    await r.request("focus"); // not focused: skipped
    const mon = startMonitor(60_000);
    mon.sample();
    mon.stop();
    await log.dispose();
    const ev = lines(dir);
    expect(ev.filter((e) => e.type === "refresh").map((e) => [e.reason, e.ok])).toEqual([["start", true]]);
    expect(ev.find((e) => e.type === "sample")!.counters).toEqual({ "refresh.skip.timer.fresh": 1, "refresh.skip.focus.unfocused": 1 });
  });
});

describe("instrumentApi", () => {
  it("times every registered command and logs every notification", async () => {
    const dir = tmp();
    const log = new PerfLog({ dir, flushMs: 60_000 });
    setPerfLog(log);
    const registered = new Map<string, (...a: unknown[]) => unknown>();
    const api = {
      commands: { registerCommand: (id: string, cb: (...a: unknown[]) => unknown) => (registered.set(id, cb), { dispose() {} }) },
      window: { showInformationMessage: async () => undefined, showWarningMessage: async () => undefined, showErrorMessage: async () => undefined } as Record<string, unknown>,
    };
    expect(instrumentApi(api)).toEqual({ commands: true, notifications: true });
    api.commands.registerCommand("aihub.ok", async () => new Promise((r) => setTimeout(r, 30)));
    api.commands.registerCommand("aihub.bad", () => {
      throw new Error("x");
    });
    await registered.get("aihub.ok")!();
    expect(() => registered.get("aihub.bad")!()).toThrow("x");
    await (api.window.showWarningMessage as (m: string, o: object) => Promise<void>)("Remove the set?\nmore", { modal: true });
    await log.dispose();
    const ev = lines(dir);
    const ok = ev.find((e) => e.type === "cmd" && e.name === "aihub.ok")!;
    expect(ok.ok).toBe(true);
    expect(ok.ms as number).toBeGreaterThanOrEqual(20);
    expect(ev.find((e) => e.type === "cmd" && e.name === "aihub.bad")!.ok).toBe(false);
    expect(ev.find((e) => e.type === "notify")).toMatchObject({ level: "warning", text: "Remove the set?", modal: true });
  });

  it("reports false when the API object cannot be changed", () => {
    const api = Object.freeze({ commands: Object.freeze({ registerCommand: () => ({ dispose() {} }) }), window: Object.freeze({ showInformationMessage: () => undefined }) });
    expect(instrumentApi(api as never)).toEqual({ commands: false, notifications: false });
  });
});

describe("summary and report", () => {
  const t0 = new Date(2026, 10, 20, 10, 0, 0).getTime();
  const ev: PerfEvent[] = [
    { t: t0, type: "activate", ms: 180, phases: { "perf.setup": 5, bar: 40, commands: 20 }, activationEvents: ["onStartupFinished"], hostUptimeMs: 9000 },
    { t: t0 + 2500, type: "activate.firstRefresh", ms: 2600, ok: true },
    ...Array.from({ length: 12 }, (_, i): PerfEvent => ({ t: t0 + 60_000 + i * 1000, type: "proc", cmd: "aihub", sub: "status", args: ["status", "--json"], ms: 900 + i * 100, code: 0, ok: true, windowsHide: true, parallel: 1 + (i % 4) })),
    { t: t0 + 200_000, type: "proc", cmd: "git", sub: "status", args: ["status"], ms: 40, code: 128, ok: false, windowsHide: false, parallel: 1 },
    { t: t0 + 61_000, type: "refresh", name: "status", reason: "start", ms: 4100, ok: true },
    { t: t0 + 300_000, type: "cmd", name: "aihub.refresh", ms: 2200, ok: true },
    { t: t0 + 300_500, type: "notify", level: "info", text: "Pushed feature/x." },
    { t: t0 + 300_600, type: "notify", level: "info", text: "Pushed feature/x." },
    { t: t0 + 120_000, type: "sample", loop: { p50: 10, p99: 25, max: 80 }, cpu: { pct: 3 }, mem: { rssMb: 300, heapMb: 90 }, procs: { maxParallel: 4 }, timers: [{ name: "bar.refresh", kind: "interval", ms: 60_000, fires: 2, busyMs: 1 }], watchers: [{ name: "bar.gitBranch", glob: ".git/HEAD", events: 3 }], counters: { "refresh.skip.timer.unfocused": 5, "event.activeEditor": 7 } },
    { t: t0 + 180_000, type: "sample", loop: { p50: 11, p99: 41, max: 120 }, cpu: { pct: 9 }, mem: { rssMb: 320, heapMb: 95 }, procs: { maxParallel: 2 }, timers: [{ name: "bar.refresh", kind: "interval", ms: 60_000, fires: 1, busyMs: 1 }], watchers: [], counters: {} },
  ];
  const s = summarize(ev, t0, t0 + 3_600_000);

  it("finds the activation, the slowest actions, processes per minute, p99, timers and notifications", () => {
    expect(s.activation).toMatchObject({ ms: 180, firstRefreshMs: 2600, events: ["onStartupFinished"], hostUptimeMs: 9000 });
    expect(s.slowest[0]).toMatchObject({ type: "refresh", ms: 4100 });
    expect(s.slowest).toHaveLength(10);
    expect(s.procs).toMatchObject({ total: 13, failed: 1, noHide: 1, maxParallel: 4, perMinuteMax: 12 });
    expect(s.procs.byCmd[0]).toMatchObject({ key: "aihub status", n: 12, maxMs: 2000 });
    expect(s.loop).toMatchObject({ samples: 2, p99Median: 25, p99Max: 41, maxMs: 120, rssMb: 320 });
    expect(s.timers[0]).toMatchObject({ name: "bar.refresh", fires: 3 });
    expect(s.watchers[0]).toMatchObject({ glob: ".git/HEAD", events: 3 });
    expect(s.refresh.skipped).toEqual({ "timer.unfocused": 5 });
    expect(s.notifications).toMatchObject({ total: 2, top: [{ text: "Pushed feature/x.", n: 2 }] });
  });

  it("renders a markdown report with every section and a one-line doctor summary", () => {
    const md = renderReport(s, "/perf");
    for (const h of ["## Activation", "## Top 10 slowest actions", "## Child processes", "## Event loop", "## Timers and watchers", "## Notifications", "| perf.setup | 5 ms |", "| aihub status | 12 |"]) expect(md).toContain(h);
    expect(summaryLine(s)).toBe("last 24 h: activation 180 ms, first read 2.6 s; 13 processes (max 12/min, 4 parallel); event loop p99 25 ms (worst 41 ms); slowest refresh 4.1 s; 2 notifications");
  });
});

describe("overhead of the logger", () => {
  it("costs microseconds per event, also with scrubbing and the disk write", async () => {
    const dir = tmp();
    const log = new PerfLog({ dir, flushMs: 60_000, flushAt: 1_000_000, maxBuffer: 1_000_000, scrubber: new Scrubber({ roots: ["C:\\work\\test-project"] }) });
    const N = 20_000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) log.write("proc", { cmd: "git", sub: "status", args: ["status", "--porcelain", `C:\\work\\test-project\\src\\file${i}.py`], ms: 12.3, code: 0, ok: true, windowsHide: true, parallel: 1 });
    const writeUs = ((performance.now() - t0) * 1000) / N;
    const t1 = performance.now();
    await log.flush();
    const flushUs = ((performance.now() - t1) * 1000) / N;
    await log.dispose();
    console.log(`perf log overhead: write ${writeUs.toFixed(2)} us/event (hot path), scrub+serialise+append ${flushUs.toFixed(2)} us/event (async flush), ${N} events`);
    expect(lines(dir)).toHaveLength(N);
    // a real minute has tens of events; even 20 us x 100 events is 2 ms per minute
    expect(writeUs).toBeLessThan(10);
    expect(flushUs).toBeLessThan(100);
  });
});

describe("the aihub processes in the report", () => {
  it("reads the CLI's day files and groups its network calls, start-up and child processes", async () => {
    const dir = tmp();
    const t = Date.now();
    const day = fileDay(t);
    writeFileSync(join(dir, `aihub-perf-${day}.jsonl`), JSON.stringify({ t, type: "proc", cmd: "aihub", sub: "bar", ms: 900, ok: true, code: 0, windowsHide: true, parallel: 1 }) + "\n");
    const cli = [
      { t, type: "net", cli: "bar", method: "GET", host: "dev.azure.com", path: "/ferron-test/test-project/_apis/git/repositories/test-project/pullRequests/45/threads", status: 200, ok: true, ms: 300 },
      { t, type: "net", cli: "bar", method: "GET", host: "dev.azure.com", path: "/ferron-test/test-project/_apis/git/repositories/test-project/pullRequests/46/threads", status: 200, ok: true, ms: 500 },
      { t, type: "net", cli: "bar", method: "GET", host: "api.fabric.microsoft.com", path: "/v1/workspaces", status: 401, ok: false, ms: 120 },
      { t, type: "cli.proc", cli: "bar", cmd: "git", sub: "rev-parse", ms: 40, ok: true, code: 0 },
      { t, type: "cli.run", cli: "bar", ms: 600, startupMs: 250, code: 0 },
    ];
    writeFileSync(join(dir, `aihub-cli-perf-${day}.jsonl`), cli.map((x) => JSON.stringify(x)).join("\n") + "\n");
    const s = summarize(await readEvents(dir, t - 1000, t + 1000), t - 1000, t + 1000);
    expect(s.procs.total).toBe(1); // the CLI's git is not counted as an extension process
    expect(s.network).toMatchObject({ total: 3, failed: 1 });
    expect(s.network.byCall[0]).toMatchObject({ key: "GET dev.azure.com/ferron-test/test-project/_apis/git/repositories/test-project/pullRequests/{id}/threads", n: 2, avgMs: 400, maxMs: 500 });
    expect(s.cli).toMatchObject({ runs: 1, startupAvgMs: 250, byCmd: [{ cmd: "bar", n: 1, avgMs: 850 }], children: [{ key: "git rev-parse", n: 1 }] });
    const md = renderReport(s, dir);
    expect(md).toContain("## Network calls");
    expect(md).toContain("## Inside the aihub processes");
    expect(md).toContain("401x1");
  });
});
