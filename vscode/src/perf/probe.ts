import { execFile, type ChildProcess, type ExecFileOptions } from "node:child_process";
import { basename } from "node:path";
import { monitorEventLoopDelay, performance, type IntervalHistogram } from "node:perf_hooks";
import type { PerfLog } from "./log";

/**
 * The one place the extension reports what it costs: child processes, timers, watchers, counters and the periodic
 * host sample. Without a log (tests, or aihub.performanceLog.enabled off) every call is a cheap no-op.
 */

export type PerfLevel = "basic" | "verbose";

let sink: PerfLog | undefined;
let level: PerfLevel = "basic";

export function setPerfLog(log: PerfLog | undefined, lvl: PerfLevel = "basic") {
  sink = log;
  level = lvl;
}

export const perfLog = () => sink;
export const verbose = () => !!sink && level === "verbose";

export function perfEvent(type: string, fields: Record<string, unknown> = {}) {
  sink?.write(type, fields);
}

// ---- counters ----------------------------------------------------------------------------------

const counters = new Map<string, number>();

/** Counts something cheap (a skipped refresh, an editor change); the sample writes the counts per interval. */
export function count(name: string, n = 1) {
  if (!sink) return;
  counters.set(name, (counters.get(name) ?? 0) + n);
}

// ---- spans ---------------------------------------------------------------------------------------

/** Times one action: `const end = span("cmd", "aihub.refresh"); ...; end(true)`. */
export function span(type: string, name: string, fields: Record<string, unknown> = {}): (ok?: boolean, extra?: Record<string, unknown>) => void {
  if (!sink) return () => undefined;
  const t0 = performance.now();
  return (ok = true, extra) => perfEvent(type, { name, ms: round(performance.now() - t0), ok, ...fields, ...extra });
}

export async function timed<T>(type: string, name: string, f: () => Promise<T> | T, fields: Record<string, unknown> = {}): Promise<T> {
  const end = span(type, name, fields);
  try {
    const r = await f();
    end(true);
    return r;
  } catch (e) {
    end(false, { error: errorKind(e) });
    throw e;
  }
}

// ---- child processes ---------------------------------------------------------------------------

interface ProcStats {
  spawned: number;
  failed: number;
  ms: number;
  maxParallel: number;
  noHide: number;
  byCmd: Record<string, { n: number; ms: number; failed: number }>;
}
const freshProcs = (): ProcStats => ({ spawned: 0, failed: 0, ms: 0, maxParallel: 0, noHide: 0, byCmd: {} });
let procs = freshProcs();
let active = 0;

/** What the log shows of a command line: the program and the real arguments (before shell quoting). */
export interface ProcLabel {
  cmd: string;
  args: readonly string[];
}

/**
 * `execFile` with a log line per process: program, masked arguments, duration, exit code, windowsHide and how many
 * processes ran at the same time. Every child process of the extension starts here.
 */
export function trackedExecFile(
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
  callback: (error: Error | null, stdout: string, stderr: string) => void,
  label: ProcLabel = { cmd: file, args },
): ChildProcess {
  if (!sink) return execFile(file, args, options, (e, so, se) => callback(e, String(so), String(se)));
  const t0 = performance.now();
  const parallel = ++active;
  procs.maxParallel = Math.max(procs.maxParallel, parallel);
  let done = false;
  const finish = (error: (Error & { code?: number | string; killed?: boolean }) | null) => {
    if (done) return;
    done = true;
    active--;
    const ms = round(performance.now() - t0);
    const cmd = programName(label.cmd);
    const sub = subcommand(cmd, label.args);
    const code = !error ? 0 : typeof error.code === "number" ? error.code : -1;
    const ok = code === 0;
    const key = sub ? `${cmd} ${sub}` : cmd;
    const by = (procs.byCmd[key] ??= { n: 0, ms: 0, failed: 0 });
    by.n++;
    by.ms += ms;
    procs.spawned++;
    procs.ms += ms;
    if (!ok) (procs.failed++, by.failed++);
    if (!options.windowsHide) procs.noHide++;
    perfEvent("proc", {
      cmd,
      sub,
      args: sink!.scrubber.args(label.args),
      cwd: options.cwd ? String(options.cwd) : undefined,
      ms,
      code,
      ok,
      killed: error?.killed || undefined,
      spawnError: error && typeof error.code === "string" ? error.code : undefined,
      windowsHide: !!options.windowsHide,
      shell: options.shell ? true : undefined,
      parallel,
    });
  };
  try {
    const child = execFile(file, args, options, (e, so, se) => {
      finish(e as never);
      callback(e, String(so), String(se));
    });
    child.once("error", (e) => finish(e as never));
    return child;
  } catch (e) {
    finish(e as never);
    throw e;
  }
}

const programName = (cmd: string) => basename(cmd.replace(/^"|"$/g, "")).replace(/\.(exe|cmd|bat|com)$/i, "").toLowerCase();

/** `git status`, `aihub pr checks`: the first one or two words that are not flags. */
export function subcommand(cmd: string, args: readonly string[]): string {
  const words: string[] = [];
  let skip = false;
  for (const a of args) {
    if (skip) {
      skip = false;
      continue;
    }
    // git -C <dir> / -c <key=value> come before the subcommand
    if (cmd === "git" && !words.length && (a === "-C" || a === "-c")) {
      skip = true;
      continue;
    }
    if (a.startsWith("-") || /[\\/]/.test(a) || a.includes("=")) {
      if (words.length) break;
      continue;
    }
    words.push(a);
    if (words.length === (cmd === "git" ? 1 : 2)) break;
  }
  return words.join(" ");
}

export const activeProcesses = () => active;

// ---- timers and watchers -----------------------------------------------------------------------

interface TimerInfo {
  name: string;
  kind: "interval" | "timeout";
  ms: number;
  fires: number;
  busyMs: number;
}
interface WatcherInfo {
  name: string;
  glob: string;
  events: number;
}
const timers = new Map<NodeJS.Timeout, TimerInfo>();
const watchers = new Set<WatcherInfo>();

const wrapTimer = (info: TimerInfo, fn: () => void) => () => {
  info.fires++;
  const t0 = sink ? performance.now() : 0;
  try {
    fn();
  } finally {
    if (sink) {
      const busy = performance.now() - t0;
      info.busyMs += busy;
      if (verbose()) perfEvent("timer.fire", { name: info.name, kind: info.kind, ms: round(busy) });
    }
  }
};

/** `setInterval` that the log lists with its interval and how often it fired. */
export function trackedInterval(name: string, fn: () => void, ms: number): NodeJS.Timeout {
  const info: TimerInfo = { name, kind: "interval", ms, fires: 0, busyMs: 0 };
  const h = setInterval(wrapTimer(info, fn), ms);
  timers.set(h, info);
  return h;
}

export function clearTrackedInterval(h: NodeJS.Timeout | undefined) {
  if (!h) return;
  clearInterval(h);
  timers.delete(h);
}

/** `setTimeout` that the log counts (debounces, delayed first reads). */
export function trackedTimeout(name: string, fn: () => void, ms: number): NodeJS.Timeout {
  const info: TimerInfo = { name, kind: "timeout", ms, fires: 0, busyMs: 0 };
  const h = setTimeout(() => {
    timers.delete(h);
    timeoutTotals(info, 1);
    wrapTimer(info, fn)();
  }, ms);
  timers.set(h, info);
  return h;
}

export function clearTrackedTimeout(h: NodeJS.Timeout | undefined) {
  if (!h) return;
  clearTimeout(h);
  timers.delete(h);
}

const firedTimeouts = new Map<string, { ms: number; fires: number }>();
function timeoutTotals(info: TimerInfo, n: number) {
  const t = firedTimeouts.get(info.name) ?? { ms: info.ms, fires: 0 };
  t.fires += n;
  firedTimeouts.set(info.name, t);
}

/** Registers a FileSystemWatcher (or any event source) by name and glob; call `hit` on each event, `dispose` with it. */
export function trackedWatcher(name: string, glob: string): { hit: (kind?: string) => void; dispose: () => void } {
  const info: WatcherInfo = { name, glob, events: 0 };
  watchers.add(info);
  return {
    hit: (kind) => {
      info.events++;
      if (verbose()) perfEvent("watcher.event", { name, kind });
    },
    dispose: () => void watchers.delete(info),
  };
}

// ---- the periodic sample -------------------------------------------------------------------------

export interface Monitor {
  stop(): void;
  /** Writes a sample now (also used when the window closes). */
  sample(): void;
}

/**
 * Every `intervalMs`: event-loop delay of the extension host (p50/p99/max since the last sample), CPU and memory of
 * the host process, the child processes of the interval, the timers and watchers with their fire counts, the counters.
 */
const LOOP_RESOLUTION_MS = 20;

export function startMonitor(intervalMs: number): Monitor {
  let h: IntervalHistogram | undefined;
  try {
    h = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
    h.enable();
  } catch {
    h = undefined;
  }
  let cpu = process.cpuUsage();
  let at = performance.now();
  let lastTimerFires = new Map<TimerInfo, number>();
  let lastWatchEvents = new Map<WatcherInfo, number>();
  const sample = () => {
    if (!sink) return;
    const now = performance.now();
    const wall = Math.max(1, now - at);
    const c = process.cpuUsage(cpu);
    const m = process.memoryUsage();
    // the histogram records the whole interval of its 20 ms probe timer: the delay is what comes on top of it
    const late = (ns: number) => Math.max(0, round(ns / 1e6 - LOOP_RESOLUTION_MS));
    const loop = h && h.count > 0 ? { p50: late(h.percentile(50)), p99: late(h.percentile(99)), max: late(h.max), mean: late(h.mean) } : undefined;
    const t = [...timers.values()].map((x) => ({ name: x.name, kind: x.kind, ms: x.ms, fires: x.fires - (lastTimerFires.get(x) ?? 0), busyMs: round(x.busyMs) }));
    for (const [name, x] of firedTimeouts) t.push({ name, kind: "timeout", ms: x.ms, fires: x.fires, busyMs: 0 });
    firedTimeouts.clear();
    const w = [...watchers].map((x) => ({ name: x.name, glob: x.glob, events: x.events - (lastWatchEvents.get(x) ?? 0) }));
    perfEvent("sample", {
      windowMs: round(wall),
      loop,
      cpu: { userMs: round(c.user / 1000), systemMs: round(c.system / 1000), pct: round(((c.user + c.system) / 1000 / wall) * 100) },
      mem: { rssMb: mb(m.rss), heapMb: mb(m.heapUsed), externalMb: mb(m.external) },
      procs: { ...procs, active },
      timers: t,
      watchers: w,
      counters: Object.fromEntries(counters),
      log: sink.dropped ? { dropped: sink.dropped } : undefined,
    });
    lastTimerFires = new Map([...timers.values()].map((x) => [x, x.fires]));
    lastWatchEvents = new Map([...watchers].map((x) => [x, x.events]));
    counters.clear();
    procs = freshProcs();
    cpu = process.cpuUsage();
    at = now;
    h?.reset();
  };
  const timer = setInterval(sample, intervalMs);
  timer.unref?.();
  return {
    sample,
    stop: () => {
      clearInterval(timer);
      h?.disable();
    },
  };
}

// ---- helpers -------------------------------------------------------------------------------------

export const round = (n: number) => Math.round(n * 10) / 10;
const mb = (b: number) => round(b / 1024 / 1024);
const errorKind = (e: unknown) => (e && typeof e === "object" && "kind" in e ? String((e as { kind: unknown }).kind) : e instanceof Error ? e.name : "error");

/** Forgets all state (tests). */
export function resetProbe() {
  counters.clear();
  procs = freshProcs();
  active = 0;
  timers.clear();
  watchers.clear();
  firedTimeouts.clear();
}
