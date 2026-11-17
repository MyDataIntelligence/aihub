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
  suites: RobotSuite[];
}

export function robotConfig(team: TeamConfig): RobotConfig {
  const r = (team as { robot?: Partial<RobotConfig> }).robot ?? {};
  const suites = (r.suites ?? []).filter((s) => !!s?.name && Array.isArray(s.paths)) as RobotSuite[];
  return { pipeline: r.pipeline, integrationBranch: r.integrationBranch, suites };
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

export async function queueRobot(
  c: AdoClient,
  opts: { pipeline: string; branch: string; suite?: string; include?: string },
): Promise<Build> {
  const defs = await c.get<{ value?: { id: number; name: string }[] }>("build/definitions", { name: opts.pipeline });
  const def = (defs.value ?? []).find((d) => d.name.toLowerCase() === opts.pipeline.toLowerCase());
  if (!def) throw new AihubError(`pipeline '${opts.pipeline}' not found in Azure DevOps; check robot.pipeline in team.yaml or pass --pipeline`);
  const templateParameters: Record<string, string> = {};
  if (opts.suite) templateParameters.suite = opts.suite;
  if (opts.include) templateParameters.include = opts.include;
  return c.post<Build>("build/builds", {
    definition: { id: def.id },
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
