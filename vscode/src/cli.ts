import { spawn, type ChildProcess } from "node:child_process";
import { perfLog, trackedExecFile } from "./perf/probe";

const perfEnv = (): Record<string, string> => {
  const dir = perfLog()?.dir;
  return dir ? { AIHUB_PERF_LOG: dir } : {};
};

/** The oldest CLI that has every `--json` read the extension uses. */
export const MIN_CLI_VERSION = "1.0.2";
export const INSTALL_COMMAND = "npm i -g @ferronhooi/aihub";

export type CliFailure = "missing" | "old" | "timeout" | "failed";

export class CliError extends Error {
  constructor(
    readonly kind: CliFailure,
    message: string,
    readonly exitCode?: number,
  ) {
    super(message);
  }
}

export interface CliConfig {
  /** The command, `aihub` by default. */
  command: string;
  /** Arguments put before the real ones (used by the tests to run a stub with node). */
  prefixArgs?: string[];
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

export type Runner = (args: string[], cwd: string) => Promise<string>;

/** npm installs `aihub` on Windows as aihub.cmd, which only runs through a shell. A stub run with prefix args (node) does not need one. */
const needsShell = (cfg: CliConfig, platform: NodeJS.Platform) => platform === "win32" && !cfg.prefixArgs?.length && !/\.(exe|com)$/i.test(cfg.command);

const quote = (a: string) => (/^[A-Za-z0-9_@%+=:,./\-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);

/**
 * Stops a timed-out CLI with everything it started. With `shell` (the npm `.cmd` shim on Windows) the child is cmd.exe:
 * killing only it leaves node and its git running, and they keep the output pipes open, so the call never ended (a git
 * push waiting for a sign-in made "Create Pull Requests" do nothing, without a message).
 */
export function killTree(child: Pick<ChildProcess, "pid" | "kill">, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32" && child.pid) {
    try {
      spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true, stdio: "ignore" }).on("error", () => undefined);
    } catch {
      /* taskkill is missing: the kill below still ends the child itself */
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

/** Runs `aihub <args>` once, with a time limit. The extension has no other way to read data. */
export function makeRunner(cfg: CliConfig, platform: NodeJS.Platform = process.platform): Runner {
  return (args, cwd) =>
    new Promise((resolve, reject) => {
      const all = [...(cfg.prefixArgs ?? []), ...args];
      const shell = needsShell(cfg, platform);
      // our own time limit: it settles the call at the limit, also when a grandchild keeps the pipes open
      let settled = false;
      const settle = (f: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        f();
      };
      const child = trackedExecFile(
        shell ? quote(cfg.command) : cfg.command,
        shell ? all.map(quote) : all,
        // AIHUB_PERF_LOG: the CLI appends its network calls and child processes to the performance log (src/perf)
        { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024, shell, env: { ...process.env, ...perfEnv(), ...cfg.env, NO_COLOR: "1" } },
        (err, stdout, stderr) => settle(() => {
          if (!err) return resolve(stdout);
          const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
          if (e.code === "ENOENT") return reject(new CliError("missing", `aihub was not found. Install it with: ${INSTALL_COMMAND}`));
          if (e.killed) return reject(new CliError("timeout", `aihub ${args.join(" ")} took longer than ${Math.round(cfg.timeoutMs / 1000)} s`));
          const text = `${stderr || ""}${stdout || ""}`.trim();
          // cmd.exe says "not recognized" with exit code 1 when the shim is missing
          if (/not recognized as an internal or external command|command not found/i.test(text)) return reject(new CliError("missing", `aihub was not found. Install it with: ${INSTALL_COMMAND}`));
          reject(new CliError("failed", text.split(/\r?\n/).filter(Boolean).slice(-3).join(" ") || `aihub ${args.join(" ")} failed`, typeof e.code === "number" ? e.code : undefined));
        }),
        { cmd: cfg.prefixArgs?.length ? "aihub" : cfg.command, args },
      );
      const timer = setTimeout(() => settle(() => {
        killTree(child, platform);
        reject(new CliError("timeout", `aihub ${args.join(" ")} took longer than ${Math.round(cfg.timeoutMs / 1000)} s`));
      }), cfg.timeoutMs);
    });
}

/** Runs a `--json` read and parses it. */
export async function readJson<T>(run: Runner, args: string[], cwd: string): Promise<T> {
  const out = await run([...args, "--json"], cwd);
  const text = out.trim();
  const start = text.search(/[[{]/);
  try {
    return JSON.parse(start > 0 ? text.slice(start) : text) as T;
  } catch {
    throw new CliError("failed", `aihub ${args.join(" ")} did not print JSON`);
  }
}

const num = (s: string) => s.split(/[.-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);

/** true when `version` (like 1.0.2 or 1.1.0-next.5) is at least `min`. */
export function versionAtLeast(version: string, min: string): boolean {
  const a = num(version);
  const b = num(min);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

export const CLI_VERSION_KEY = "aihub.cliVersion";
const CLI_VERSION_TTL_MS = 24 * 3_600_000;

/** The version `checkCli` found, per CLI command, kept in the extension's global state. */
export interface CachedCliVersion {
  command: string;
  version: string;
  at: number;
}

/** True when the same command was checked less than a day ago and was new enough: no `aihub --version` needed. */
export function cliVersionStillKnown(known: CachedCliVersion | undefined, command: string, now: number): boolean {
  return !!known && known.command === command && now - known.at < CLI_VERSION_TTL_MS && now >= known.at && versionAtLeast(known.version, MIN_CLI_VERSION);
}

/** Throws a CliError of kind missing or old with the one clear message. */
export async function checkCli(run: Runner, cwd: string): Promise<string> {
  const out = (await run(["--version"], cwd)).trim();
  const m = out.match(/\d+\.\d+\.\d+\S*/);
  if (!m) throw new CliError("failed", `aihub --version printed '${out.slice(0, 60)}'`);
  if (!versionAtLeast(m[0], MIN_CLI_VERSION)) throw new CliError("old", `aihub ${m[0]} is too old (need ${MIN_CLI_VERSION} or newer). Update it with: ${INSTALL_COMMAND}`);
  return m[0];
}
