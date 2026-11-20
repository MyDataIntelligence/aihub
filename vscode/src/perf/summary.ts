import type { PerfEvent } from "./log";

/** Turns the log of a time window into the numbers the report and `aihub doctor` show. */

export interface Action {
  t: number;
  type: string;
  name: string;
  ms: number;
  ok: boolean;
}

export interface Summary {
  from: number;
  to: number;
  events: number;
  activation?: { t: number; ms: number; hostUptimeMs?: number; firstRefreshMs?: number; phases: Record<string, number>; events: string[]; count: number; medianMs: number };
  slowest: Action[];
  procs: { total: number; failed: number; noHide: number; maxParallel: number; perMinuteMax: number; perMinuteAvg: number; busiestMinute?: number; byCmd: { key: string; n: number; ms: number; avgMs: number; maxMs: number; failed: number }[] };
  refresh: { n: number; failed: number; avgMs: number; byReason: Record<string, number>; skipped: Record<string, number> };
  commands: { name: string; n: number; avgMs: number; maxMs: number; failed: number }[];
  loop?: { samples: number; p99Median: number; p99Max: number; maxMs: number; cpuAvgPct: number; cpuMaxPct: number; rssMb: number; rssMaxMb: number; heapMb: number };
  timers: { name: string; kind: string; ms: number; fires: number; perHour: number; busyMs: number }[];
  watchers: { name: string; glob: string; events: number }[];
  notifications: { total: number; byLevel: Record<string, number>; top: { text: string; n: number }[] };
  counters: Record<string, number>;
  dropped: number;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
};
const r1 = (n: number) => Math.round(n * 10) / 10;

export function summarize(events: PerfEvent[], from: number, to: number): Summary {
  const actions: Action[] = [];
  const minutes = new Map<number, number>();
  const byCmd = new Map<string, { n: number; ms: number; maxMs: number; failed: number }>();
  const cmds = new Map<string, { n: number; ms: number; maxMs: number; failed: number }>();
  const reasons: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  const counters: Record<string, number> = {};
  const timers = new Map<string, { name: string; kind: string; ms: number; fires: number; busyMs: number }>();
  const watchers = new Map<string, { name: string; glob: string; events: number }>();
  const notes = new Map<string, number>();
  const byLevel: Record<string, number> = {};
  const samples: PerfEvent[] = [];
  const activations: PerfEvent[] = [];
  let firstRefresh: PerfEvent | undefined;
  let procTotal = 0;
  let procFailed = 0;
  let noHide = 0;
  let maxParallel = 0;
  let refreshN = 0;
  let refreshFailed = 0;
  let refreshMs = 0;
  let dropped = 0;

  for (const e of events) {
    switch (e.type) {
      case "proc": {
        procTotal++;
        const key = [str(e.cmd), str(e.sub)].filter(Boolean).join(" ");
        const ms = num(e.ms);
        const b = byCmd.get(key) ?? { n: 0, ms: 0, maxMs: 0, failed: 0 };
        b.n++;
        b.ms += ms;
        b.maxMs = Math.max(b.maxMs, ms);
        if (!e.ok) (b.failed++, procFailed++);
        byCmd.set(key, b);
        if (e.windowsHide === false) noHide++;
        maxParallel = Math.max(maxParallel, num(e.parallel));
        const m = Math.floor(e.t / 60_000);
        minutes.set(m, (minutes.get(m) ?? 0) + 1);
        actions.push({ t: e.t, type: "process", name: `${key}${Array.isArray(e.args) && e.args.length ? ` (${(e.args as string[]).slice(0, 6).join(" ")})` : ""}`, ms, ok: !!e.ok });
        break;
      }
      case "refresh":
        refreshN++;
        refreshMs += num(e.ms);
        if (!e.ok) refreshFailed++;
        reasons[str(e.reason) || "?"] = (reasons[str(e.reason) || "?"] ?? 0) + 1;
        actions.push({ t: e.t, type: "refresh", name: `refresh (${str(e.reason)})`, ms: num(e.ms), ok: !!e.ok });
        break;
      case "cmd": {
        const c = cmds.get(str(e.name)) ?? { n: 0, ms: 0, maxMs: 0, failed: 0 };
        c.n++;
        c.ms += num(e.ms);
        c.maxMs = Math.max(c.maxMs, num(e.ms));
        if (!e.ok) c.failed++;
        cmds.set(str(e.name), c);
        actions.push({ t: e.t, type: "command", name: str(e.name), ms: num(e.ms), ok: !!e.ok });
        break;
      }
      case "tree":
      case "task":
        actions.push({ t: e.t, type: e.type, name: str(e.name), ms: num(e.ms), ok: !!e.ok });
        break;
      case "activate":
        activations.push(e);
        break;
      case "activate.firstRefresh":
        firstRefresh = e;
        break;
      case "notify": {
        const lvl = str(e.level) || "info";
        byLevel[lvl] = (byLevel[lvl] ?? 0) + 1;
        const text = str(e.text);
        notes.set(text, (notes.get(text) ?? 0) + 1);
        break;
      }
      case "sample": {
        samples.push(e);
        const p = (e.procs ?? {}) as { maxParallel?: number };
        maxParallel = Math.max(maxParallel, num(p.maxParallel));
        for (const t of (e.timers ?? []) as { name: string; kind: string; ms: number; fires: number; busyMs: number }[]) {
          const x = timers.get(t.name) ?? { name: t.name, kind: t.kind, ms: t.ms, fires: 0, busyMs: 0 };
          x.fires += num(t.fires);
          x.ms = num(t.ms);
          x.busyMs = Math.max(x.busyMs, num(t.busyMs));
          timers.set(t.name, x);
        }
        for (const w of (e.watchers ?? []) as { name: string; glob: string; events: number }[]) {
          const x = watchers.get(w.name) ?? { name: w.name, glob: w.glob, events: 0 };
          x.events += num(w.events);
          watchers.set(w.name, x);
        }
        for (const [k, v] of Object.entries((e.counters ?? {}) as Record<string, number>)) {
          if (k.startsWith("refresh.skip.")) skipped[k.slice(13)] = (skipped[k.slice(13)] ?? 0) + num(v);
          else counters[k] = (counters[k] ?? 0) + num(v);
        }
        dropped = Math.max(dropped, num((e.log as { dropped?: number } | undefined)?.dropped));
        break;
      }
    }
  }

  const last = activations[activations.length - 1];
  // rates over the time that was logged (VS Code running), not over the whole window
  const first = events.length ? Math.max(from, events.reduce((m, e) => Math.min(m, e.t), Infinity)) : from;
  const lastT = events.length ? Math.min(to, events.reduce((m, e) => Math.max(m, e.t), 0)) : to;
  const hours = Math.max(1 / 60, (lastT - first) / 3_600_000);
  const perMinute = [...minutes.entries()].sort((a, b) => b[1] - a[1]);
  const activeMinutes = Math.max(1, Math.round((lastT - first) / 60_000));
  const loops = samples.map((s) => s.loop as { p99?: number; max?: number } | undefined).filter((l): l is { p99: number; max: number } => !!l && typeof l.p99 === "number");
  const cpus = samples.map((s) => num((s.cpu as { pct?: number } | undefined)?.pct));
  const mems = samples.map((s) => (s.mem ?? {}) as { rssMb?: number; heapMb?: number });

  return {
    from,
    to,
    events: events.length,
    activation: last && {
      t: last.t,
      ms: num(last.ms),
      hostUptimeMs: typeof last.hostUptimeMs === "number" ? last.hostUptimeMs : undefined,
      firstRefreshMs: firstRefresh && firstRefresh.t >= last.t ? num(firstRefresh.ms) : undefined,
      phases: (last.phases ?? {}) as Record<string, number>,
      events: (last.activationEvents ?? []) as string[],
      count: activations.length,
      medianMs: median(activations.map((a) => num(a.ms))),
    },
    slowest: actions.sort((a, b) => b.ms - a.ms).slice(0, 10),
    procs: {
      total: procTotal,
      failed: procFailed,
      noHide,
      maxParallel,
      perMinuteMax: perMinute[0]?.[1] ?? 0,
      perMinuteAvg: r1(procTotal / activeMinutes),
      busiestMinute: perMinute[0] ? perMinute[0][0] * 60_000 : undefined,
      byCmd: [...byCmd.entries()].map(([key, b]) => ({ key, n: b.n, ms: r1(b.ms), avgMs: r1(b.ms / b.n), maxMs: b.maxMs, failed: b.failed })).sort((a, b) => b.ms - a.ms),
    },
    refresh: { n: refreshN, failed: refreshFailed, avgMs: refreshN ? r1(refreshMs / refreshN) : 0, byReason: reasons, skipped },
    commands: [...cmds.entries()].map(([name, c]) => ({ name, n: c.n, avgMs: r1(c.ms / c.n), maxMs: c.maxMs, failed: c.failed })).sort((a, b) => b.maxMs - a.maxMs),
    loop: samples.length
      ? {
          samples: samples.length,
          p99Median: median(loops.map((l) => l.p99)),
          p99Max: Math.max(0, ...loops.map((l) => l.p99)),
          maxMs: Math.max(0, ...loops.map((l) => num(l.max))),
          cpuAvgPct: r1(cpus.reduce((a, b) => a + b, 0) / Math.max(1, cpus.length)),
          cpuMaxPct: Math.max(0, ...cpus),
          rssMb: num(mems[mems.length - 1]?.rssMb),
          rssMaxMb: Math.max(0, ...mems.map((m) => num(m.rssMb))),
          heapMb: num(mems[mems.length - 1]?.heapMb),
        }
      : undefined,
    timers: [...timers.values()].map((t) => ({ ...t, perHour: r1(t.fires / hours) })).sort((a, b) => b.fires - a.fires),
    watchers: [...watchers.values()].sort((a, b) => b.events - a.events),
    notifications: {
      total: [...notes.values()].reduce((a, b) => a + b, 0),
      byLevel,
      top: [...notes.entries()].map(([text, n]) => ({ text, n })).sort((a, b) => b.n - a.n).slice(0, 10),
    },
    counters,
    dropped,
  };
}

const ms = (n: number) => (n >= 1000 ? `${r1(n / 1000)} s` : `${Math.round(n)} ms`);
const time = (t: number) => new Date(t).toLocaleString();
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** The report as markdown. */
export function renderReport(s: Summary, logDir: string): string {
  const out: string[] = [];
  out.push(`# AI Context Hub: performance report`, "", `Window: ${time(s.from)} to ${time(s.to)}, ${s.events} events. Log: \`${logDir}\`${s.dropped ? `, ${s.dropped} events dropped (day limit or full buffer)` : ""}.`, "");

  out.push("## Activation", "");
  const a = s.activation;
  if (!a) out.push("No activation in this window.", "");
  else {
    out.push(`Last activation ${time(a.t)}: **${ms(a.ms)}** in \`activate()\`${a.firstRefreshMs !== undefined ? `, first status read after **${ms(a.firstRefreshMs)}**` : ""}${a.hostUptimeMs !== undefined ? `; the extension host had been running ${ms(a.hostUptimeMs)}` : ""}. Activation events: ${a.events.map((e) => `\`${e}\``).join(", ") || "-"}. ${a.count} activation(s) in the window, median ${ms(a.medianMs)}.`, "");
    out.push("| Phase | Time |", "|---|---:|", ...Object.entries(a.phases).map(([k, v]) => `| ${k} | ${ms(v)} |`), "");
  }

  out.push("## Top 10 slowest actions", "");
  if (!s.slowest.length) out.push("None.", "");
  else out.push("| When | Kind | What | Time | OK |", "|---|---|---|---:|:-:|", ...s.slowest.map((x) => `| ${time(x.t)} | ${x.type} | ${cell(x.name)} | ${ms(x.ms)} | ${x.ok ? "yes" : "no"} |`), "");

  out.push("## Child processes", "");
  const p = s.procs;
  out.push(`${p.total} processes (${p.failed} failed), ${p.perMinuteAvg} per minute on average, at most ${p.perMinuteMax} in one minute${p.busiestMinute ? ` (${time(p.busiestMinute)})` : ""}, at most ${p.maxParallel} at the same time. Without windowsHide: ${p.noHide}.`, "");
  if (p.byCmd.length) out.push("| Command | Count | Total | Average | Slowest | Failed |", "|---|---:|---:|---:|---:|---:|", ...p.byCmd.slice(0, 20).map((c) => `| ${cell(c.key)} | ${c.n} | ${ms(c.ms)} | ${ms(c.avgMs)} | ${ms(c.maxMs)} | ${c.failed} |`), "");
  out.push("Network: the extension calls no API itself. Every Azure DevOps, Fabric and GitHub call is made by an `aihub` child process, so the `aihub ...` rows above are the API cost (one row per CLI read).", "");

  out.push("## Refreshes", "");
  const rf = s.refresh;
  out.push(`${rf.n} status reads (${rf.failed} failed), average ${ms(rf.avgMs)}. By trigger: ${fmtMap(rf.byReason)}. Skipped (window not focused or last read still fresh): ${fmtMap(rf.skipped)}.`, "");

  out.push("## Event loop, CPU and memory of the extension host", "");
  const l = s.loop;
  if (!l) out.push("No samples yet (one every 30-60 s).", "");
  else
    out.push(
      `${l.samples} samples. Event-loop delay p99: median **${ms(l.p99Median)}**, worst ${ms(l.p99Max)}, longest single delay ${ms(l.maxMs)}. CPU of the host process: ${l.cpuAvgPct}% on average, ${l.cpuMaxPct}% at most. Memory: ${l.rssMb} MB RSS now (${l.rssMaxMb} MB at most), heap ${l.heapMb} MB.`,
      "",
      "Event-loop delay is how late a 20 ms probe timer fired; on Windows about 10 ms of it is timer granularity, so look at p99 and the longest delay compared with the p50. The extension host is shared by all extensions in the window: these numbers include them.",
      "",
    );

  out.push("## Timers and watchers", "");
  if (s.timers.length) out.push("| Timer | Kind | Interval | Fired | Per hour |", "|---|---|---:|---:|---:|", ...s.timers.map((t) => `| ${cell(t.name)} | ${t.kind} | ${ms(t.ms)} | ${t.fires} | ${t.perHour} |`), "");
  if (s.watchers.length) out.push("| Watcher | Pattern | Events |", "|---|---|---:|", ...s.watchers.map((w) => `| ${cell(w.name)} | \`${cell(w.glob)}\` | ${w.events} |`), "");
  if (!s.timers.length && !s.watchers.length) out.push("None recorded.", "");

  out.push("## Commands", "");
  if (s.commands.length) out.push("Times include the time you spent in a pick list or dialog.", "", "| Command | Count | Average | Slowest | Failed |", "|---|---:|---:|---:|---:|", ...s.commands.map((c) => `| ${c.name} | ${c.n} | ${ms(c.avgMs)} | ${ms(c.maxMs)} | ${c.failed} |`), "");
  else out.push("None run.", "");

  out.push("## Notifications", "");
  const n = s.notifications;
  out.push(`${n.total} notifications: ${fmtMap(n.byLevel)}.`, "");
  if (n.top.length) out.push("| Text | Count |", "|---|---:|", ...n.top.map((x) => `| ${cell(x.text)} | ${x.n} |`), "");

  if (Object.keys(s.counters).length) out.push("## Counters", "", ...Object.entries(s.counters).sort((x, y) => y[1] - x[1]).map(([k, v]) => `- ${k}: ${v}`), "");
  return out.join("\n");
}

const fmtMap = (m: Record<string, number>) => Object.entries(m).map(([k, v]) => `${k} ${v}`).join(", ") || "none";

/** One line for `aihub doctor`. */
export function summaryLine(s: Summary): string {
  const parts: string[] = [];
  if (s.activation) parts.push(`activation ${ms(s.activation.ms)}${s.activation.firstRefreshMs !== undefined ? `, first read ${ms(s.activation.firstRefreshMs)}` : ""}`);
  parts.push(`${s.procs.total} processes (max ${s.procs.perMinuteMax}/min, ${s.procs.maxParallel} parallel)`);
  if (s.loop) parts.push(`event loop p99 ${ms(s.loop.p99Median)} (worst ${ms(s.loop.p99Max)})`);
  if (s.slowest[0]) parts.push(`slowest ${s.slowest[0].name.split(" (")[0]} ${ms(s.slowest[0].ms)}`);
  parts.push(`${s.notifications.total} notifications`);
  return `last 24 h: ${parts.join("; ")}`;
}
