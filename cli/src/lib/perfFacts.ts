import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "./proc.js";
import type { Facts, RepoFacts } from "./perfAdvisor.js";

/**
 * The measurements behind `aihub doctor --perf`: a few process starts, a file-scan probe, one PowerShell call for the
 * Windows facts (Defender status without administrator rights, Windows Search, drive type, folder attributes), git
 * settings per repository and the performance log of the last 24 h. Read-only: nothing is changed here.
 */

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] : undefined);

function timeStart(cmd: string, args: string[], n = 3): number | undefined {
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 15000 });
    if (r.error || r.status !== 0) return undefined;
    ms.push(performance.now() - t0);
  }
  return median(ms);
}

/** Reads 100 freshly written script files and 100 data files: an on-access scanner shows up as a difference. */
export function scanProbe(): { scannedMs: number; plainMs: number } | undefined {
  const dir = mkdtempSync(join(tmpdir(), "aihub-scan-"));
  try {
    const body = "module.exports = function f(a, b) { return [a, b].join(' '); };\n".repeat(40);
    const write = (ext: string) => Array.from({ length: 100 }, (_, i) => (writeFileSync(join(dir, `f${i}.${ext}`), body), join(dir, `f${i}.${ext}`)));
    const js = write("js");
    const dat = write("dat");
    const read = (files: string[]) => {
      const t0 = performance.now();
      for (const f of files) readFileSync(f);
      return Math.round(performance.now() - t0);
    };
    return { scannedMs: read(js), plainMs: read(dat) };
  } catch {
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const WIN_SCRIPT = (paths: string[]) => `
$ErrorActionPreference = 'SilentlyContinue'
$r = @{}
try { $s = Get-MpComputerStatus; $r.rt = [bool]$s.RealTimeProtectionEnabled; $r.tamper = [bool]$s.IsTamperProtected } catch {}
try { $p = Get-MpPreference; $r.ex = @($p.ExclusionPath); $r.exp = @($p.ExclusionProcess) } catch {}
$pol = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows Defender'
$r.policy = (Test-Path $pol) -and ((Get-ItemProperty $pol | Get-Member -MemberType NoteProperty | Where-Object { $_.Name -notlike 'PS*' }).Count -gt 0 -or (Test-Path "$pol\\Exclusions"))
$r.search = ((Get-Service WSearch).Status -eq 'Running')
$r.repos = @(${paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(",")} | ForEach-Object {
  $i = Get-Item -LiteralPath $_
  $d = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($_))
  @{ path = $_; notIndexed = [bool]($i.Attributes -band [System.IO.FileAttributes]::NotContentIndexed); drive = "$($d.DriveType)" }
})
$r | ConvertTo-Json -Depth 4 -Compress`;

interface WinFacts {
  rt?: boolean;
  tamper?: boolean;
  ex?: string[];
  exp?: string[];
  policy?: boolean;
  search?: boolean;
  repos?: { path: string; notIndexed: boolean; drive: string }[] | { path: string; notIndexed: boolean; drive: string };
}

function windowsFacts(paths: string[]): WinFacts | undefined {
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", WIN_SCRIPT(paths)], { encoding: "utf8", timeout: 30000 });
  if (r.error || r.status !== 0) return undefined;
  try {
    return JSON.parse(r.stdout.trim()) as WinFacts;
  } catch {
    return undefined;
  }
}

function gitFacts(root: string): Pick<RepoFacts, "git" | "trackedFiles" | "longestPath"> {
  const cfg = spawnSync("git", ["-C", root, "config", "--get-regexp", "^(core\\.(fsmonitor|untrackedcache|fscache|longpaths)|feature\\.manyfiles)$"], { encoding: "utf8" });
  const git: Record<string, string> = {};
  for (const l of (cfg.stdout ?? "").split(/\r?\n/)) {
    const m = /^(\S+)\s+(.*)$/.exec(l.trim());
    if (m) git[m[1].toLowerCase()] = m[2];
  }
  const ls = spawnSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const files = (ls.stdout ?? "").split("\0").filter(Boolean);
  const longest = files.reduce((m, f) => Math.max(m, f.length), 0);
  return { git, trackedFiles: files.length, longestPath: files.length ? resolve(root).length + 1 + longest : undefined };
}

const oneDriveRoots = (env: NodeJS.ProcessEnv) => [env.OneDrive, env.OneDriveCommercial, env.OneDriveConsumer].filter((x): x is string => !!x).map((x) => resolve(x).toLowerCase());

/** Median start-up of an aihub run and median git process of the last 24 h, from AIHUB_PERF_LOG. */
function fromPerfLog(env: NodeJS.ProcessEnv, now: number): { logCliStartMs?: number; logGitMs?: number } {
  const dir = env.AIHUB_PERF_LOG;
  if (!dir) return {};
  const start: number[] = [];
  const git: number[] = [];
  try {
    for (const f of readdirSync(dir).filter((n) => /^aihub-cli-perf-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))) {
      for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
        if (!line) continue;
        try {
          const e = JSON.parse(line) as { t: number; type: string; startupMs?: number; cmd?: string; ms?: number };
          if (now - e.t > 86_400_000) continue;
          if (e.type === "cli.run" && typeof e.startupMs === "number") start.push(e.startupMs);
          if (e.type === "cli.proc" && e.cmd === "git" && typeof e.ms === "number") git.push(e.ms);
        } catch {
          /* a cut-off line */
        }
      }
    }
  } catch {
    return {};
  }
  return { logCliStartMs: start.length >= 5 ? median(start) : undefined, logGitMs: git.length >= 5 ? median(git) : undefined };
}

function whereExe(cmd: string): string | undefined {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() || undefined : undefined;
}

export function gatherFacts(env: NodeJS.ProcessEnv, repoRoots: string[], now = Date.now()): Facts {
  const win = process.platform === "win32";
  const roots = [...new Set(repoRoots.map((p) => resolve(p)))];
  const w = win ? windowsFacts(roots) : undefined;
  const wRepos = w?.repos ? (Array.isArray(w.repos) ? w.repos : [w.repos]) : [];
  const od = oneDriveRoots(env);
  return {
    platform: process.platform,
    nodeStartMs: timeStart(process.execPath, ["-e", "0"]),
    gitStartMs: timeStart("git", ["--version"]),
    ...fromPerfLog(env, now),
    avProbe: scanProbe(),
    defender:
      w && w.rt !== undefined
        ? { realtime: !!w.rt, tamperProtected: w.tamper, managedByPolicy: !!w.policy, exclusionsReadable: !!w.ex && !w.ex.some((x) => /^N\/A/i.test(String(x))), exclusionPaths: (w.ex ?? []).filter((x) => !/^N\/A/i.test(String(x))), exclusionProcesses: (w.exp ?? []).filter((x) => !/^N\/A/i.test(String(x))) }
        : undefined,
    nodePath: process.execPath,
    gitPath: win ? whereExe("git") : undefined,
    home: env.USERPROFILE || env.HOME || homedir(),
    repos: roots.map((path) => {
      const wr = wRepos.find((x) => resolve(x.path).toLowerCase() === path.toLowerCase());
      const low = path.toLowerCase();
      return {
        path,
        oneDrive: od.some((o) => low === o || low.startsWith(o + "\\") || low.startsWith(o + "/")),
        // Windows Search indexes the user folders by default: a repository there that is not marked "not content indexed"
        indexed: wr ? !!w?.search && !wr.notIndexed && low.startsWith(resolve(env.USERPROFILE || homedir()).toLowerCase()) : undefined,
        network: path.startsWith("\\\\") || wr?.drive === "Network",
        ...gitFacts(path),
      };
    }),
  };
}
