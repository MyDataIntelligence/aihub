import type { AdoClient } from "./ado.js";
import { AihubError } from "./errors.js";
import { anyGlob } from "./glob.js";
import type { TeamConfig } from "./team.js";

export interface RobotSuite {
  name: string;
  /** Path patterns of the flow (source) this suite covers. */
  paths: string[];
  /** Path patterns of the Robot test files of this suite. */
  tests?: string[];
}

export interface RobotConfig {
  pipeline?: string;
  integrationBranch?: string;
  /** Per-repository integration branches (first entry without `repository` is the default). */
  integrationBranches?: { repository?: string; branch: string; requires?: string[] }[];
  /** Branches that must already be merged into the integration branch (e.g. staging). */
  integrationRequires?: string[];
  /** Named places to run Robot: `feature` (merge the feature branch first), `staging` (as is), ... */
  targets?: Record<string, { branch: string; mergeMyBranchFirst?: boolean; mustAlreadyContain?: string[] }>;
  defaultTarget?: string;
  suites: RobotSuite[];
}

export interface RobotTarget {
  name: string;
  branch: string;
  merge: boolean;
  requires: string[];
}

/** `--on` (target name or plain branch), else robot.defaultTarget, else the legacy integration branch (merged). */
export function resolveTarget(cfg: RobotConfig, repo: string | undefined, on?: string): RobotTarget | undefined {
  const targets = cfg.targets ?? {};
  const find = (n: string) => Object.entries(targets).find(([k]) => k.toLowerCase() === n.toLowerCase());
  const make = (name: string, t: { branch: string; mergeMyBranchFirst?: boolean; mustAlreadyContain?: string[] }): RobotTarget => ({
    name,
    branch: t.branch,
    merge: t.mergeMyBranchFirst ?? false,
    requires: t.mustAlreadyContain ?? [],
  });
  if (on) {
    const hit = find(on);
    return hit ? make(hit[0], hit[1]) : { name: on, branch: on, merge: false, requires: [] };
  }
  if (cfg.defaultTarget) {
    const hit = find(cfg.defaultTarget);
    if (!hit) throw new AihubError(`robot.defaultTarget '${cfg.defaultTarget}' is not in robot.targets (${Object.keys(targets).join(", ") || "none"})`);
    return make(hit[0], hit[1]);
  }
  const legacy = resolveIntegration(cfg, repo);
  return legacy.branch ? { name: "integration", branch: legacy.branch, merge: true, requires: legacy.requires } : undefined;
}

export function formatTargets(cfg: RobotConfig): string {
  const entries = Object.entries(cfg.targets ?? {});
  if (!entries.length) return cfg.integrationBranch ? `robot targets: integration -> ${cfg.integrationBranch} (merges the feature branch first)` : "robot targets: none in team.yaml robot.targets";
  const lines = ["robot targets:"];
  for (const [name, t] of entries) {
    const req = t.mustAlreadyContain?.length ? `; must already contain ${t.mustAlreadyContain.join(", ")}` : "";
    lines.push(`- ${name} -> ${t.branch} (${t.mergeMyBranchFirst ? "merges the feature branch first" : "runs the branch as is"}${req})${name === cfg.defaultTarget ? " [default]" : ""}`);
  }
  lines.push("use: aihub robot run --on <name|branch>");
  return lines.join("\n");
}

export function resolveIntegration(cfg: RobotConfig, repo?: string): { branch?: string; requires: string[] } {
  const list = cfg.integrationBranches ?? [];
  const hit = list.find((e) => e.repository && repo && e.repository.toLowerCase() === repo.toLowerCase()) ?? list.find((e) => !e.repository);
  const branch = hit?.branch ?? cfg.integrationBranch;
  return { branch, requires: hit?.requires ?? cfg.integrationRequires ?? [] };
}

export function robotConfig(team: TeamConfig): RobotConfig {
  const r = (team as { robot?: Partial<RobotConfig> }).robot ?? {};
  const suites = (r.suites ?? []).filter((s) => !!s?.name && Array.isArray(s.paths)) as RobotSuite[];
  return { pipeline: r.pipeline, integrationBranch: r.integrationBranch, integrationBranches: r.integrationBranches, integrationRequires: r.integrationRequires, targets: r.targets, defaultTarget: r.defaultTarget, suites };
}

export interface SuiteNeed {
  suite: string;
  /** Changed files that belong to the flow. */
  flowFiles: string[];
  /** Changed Robot test files of this suite (empty: the flow changed but no test did). */
  testFiles: string[];
}

export function robotNeeded(files: string[], cfg: RobotConfig): SuiteNeed[] {
  const out: SuiteNeed[] = [];
  for (const s of cfg.suites) {
    const flowFiles = files.filter((f) => anyGlob(s.paths, f) && !(s.tests && anyGlob(s.tests, f)));
    const testFiles = s.tests ? files.filter((f) => anyGlob(s.tests!, f)) : [];
    if (flowFiles.length || testFiles.length) out.push({ suite: s.name, flowFiles, testFiles });
  }
  return out;
}

export function formatNeeded(needs: SuiteNeed[], cfg: RobotConfig, branch: string): string {
  if (!cfg.suites.length) return "robot: no suites in team.yaml robot.suites; nothing to decide";
  if (!needs.length) return `robot: not needed for ${branch}: no changed file belongs to a flow with Robot tests`;
  const lines = [`robot: needed for ${branch}: ${needs.length} suite${needs.length === 1 ? "" : "s"}`];
  for (const n of needs) {
    const t = n.testFiles.length
      ? `tests changed (${n.testFiles.length})`
      : "no Robot test changed: a new or changed flow needs a new or adjusted test";
    lines.push(`- ${n.suite}: ${n.flowFiles.length} flow file${n.flowFiles.length === 1 ? "" : "s"}; ${t}`);
  }
  lines.push(`run: aihub robot run --suite ${needs[0].suite}`);
  return lines.join("\n");
}

// ---- Azure DevOps pipeline -------------------------------------------------

export interface Build {
  id: number;
  status: string;
  result?: string;
  buildNumber?: string;
  _links?: { web?: { href?: string } };
}

export async function robotDefinitionId(c: AdoClient, pipeline: string): Promise<number> {
  const defs = await c.get<{ value?: { id: number; name: string }[] }>("build/definitions", { name: pipeline });
  const def = (defs.value ?? []).find((d) => d.name.toLowerCase() === pipeline.toLowerCase());
  if (!def) throw new AihubError(`pipeline '${pipeline}' not found in Azure DevOps; check robot.pipeline in team.yaml or pass --pipeline`);
  return def.id;
}

export async function queueRobot(
  c: AdoClient,
  opts: { definitionId: number; branch: string; suite?: string; include?: string },
): Promise<Build> {
  const templateParameters: Record<string, string> = {};
  if (opts.suite) templateParameters.suite = opts.suite;
  if (opts.include) templateParameters.include = opts.include;
  return c.post<Build>("build/builds", {
    definition: { id: opts.definitionId },
    sourceBranch: opts.branch.startsWith("refs/") ? opts.branch : `refs/heads/${opts.branch}`,
    ...(Object.keys(templateParameters).length ? { templateParameters } : {}),
  });
}

export async function followBuild(c: AdoClient, id: number, pollMs: number, timeoutMs = 4 * 3600_000): Promise<Build> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const b = await c.get<Build>(`build/builds/${id}`);
    if (b.status === "completed") return b;
    if (Date.now() > deadline) throw new AihubError(`build ${id} still ${b.status} after the timeout; check it in Azure DevOps`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export interface TimelineRecord {
  name: string;
  type: string;
  result?: string;
  issues?: { type: string; message: string }[];
}

/** Results summary: build result, test counts (when published) and failed steps with their first error lines. */
export async function summarize(c: AdoClient, b: Build): Promise<string> {
  const lines = [`build ${b.buildNumber ?? b.id}: ${b.result ?? b.status}${b._links?.web?.href ? ` ${b._links.web.href}` : ""}`];
  try {
    const runs = await c.get<{ value?: { name?: string; totalTests?: number; passedTests?: number; unanalyzedTests?: number }[] }>("test/runs", {
      buildUri: `vstfs:///Build/Build/${b.id}`,
    });
    for (const r of runs.value ?? []) {
      const total = r.totalTests ?? 0;
      const passed = r.passedTests ?? 0;
      lines.push(`tests ${r.name ?? "run"}: ${passed}/${total} passed, ${total - passed} failed`);
    }
  } catch {
    /* test results are optional */
  }
  try {
    const t = await c.get<{ records?: TimelineRecord[] }>(`build/builds/${b.id}/timeline`);
    const failed = (t.records ?? []).filter((r) => r.result === "failed" && r.type !== "Stage" && r.type !== "Phase" && r.type !== "Job");
    for (const r of failed.slice(0, 5)) {
      const msg = (r.issues ?? []).find((i) => i.type === "error")?.message ?? "no error message";
      lines.push(`failed: ${r.name}: ${msg.replace(/\s+/g, " ").trim().slice(0, 300)}`);
    }
  } catch {
    /* timeline is optional */
  }
  return lines.join("\n");
}
