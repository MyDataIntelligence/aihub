import { posix, win32 } from "node:path";

/** Windows paths are judged as Windows paths on every platform (the rules run in tests on Linux too). */
const pathOf = (p: string) => (/^[A-Za-z]:|^\\\\/.test(p) ? win32 : posix);
const basename = (p: string) => pathOf(p).basename(p);
const isAbsolute = (p: string) => pathOf(p).isAbsolute(p);
const normalize = (p: string) => pathOf(p).normalize(p);

/**
 * The performance advisor's rules (`aihub doctor --perf`): measured facts in, findings out. Every finding carries its
 * evidence, exactly what would change, the risk, how to undo it, and whether it needs an administrator. Pure, so the
 * rules are tested on simulated measurements; perfFacts.ts does the measuring.
 */

export interface RepoFacts {
  path: string;
  /** Inside a folder OneDrive synchronises. */
  oneDrive: boolean;
  /** Windows Search indexes it: the service runs and the folder is not marked "not content indexed". */
  indexed?: boolean;
  /** On a network drive or a UNC path. */
  network: boolean;
  trackedFiles?: number;
  /** Longest tracked path, absolute, in characters. */
  longestPath?: number;
  /** Repository-level git settings as `git config --get` gives them (lower-case keys). */
  git: Record<string, string>;
}

export interface Facts {
  platform: NodeJS.Platform;
  /** Medians of a few probe starts, in ms. */
  nodeStartMs?: number;
  gitStartMs?: number;
  /** From the performance log of the last 24 h: median start-up of an aihub run and median git process. */
  logCliStartMs?: number;
  logGitMs?: number;
  /** Reading 100 fresh small files: a type antivirus scans (.js) and a type it skips cheaply (.dat), ms per 100 files. */
  avProbe?: { scannedMs: number; plainMs: number };
  /** Undefined when Defender's status could not be read (another antivirus, or no PowerShell). */
  defender?: { realtime: boolean; tamperProtected?: boolean; managedByPolicy?: boolean; exclusionsReadable: boolean; exclusionPaths?: string[]; exclusionProcesses?: string[] };
  nodePath?: string;
  gitPath?: string;
  home: string;
  repos: RepoFacts[];
}

export type Scope = "user" | "admin" | "info";

export interface Finding {
  id: string;
  cause: "defender" | "onedrive" | "indexing" | "git" | "longpaths" | "network";
  title: string;
  /** The measurements behind it; a finding without evidence is never made. */
  evidence: string[];
  scope: Scope;
  change: string;
  risk: string;
  undo: string;
  /** Commands that apply and undo it (PowerShell for admin, otherwise the plain command). Empty for "info". */
  apply: string[];
  revert: string[];
  /** For a laptop whose Defender is managed by IT: a ready request text instead of a command. */
  itRequest?: string;
}

export const LIMITS = { nodeStartMs: 300, gitStartMs: 80, manyFiles: 5000, longPath: 240 };

const ms = (n: number) => `${Math.round(n)} ms`;
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const name = (p: string) => basename(p.replace(/[\\/]+$/, "")) || p;

/** A Defender exclusion is only ever this narrow: an absolute repository or worktree folder, never a drive, the user folder, its parents or Windows. */
export function safeExclusionPath(p: string, home: string): boolean {
  if (!isAbsolute(p)) return false;
  const n = normalize(p).replace(/[\\/]+$/, "").toLowerCase();
  const h = normalize(home).replace(/[\\/]+$/, "").toLowerCase();
  const parts = n.split(/[\\/]+/).filter(Boolean);
  if (parts.length < 3) return false; // C:\ and C:\Users, C:\git
  if (n === h || h.startsWith(n + "\\") || h.startsWith(n + "/")) return false; // the home folder or a parent of it
  if (/^[a-z]:[\\/](windows|program files|program files \(x86\)|programdata)([\\/]|$)/.test(n)) return false;
  if (/[*?]/.test(n)) return false;
  return true;
}

/** Process exclusions: only the user's own node.exe and git.exe, by full path. */
export function safeExclusionProcess(p: string | undefined): p is string {
  return !!p && isAbsolute(p) && /^(node|git)\.exe$/i.test(basename(p));
}

export function decide(f: Facts): Finding[] {
  const out: Finding[] = [];
  const isWin = f.platform === "win32";

  // ---- Defender / antivirus: slow process starts, and the scan probe shows the cost -------------------------------
  const slow: string[] = [];
  if (f.nodeStartMs !== undefined && f.nodeStartMs > LIMITS.nodeStartMs) slow.push(`node starts in ${ms(f.nodeStartMs)} (normal < ${LIMITS.nodeStartMs} ms)`);
  if (f.gitStartMs !== undefined && f.gitStartMs > LIMITS.gitStartMs) slow.push(`git starts in ${ms(f.gitStartMs)} (normal < ${LIMITS.gitStartMs} ms)`);
  if (f.logGitMs !== undefined && f.logGitMs > LIMITS.gitStartMs) slow.push(`git calls of aihub took ${ms(f.logGitMs)} (median, performance log 24 h)`);
  if (f.logCliStartMs !== undefined && f.logCliStartMs > 2 * LIMITS.nodeStartMs) slow.push(`an aihub run needed ${ms(f.logCliStartMs)} to start (median, performance log 24 h)`);
  const scanCost = f.avProbe && f.avProbe.scannedMs > f.avProbe.plainMs * 1.5 + 5;
  const realtime = f.defender?.realtime;
  if (isWin && slow.length && (scanCost || realtime)) {
    const paths = f.repos.map((r) => r.path).filter((p) => safeExclusionPath(p, f.home));
    const already = new Set((f.defender?.exclusionPaths ?? []).map((p) => normalize(p).toLowerCase()));
    const todo = paths.filter((p) => !already.has(normalize(p).toLowerCase()));
    const procs = [f.nodePath, f.gitPath].filter(safeExclusionProcess).filter((p) => !(f.defender?.exclusionProcesses ?? []).some((x) => x.toLowerCase() === p.toLowerCase()));
    if (todo.length || procs.length) {
      const evidence = [...slow];
      if (f.avProbe) evidence.push(`reading 100 new script files took ${ms(f.avProbe.scannedMs)}, 100 plain data files ${ms(f.avProbe.plainMs)}${scanCost ? ": script files are scanned on open" : " (no scan delay measured on new files)"}`);
      if (realtime) evidence.push("Microsoft Defender real-time protection is on");
      if (f.defender && !f.defender.exclusionsReadable) evidence.push("the current exclusions can only be read by an administrator");
      const args = [todo.length ? `-ExclusionPath ${todo.map(q).join(",")}` : "", procs.length ? `-ExclusionProcess ${procs.map(q).join(",")}` : ""].filter(Boolean).join(" ");
      // managed by IT (Group Policy / Intune): the user cannot add exclusions, even as administrator
      const managed = !!f.defender?.managedByPolicy;
      out.push({
        id: "defender",
        cause: "defender",
        title: `Process starts are slow; Defender probably scans ${todo.length ? todo.map(name).join(", ") : "node and git"}. Add them to the exclusions?`,
        evidence,
        scope: "admin",
        change: `Microsoft Defender stops scanning ${[...todo, ...procs].join(", ")} (only these folders and programs; the rest of the PC stays protected).`,
        risk: "Malware inside these folders, or started by these programs, is no longer caught by the real-time scan. Keep them to your own repositories.",
        undo: "Remove-MpPreference with the same arguments (an administrator prompt again).",
        apply: [`Add-MpPreference ${args}`],
        revert: [`Remove-MpPreference ${args}`],
        itRequest: managed
          ? [
              "Request: Microsoft Defender exclusions for development folders",
              "",
              `On my laptop the development tools start slowly: ${slow.join("; ")}.`,
              f.avProbe ? `Measured: reading 100 new script files ${ms(f.avProbe.scannedMs)}, 100 data files ${ms(f.avProbe.plainMs)}.` : "",
              "Please add these narrow exclusions (Defender is managed by policy, I cannot add them myself):",
              ...todo.map((p) => `- folder: ${p}`),
              ...procs.map((p) => `- process: ${p}`),
              "They contain only source code repositories and the node/git programs I work with.",
            ]
              .filter((l) => l !== "")
              .join("\n")
          : undefined,
      });
    }
  }

  for (const r of f.repos) {
    const n = name(r.path);
    // ---- OneDrive ------------------------------------------------------------------------------------------------
    if (r.oneDrive)
      out.push({
        id: `onedrive:${n}`,
        cause: "onedrive",
        title: `${n} is in a OneDrive folder: every git change is uploaded and locked while syncing`,
        evidence: [`${r.path} is inside the folder OneDrive synchronises`],
        scope: "info",
        change: "Move the repository to a folder outside OneDrive (for example C:\\git) and clone it again there; git keeps its own history on the server.",
        risk: "None for the code on the server; local branches that are not pushed must be pushed or moved first.",
        undo: "Clone it back into the OneDrive folder.",
        apply: [],
        revert: [],
      });
    // ---- network drive ---------------------------------------------------------------------------------------------
    if (r.network)
      out.push({
        id: `network:${n}`,
        cause: "network",
        title: `${n} is on a network drive: every file read goes over the network`,
        evidence: [`${r.path} is on a network or UNC drive`],
        scope: "info",
        change: "Clone the repository to a local disk.",
        risk: "None; the network copy stays as it is.",
        undo: "Use the network copy again.",
        apply: [],
        revert: [],
      });
    // ---- Windows Search ----------------------------------------------------------------------------------------------
    if (isWin && r.indexed)
      out.push({
        id: `indexing:${n}`,
        cause: "indexing",
        title: `Windows Search indexes ${n}: every build and checkout is indexed again`,
        evidence: ["the Windows Search service is running", `${r.path} is not marked "not content indexed"`],
        scope: "user",
        change: `Marks ${r.path} and everything in it as "not content indexed" (the file attribute I); Windows Search skips it. Your own folder, no administrator needed.`,
        risk: "Files in it no longer show up in the Start menu or Explorer search by content (search by name still works).",
        undo: `attrib -I on the same folder (aihub doctor --perf --undo indexing:${n}).`,
        apply: [`attrib +I "${r.path}" /S /D`],
        revert: [`attrib -I "${r.path}" /S /D`],
      });
    // ---- git settings for large repositories ------------------------------------------------------------------------
    if ((r.trackedFiles ?? 0) >= LIMITS.manyFiles) {
      const want: [string, string][] = [];
      if (!/^(true|1)$/i.test(r.git["core.fsmonitor"] ?? "")) want.push(["core.fsmonitor", "true"]);
      if (!/^(true|1)$/i.test(r.git["core.untrackedcache"] ?? "")) want.push(["core.untrackedCache", "true"]);
      if (!/^(true|1)$/i.test(r.git["feature.manyfiles"] ?? "")) want.push(["feature.manyFiles", "true"]);
      if (isWin && /^(false|0)$/i.test(r.git["core.fscache"] ?? "")) want.push(["core.fscache", "true"]);
      if (want.length)
        out.push({
          id: `git:${n}`,
          cause: "git",
          title: `${n} has ${r.trackedFiles} files; git settings for large repositories are off`,
          evidence: [`${r.trackedFiles} tracked files (large from ${LIMITS.manyFiles})`, ...want.map(([k]) => `${k} is not set`)],
          scope: "user",
          change: `Sets in this repository only (.git/config): ${want.map(([k, v]) => `${k}=${v}`).join(", ")}. git status then asks a file-system monitor and a cache instead of reading every folder.`,
          risk: "core.fsmonitor starts a small git daemon per repository; feature.manyFiles changes the index format (version 4), which very old git versions cannot read.",
          undo: `git config --unset for each setting (aihub doctor --perf --undo git:${n}).`,
          apply: want.map(([k, v]) => `git -C "${r.path}" config ${k} ${v}`),
          revert: want.map(([k]) => `git -C "${r.path}" config --unset ${k}`),
        });
    }
    // ---- long paths ---------------------------------------------------------------------------------------------------
    if (isWin && (r.longestPath ?? 0) > LIMITS.longPath && !/^(true|1)$/i.test(r.git["core.longpaths"] ?? ""))
      out.push({
        id: `longpaths:${n}`,
        cause: "longpaths",
        title: `${n} has paths of ${r.longestPath} characters; git may fail on them`,
        evidence: [`the longest file path is ${r.longestPath} characters (Windows limit 260)`, "core.longpaths is not set"],
        scope: "user",
        change: "Sets core.longpaths=true in this repository only.",
        risk: "Some older Windows tools cannot open the longest paths; git itself works.",
        undo: `git config --unset core.longpaths (aihub doctor --perf --undo longpaths:${n}).`,
        apply: [`git -C "${r.path}" config core.longpaths true`],
        revert: [`git -C "${r.path}" config --unset core.longpaths`],
      });
  }
  return out;
}
