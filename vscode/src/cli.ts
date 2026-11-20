import { trackedExecFile } from "./perf/probe";

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

/** Runs `aihub <args>` once, with a time limit. The extension has no other way to read data. */
export function makeRunner(cfg: CliConfig, platform: NodeJS.Platform = process.platform): Runner {
  return (args, cwd) =>
    new Promise((resolve, reject) => {
      const all = [...(cfg.prefixArgs ?? []), ...args];
      const shell = needsShell(cfg, platform);
      trackedExecFile(
        shell ? quote(cfg.command) : cfg.command,
        shell ? all.map(quote) : all,
        { cwd, timeout: cfg.timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, shell, env: { ...process.env, ...cfg.env, NO_COLOR: "1" } },
        (err, stdout, stderr) => {
          if (!err) return resolve(stdout);
          const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
          if (e.code === "ENOENT") return reject(new CliError("missing", `aihub was not found. Install it with: ${INSTALL_COMMAND}`));
          if (e.killed) return reject(new CliError("timeout", `aihub ${args.join(" ")} took longer than ${Math.round(cfg.timeoutMs / 1000)} s`));
          const text = `${stderr || ""}${stdout || ""}`.trim();
          // cmd.exe says "not recognized" with exit code 1 when the shim is missing
          if (/not recognized as an internal or external command|command not found/i.test(text)) return reject(new CliError("missing", `aihub was not found. Install it with: ${INSTALL_COMMAND}`));
          reject(new CliError("failed", text.split(/\r?\n/).filter(Boolean).slice(-3).join(" ") || `aihub ${args.join(" ")} failed`, typeof e.code === "number" ? e.code : undefined));
        },
        { cmd: cfg.prefixArgs?.length ? "aihub" : cfg.command, args },
      );
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

/** Throws a CliError of kind missing or old with the one clear message. */
export async function checkCli(run: Runner, cwd: string): Promise<string> {
  const out = (await run(["--version"], cwd)).trim();
  const m = out.match(/\d+\.\d+\.\d+\S*/);
  if (!m) throw new CliError("failed", `aihub --version printed '${out.slice(0, 60)}'`);
  if (!versionAtLeast(m[0], MIN_CLI_VERSION)) throw new CliError("old", `aihub ${m[0]} is too old (need ${MIN_CLI_VERSION} or newer). Update it with: ${INSTALL_COMMAND}`);
  return m[0];
}
