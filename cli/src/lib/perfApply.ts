import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AihubError } from "./errors.js";
import type { Finding } from "./perfAdvisor.js";
import { spawnSync } from "./proc.js";

/**
 * Applying and undoing an advisor finding. Settings of the user (git config of a repository, a folder attribute) run
 * directly; administrator changes (Defender) only with `elevate`, through one UAC prompt, and never without it. Every
 * applied change is written down with its undo commands in `<AIHUB_HOME or ~/.aihub>/perf-advisor.json`.
 */

export interface Applied {
  id: string;
  title: string;
  scope: Finding["scope"];
  at: string;
  apply: string[];
  revert: string[];
}

export const recordFile = (env: NodeJS.ProcessEnv) => join(env.AIHUB_HOME || join(env.USERPROFILE || env.HOME || homedir(), ".aihub"), "perf-advisor.json");

export function readApplied(env: NodeJS.ProcessEnv): Applied[] {
  try {
    return (JSON.parse(readFileSync(recordFile(env), "utf8")) as { applied?: Applied[] }).applied ?? [];
  } catch {
    return [];
  }
}

function writeApplied(env: NodeJS.ProcessEnv, applied: Applied[]) {
  const f = recordFile(env);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify({ applied }, null, 2), "utf8");
}

export type Runner = (command: string, admin: boolean) => { ok: boolean; output: string };

/** Runs one command line: a shell for user changes, an elevated PowerShell (UAC) for administrator changes. */
export const runCommand: Runner = (command, admin) => {
  const win = process.platform === "win32";
  const r = admin
    ? spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-Command',${psQuote(command)}`], { encoding: "utf8", timeout: 300_000 })
    : win
      ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${command}"`], { encoding: "utf8", windowsVerbatimArguments: true, timeout: 300_000 })
      : spawnSync("sh", ["-c", command], { encoding: "utf8", timeout: 300_000 });
  return { ok: !r.error && r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() || (r.error?.message ?? "") };
};

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

export interface ApplyOptions {
  /** Administrator changes need this: the caller (the VS Code button) asked the user. */
  elevate?: boolean;
  dryRun?: boolean;
  run?: Runner;
  now?: () => number;
}

/** Applies a finding; returns the lines to show. */
export function applyFinding(env: NodeJS.ProcessEnv, f: Finding, o: ApplyOptions = {}): string[] {
  if (f.scope === "info" || !f.apply.length) throw new AihubError(`${f.id} has nothing to apply: ${f.change}`);
  if (f.scope === "admin" && !o.elevate && !o.dryRun) throw new AihubError(`${f.id} needs an administrator: run it with --elevate (one UAC prompt), or ask IT. Command: ${f.apply.join("; ")}`);
  if (o.dryRun) return [`dry-run: would run${f.scope === "admin" ? " as administrator (UAC prompt)" : ""}:`, ...f.apply.map((c) => `  ${c}`), "undo:", ...f.revert.map((c) => `  ${c}`)];
  const run = o.run ?? runCommand;
  const out: string[] = [];
  for (const c of f.apply) {
    const r = run(c, f.scope === "admin");
    if (!r.ok) throw new AihubError(`${c} failed: ${r.output.split(/\r?\n/)[0]}${f.itRequest ? " (Defender is managed by IT: use the IT request text)" : ""}`);
    out.push(`ran: ${c}`);
  }
  const applied = readApplied(env).filter((a) => a.id !== f.id);
  applied.push({ id: f.id, title: f.title, scope: f.scope, at: new Date((o.now ?? Date.now)()).toISOString(), apply: f.apply, revert: f.revert });
  writeApplied(env, applied);
  out.push(`recorded in ${recordFile(env)}; undo: aihub doctor --perf --undo ${f.id}`);
  return out;
}

export function undoApplied(env: NodeJS.ProcessEnv, id: string, o: ApplyOptions = {}): string[] {
  const all = readApplied(env);
  const a = all.find((x) => x.id === id);
  if (!a) throw new AihubError(`nothing applied with id ${id}; applied: ${all.map((x) => x.id).join(", ") || "none"}`);
  if (a.scope === "admin" && !o.elevate && !o.dryRun) throw new AihubError(`undoing ${id} needs an administrator: run it with --elevate. Command: ${a.revert.join("; ")}`);
  if (o.dryRun) return ["dry-run: would run:", ...a.revert.map((c) => `  ${c}`)];
  const run = o.run ?? runCommand;
  const out: string[] = [];
  for (const c of a.revert) {
    const r = run(c, a.scope === "admin");
    // an unset of a setting that is already gone is fine
    if (!r.ok && !/config --unset/.test(c)) throw new AihubError(`${c} failed: ${r.output.split(/\r?\n/)[0]}`);
    out.push(`ran: ${c}`);
  }
  writeApplied(env, all.filter((x) => x.id !== id));
  return out;
}

