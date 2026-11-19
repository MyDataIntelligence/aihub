import { spawnSync } from "./proc.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { findProfiles, findProjects, routeOf, type DbtProject, type ProfileTarget, type Route } from "./fabric-dbt.js";
import { redact } from "./fabric-redact.js";
import { repoRoot } from "./git.js";

/** Local dbt: find the project, find the CLI (project venv first), run it without a shell and read its output. */
export const READ_VERBS = ["test", "compile", "show", "ls", "deps", "debug", "parse", "freshness", "docs"] as const;
/** Verbs that write to the warehouse; on a Fabric adapter they stay behind `aihub fabric dbt run` (workspace guard). */
export const WRITE_VERBS = ["build", "run", "seed", "snapshot", "run-operation", "retry"] as const;
export const VERBS: readonly string[] = [...WRITE_VERBS, ...READ_VERBS];

export interface Spawned {
  status: number;
  stdout: string;
  stderr: string;
}
export type SpawnFn = (cmd: string, args: string[], cwd: string, timeoutMs: number) => Spawned;

const ANSI = /\u001b\[[0-9;]*m/g;
export const clean = (s: string): string => redact(s.replace(ANSI, "").replace(/\r\n/g, "\n"));

/** `.env` next to the project: passed to dbt, never printed. */
export function dotEnv(dir: string): Record<string, string> {
  const f = join(dir, ".env");
  if (!existsSync(f)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#")) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

export function spawnWith(env: NodeJS.ProcessEnv, extra: Record<string, string> = {}): SpawnFn {
  return (cmd, args, cwd, timeoutMs) => {
    const r = spawnSync(cmd, args, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      shell: false,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...env, ...extra, DO_NOT_TRACK: "1", DBT_SEND_ANONYMOUS_USAGE_STATS: "False", DBT_USE_COLORS: "False" },
    });
    if (r.error) throw new AihubError(`could not run ${cmd}: ${(r.error as Error).message}`);
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

/** The dbt CLI: the project's virtual environment (`.venv`, `venv`, `.venv-dbt`, also in the repository root), then PATH. */
export function locateDbt(dirs: string[]): string {
  const win = process.platform === "win32";
  for (const d of dirs) {
    for (const venv of [".venv", "venv", ".venv-dbt"]) {
      for (const sub of win ? ["Scripts"] : ["bin"]) {
        const p = join(d, venv, sub, win ? "dbt.exe" : "dbt");
        if (existsSync(p)) return p;
      }
    }
  }
  return "dbt";
}

export interface Project {
  /** repository root (or the working folder outside a repository) */
  root: string;
  /** absolute project folder */
  dir: string;
  info: DbtProject;
}

/** The dbt project: --project, else the one the working folder is in, else the only one in the repository. */
export function resolveProject(ctx: Ctx, projectArg?: string): Project {
  let root = ctx.cwd;
  try {
    root = repoRoot(ctx.cwd);
  } catch {
    /* outside a repository: the working folder is the root */
  }
  const projects = findProjects(root);
  if (projectArg) {
    const dir = resolve(ctx.cwd, projectArg);
    if (dir !== resolve(root) && !dir.startsWith(resolve(root) + sep)) throw new AihubError("--project must be a folder inside the repository");
    if (!existsSync(join(dir, "dbt_project.yml"))) throw new AihubError(`no dbt_project.yml in ${projectArg}`);
    const info = projects.find((p) => resolve(root, p.path) === dir) ?? findProjects(dir)[0];
    return { root, dir, info: info! };
  }
  let up = resolve(ctx.cwd);
  while (up.startsWith(resolve(root)) && up !== dirname(up)) {
    const hit = projects.find((p) => resolve(root, p.path) === up);
    if (hit) return { root, dir: up, info: hit };
    up = dirname(up);
  }
  if (projects.length === 1) return { root, dir: resolve(root, projects[0].path), info: projects[0] };
  if (!projects.length) throw new AihubError("no dbt project (dbt_project.yml) found in this repository");
  throw new AihubError(`several dbt projects: pass --project <folder> (${projects.map((p) => p.path).join(", ")})`);
}

export interface Runner {
  run: (args: string[], timeoutMs?: number) => Spawned;
  /** dbt without --project-dir (top-level flags such as --version) */
  raw: (args: string[], timeoutMs?: number) => Spawned;
  bin: string;
}

/** A runner bound to one project: dbt with --project-dir, the project's `.env` and no tracking. */
export function dbtRunner(ctx: Ctx, p: Project): Runner {
  const bin = locateDbt([p.dir, p.root]);
  const spawn = ctx.spawn ?? spawnWith(ctx.env, dotEnv(p.dir));
  return {
    bin,
    raw: (args, timeoutMs = 30_000) => spawn(bin, args, p.dir, timeoutMs),
    run: (args, timeoutMs = 600_000) => {
      const prof = existsSync(join(p.dir, "profiles.yml")) ? ["--profiles-dir", p.dir] : [];
      return spawn(bin, [...args, "--project-dir", p.dir, ...prof], p.dir, timeoutMs);
    },
  };
}

export interface Selected {
  profile?: string;
  target?: ProfileTarget;
  adapter: string;
  route: Route;
}

/** The profile target dbt would use (`--target` or the profile's default). */
export function selectedTarget(ctx: Ctx, p: Project, target?: string): Selected {
  const prof = findProfiles(p.dir, ctx.env);
  const t = prof.targets.find((x) => x.profile === p.info.profile && (target ? x.target === target : x.isDefault)) ?? (target ? undefined : prof.targets.find((x) => x.profile === p.info.profile));
  return { profile: p.info.profile, target: t, adapter: t?.adapter ?? "?", route: t ? routeOf(t.adapter) : "other" };
}

export const CAPACITY = /TooManyRequestsForCapacity|HTTP.{0,12}\b430\b|status code 430/i;
export const CAPACITY_NOTE = "the Fabric capacity is full (a trial capacity runs one Spark session at a time): list and stop idle sessions with `aihub fabric spark sessions --workspace <ws>` and `aihub fabric spark stop --workspace <ws> --all-mine --dry-run`, then run again";

/** Split a selector into arguments: `a+ b+` selects two sets. A word that looks like a flag is refused. */
export function selectorArgs(value: string | undefined, flag: string): string[] {
  if (!value?.trim()) return [];
  const words = value.trim().split(/\s+/);
  if (words.some((w) => w.startsWith("-"))) throw new AihubError(`--${flag} must not look like a flag`);
  return words;
}

export interface Version {
  core?: string;
  plugins: Record<string, string>;
  raw: string;
}

export function parseVersion(text: string): Version {
  const t = clean(text);
  const core = /Core:[\s\S]*?installed:\s*([\w.\-]+)/.exec(t)?.[1];
  const plugins: Record<string, string> = {};
  const block = /Plugins:\n([\s\S]*?)(?:\n\S|$)/.exec(t)?.[1] ?? "";
  for (const m of block.matchAll(/^\s*-\s*([\w-]+):\s*([\w.\-]+)/gm)) plugins[m[1]] = m[2];
  return { core, plugins, raw: t.split("\n").slice(0, 8).join(" ").trim() };
}
