/**
 * The Performance Advisor's VS Code part (the CLI, `aihub doctor --perf`, measures git, Defender, OneDrive, indexing):
 * large folders missing from files.watcherExclude / search.exclude, and which single finding may be offered as a
 * notification. Pure, so the decisions are tested without VS Code.
 */

/** The shape `aihub doctor --perf --json` gives per finding (plus the ones made here). */
export interface AdvisorFinding {
  id: string;
  cause: string;
  title: string;
  evidence: string[];
  scope: "user" | "admin" | "info";
  change: string;
  risk: string;
  undo: string;
  apply: string[];
  revert: string[];
  itRequest?: string;
  /** VS Code settings this finding sets (made here, applied by the extension, not the CLI). */
  settings?: { key: "files.watcherExclude" | "search.exclude"; add: Record<string, boolean> }[];
}

/** Folders that are large, generated and never worth watching or searching. */
export const HEAVY_DIRS = ["node_modules", ".venv", "venv", "target", "build", "dist", ".git/objects", ".pytest_cache", "__pycache__", ".tox", "bin/Debug", "obj"];

export interface FolderFacts {
  name: string;
  /** Heavy folders found in the workspace folder (relative, forward slashes), with a rough file count. */
  heavy: { dir: string; files: number }[];
}

/** A glob in an exclude setting that already covers `dir`. */
export function covered(dir: string, settings: Record<string, unknown>): boolean {
  const last = dir.split("/").pop()!;
  return Object.entries(settings).some(([glob, on]) => on === true && (glob === `**/${dir}` || glob === `**/${dir}/**` || glob === `**/${dir}/*/**` || glob === `**/${last}` || glob === `**/${last}/**` || glob === `**/${last}/*/**` || glob === `${dir}/**` || glob === `**/${dir}/*`));
}

export function vscodeFindings(folders: FolderFacts[], watcherExclude: Record<string, unknown>, searchExclude: Record<string, unknown>): AdvisorFinding[] {
  const out: AdvisorFinding[] = [];
  const heavy = new Map<string, number>();
  for (const f of folders) for (const h of f.heavy) heavy.set(h.dir, (heavy.get(h.dir) ?? 0) + h.files);
  const big = [...heavy.entries()].filter(([, n]) => n >= 200);
  const watch = big.filter(([d]) => !covered(d, watcherExclude));
  const search = big.filter(([d]) => !covered(d, searchExclude));
  if (watch.length || search.length) {
    const glob = (d: string) => `**/${d}/**`;
    const settings: AdvisorFinding["settings"] = [];
    if (watch.length) settings.push({ key: "files.watcherExclude", add: Object.fromEntries(watch.map(([d]) => [glob(d), true])) });
    if (search.length) settings.push({ key: "search.exclude", add: Object.fromEntries(search.map(([d]) => [glob(d), true])) });
    out.push({
      id: "vscode:exclude",
      cause: "vscode",
      title: `VS Code watches and searches ${[...new Set([...watch, ...search].map(([d]) => d))].join(", ")} (${[...new Set([...watch, ...search])].reduce((n, [, c]) => n + c, 0)} files)`,
      evidence: [...watch.map(([d, n]) => `${d}: ${n} files, not in files.watcherExclude`), ...search.map(([d, n]) => `${d}: ${n} files, not in search.exclude`)],
      scope: "user",
      change: settings.map((s) => `${s.key} += ${Object.keys(s.add).join(", ")}`).join("; ") + " (workspace settings of this window).",
      risk: "Changes in these folders no longer reach the file watcher, and search skips them; build output and dependencies only.",
      undo: "Undo in the Performance Advisor puts the previous values back.",
      apply: [],
      revert: [],
      settings,
    });
  }
  return out;
}

export interface NotifyState {
  /** Finding ids already offered once (never again). */
  offered: string[];
  /** "Never for this". */
  never: string[];
  /** When the last notification was shown. */
  lastAt?: number;
}

/** At most one notification per day, one finding, never one already offered or refused; info-only findings stay in the overview. */
export function pickNotification(findings: AdvisorFinding[], s: NotifyState, now: number): AdvisorFinding | undefined {
  if (s.lastAt !== undefined && now - s.lastAt < 86_400_000) return undefined;
  return findings.find((f) => f.scope !== "info" && !s.offered.includes(f.id) && !s.never.includes(f.id));
}
