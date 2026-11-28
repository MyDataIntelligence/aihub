import { AihubError } from "../errors.js";
import type { TeamConfig } from "../team.js";

/**
 * The `preflight:` block of team.yaml: which pipeline YAML preflight reads, which of its steps run at which level, and the
 * values preflight cannot derive. Everything team-specific lives there; aihub itself knows no step names.
 */
export type Level = "local" | "read" | "apply";
export const LEVELS: Level[] = ["local", "read", "apply"];

export interface PreflightConfig {
  source: { repository?: string; ref: string };
  job: string;
  watch: string[];
  python?: string;
  shell?: "bash" | "cmd" | "pwsh";
  setup: string[];
  parameters: Record<string, string>;
  variables: Record<string, string>;
  /** variable name -> identity audience (fabric | onelake | storage | sql | powerbi | kusto) */
  tokens: Record<string, string>;
  steps: { local: string[]; read: string[]; apply: string[]; skip: string[] };
  apply: { refuseWorkspaces: string[]; destructive: { step: string; pattern: string }[] };
  /** optional: the CD pipeline whose queued or running run on this branch makes --apply wait */
  cd?: { pipeline?: string };
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined).map(String) : typeof v === "string" && v ? [v] : []);
const map = (v: unknown): Record<string, string> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, x === null || x === undefined ? "" : typeof x === "object" ? JSON.stringify(x) : String(x)]));
};

export const hasPreflight = (team: TeamConfig): boolean => !!team.preflight && typeof team.preflight === "object";

/** The block with defaults; `over` (command-line --job/--source/--ref) wins. Throws when no job is known. */
export function preflightConfig(team: TeamConfig, over: { job?: string; source?: string; ref?: string } = {}): PreflightConfig {
  const p = (team.preflight ?? {}) as Record<string, any>;
  const steps = (p.steps ?? {}) as Record<string, unknown>;
  const apply = (p.apply ?? {}) as Record<string, unknown>;
  const job = over.job ?? (typeof p.job === "string" ? p.job : "");
  if (!job) throw new AihubError("no pipeline YAML to read: set preflight.job in team.yaml, or pass --job <path in the source repository>");
  const shell = typeof p.shell === "string" ? p.shell.toLowerCase() : undefined;
  if (shell && !["bash", "cmd", "pwsh"].includes(shell)) throw new AihubError(`preflight.shell must be bash, cmd or pwsh, found "${p.shell}"`);
  const destructive = (Array.isArray(apply.destructive) ? apply.destructive : []).filter((d: any) => d && typeof d.step === "string" && typeof d.pattern === "string") as { step: string; pattern: string }[];
  for (const d of destructive) {
    try {
      new RegExp(d.pattern);
    } catch {
      throw new AihubError(`preflight.apply.destructive: the pattern of step "${d.step}" is not a valid regular expression: ${d.pattern}`);
    }
  }
  return {
    source: { repository: over.source ?? (typeof p.source?.repository === "string" && p.source.repository ? p.source.repository : undefined), ref: over.ref ?? (typeof p.source?.ref === "string" && p.source.ref ? p.source.ref : "main") },
    job: job.replace(/\\/g, "/").replace(/^\.?\//, ""),
    watch: strs(p.watch),
    python: typeof p.python === "string" && p.python ? p.python : undefined,
    shell: shell as PreflightConfig["shell"],
    setup: strs(p.setup),
    parameters: map(p.parameters),
    variables: map(p.variables),
    tokens: map(p.tokens),
    steps: { local: strs(steps.local), read: strs(steps.read), apply: strs(steps.apply), skip: strs(steps.skip) },
    apply: { refuseWorkspaces: strs(apply.refuseWorkspaces), destructive },
    cd: p.cd && typeof p.cd === "object" && typeof p.cd.pipeline === "string" ? { pipeline: p.cd.pipeline } : undefined,
  };
}

/** The level the team gave a step name (case-insensitive, surrounding spaces ignored), "skip", or undefined. */
export function levelOf(cfg: PreflightConfig, name: string): Level | "skip" | undefined {
  const n = norm(name);
  for (const l of [...LEVELS, "skip"] as const) if (cfg.steps[l].some((x) => norm(x) === n)) return l;
  return undefined;
}

export const norm = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();

/** Identity audiences a token variable may name. */
export const TOKEN_AUDIENCES: Record<string, "fabric" | "storage" | "sql" | "powerbi" | "kusto"> = {
  fabric: "fabric",
  onelake: "storage",
  storage: "storage",
  sql: "sql",
  powerbi: "powerbi",
  kusto: "kusto",
};
