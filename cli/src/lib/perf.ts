import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * The CLI's part of the VS Code performance log. When `AIHUB_PERF_LOG` names a folder (the extension sets it for the
 * processes it starts), every network call (method, host, path without query, status, duration), every child process
 * and the whole command are kept in memory and appended once, at exit, to `<folder>/aihub-cli-perf-<yyyy-mm-dd>.jsonl`.
 * The extension's report reads those files next to its own. Off when the variable is not set.
 */

export interface PerfLine {
  t: number;
  type: string;
  [k: string]: unknown;
}

const MAX_BYTES_PER_DAY = 10 * 1024 * 1024;
let dir: string | undefined;
let cmd = "";
const lines: PerfLine[] = [];

export const perfOn = () => !!dir;

export function perfRecord(type: string, fields: Record<string, unknown>): void {
  if (dir && lines.length < 2000) lines.push({ t: Date.now(), type, cli: cmd, pid: process.pid, ...fields });
}

/** Starts the log for this process (no-op without AIHUB_PERF_LOG). */
export function startPerf(env: NodeJS.ProcessEnv, argv: string[]): void {
  dir = env.AIHUB_PERF_LOG || undefined;
  cmd = argv.filter((a) => !a.startsWith("-")).slice(0, 2).join(" ");
}

/** Appends what this process recorded; one write per process. */
export function flushPerf(): void {
  if (!dir || !lines.length) return;
  try {
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const file = join(dir, `aihub-cli-perf-${day}.jsonl`);
    mkdirSync(dir, { recursive: true });
    const size = (() => {
      try {
        return statSync(file).size;
      } catch {
        return 0;
      }
    })();
    const chunk = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    if (size + chunk.length <= MAX_BYTES_PER_DAY) appendFileSync(file, chunk, "utf8");
  } catch {
    /* the log must never fail a command */
  }
  lines.length = 0;
}

const SECRETISH = /[A-Za-z0-9+=]{32,}|[^\s/@]+@[^\s/]+\.[^\s/]+/g;

/** `https://dev.azure.com/org/project/_apis/git/...?...` -> host and path, without query, user info, tokens or e-mail addresses. */
export function urlForLog(url: string): { host: string; path: string } {
  try {
    const u = new URL(url);
    return { host: u.host, path: u.pathname.replace(SECRETISH, (m) => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) && !/^[0-9a-f-]{32,}$/i.test(m) ? "<redacted>" : m.includes("@") ? "<email>" : m)).slice(0, 200) };
  } catch {
    return { host: "?", path: "?" };
  }
}

/** A fetch that records each call. */
export function timedFetch(base: typeof fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (!dir) return base(input, init);
    const t0 = performance.now();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const method = init?.method ?? (typeof input === "object" && "method" in input ? (input as Request).method : "GET");
    try {
      const res = await base(input, init);
      perfRecord("net", { method, ...urlForLog(url), status: res.status, ok: res.ok, ms: Math.round(performance.now() - t0) });
      return res;
    } catch (e) {
      perfRecord("net", { method, ...urlForLog(url), status: 0, ok: false, error: (e as Error).name, ms: Math.round(performance.now() - t0) });
      throw e;
    }
  }) as typeof fetch;
}

/** Records one finished child process of the CLI (git, az, ...). */
export function recordChild(command: unknown, args: unknown, ms: number, status: number | null | undefined): void {
  if (!dir) return;
  const c = basename(String(command)).replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
  const words = Array.isArray(args) ? (args as unknown[]).map(String).filter((a) => !a.startsWith("-")) : [];
  const sub = c === "git" ? words.find((w) => !/[\\/=]/.test(w)) ?? "" : words.slice(0, 2).join(" ");
  perfRecord("cli.proc", { cmd: c, sub, ms: Math.round(ms), code: status ?? -1, ok: status === 0 });
}
