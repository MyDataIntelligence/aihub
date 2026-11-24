import { parseArgs } from "node:util";
import { changedFiles } from "../lib/changes.js";
import { repoClient, type Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { formatIntegrate, integrate } from "../lib/integrate.js";
import { currentBranch, repoRoot } from "../lib/git.js";
import { followBuild, formatNeeded, queueRobot, formatTargets, resolveTarget, robotConfig, robotDefinitionId, robotNeeded, summarize } from "../lib/robot.js";
import { environmentsOf, findRunner, findSuites, localCommand, readResult } from "../lib/robotLocal.js";
import { loadTeam } from "../lib/team.js";

/**
 * aihub robot local [--json]: the runner, the suites with their test cases and the test environments of this repository.
 * --command [--file f] [--test t] [--env e]: the exact local command (folder, program, arguments, environment variables).
 * aihub robot result [--since ms] [--dir d]: the newest Robot result written after --since (counts, failures, log.html).
 */
async function local(sub: string, argv: string[], ctx: Ctx): Promise<void> {
  let v: Record<string, string | boolean | undefined>;
  try {
    v = parseArgs({ args: argv, options: { json: { type: "boolean" }, command: { type: "boolean" }, file: { type: "string" }, test: { type: "string" }, env: { type: "string" }, since: { type: "string" }, dir: { type: "string" } } }).values;
  } catch (e) {
    throw new AihubError((e as Error).message);
  }
  const root = repoRoot(ctx.cwd);
  const team = loadTeam(root);
  if (sub === "result") {
    const dir = (v.dir as string | undefined) ?? findRunner(root, team)?.cwd ?? root;
    const r = readResult(dir, Number(v.since ?? 0) || 0);
    if (v.json) return void ctx.out(JSON.stringify(r ?? null));
    if (!r) return void ctx.out("no Robot result found");
    ctx.out(`${r.status}: ${r.pass} passed, ${r.fail} failed, ${r.skip} skipped${r.log ? ` (log: ${r.log})` : ""}`);
    for (const f of r.failed) ctx.out(`  FAIL ${f.name}: ${f.message}`);
    return;
  }
  if (v.command) {
    const c = localCommand(root, team, { file: v.file as string | undefined, test: v.test as string | undefined, env: v.env as string | undefined });
    const shown = [c.exe, ...c.args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
    return void ctx.out(v.json ? JSON.stringify(c) : `cd "${c.cwd}"\n${Object.entries(c.env).map(([k, x]) => `set ${k}=${x}\n`).join("")}${shown}`);
  }
  const runner = findRunner(root, team);
  const suites = findSuites(root);
  const environments = environmentsOf(team);
  if (v.json) return void ctx.out(JSON.stringify({ root, runner: runner ?? null, suites, environments }));
  ctx.out(`runner: ${runner ? runner.script : "python -m robot (no rf-run.py and no team.yaml robot.runner)"}`);
  ctx.out(`environments: ${environments.join(", ") || "none (team.yaml robot.environments)"}`);
  for (const s of suites) ctx.out(`${s.rel}: ${s.tests.map((t) => t.name).join("; ") || "no test cases"}`);
}

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub === "local" || sub === "result") return local(sub, rest, ctx);
  let v: Record<string, string | boolean | undefined>;
  try {
    v = parseArgs({
      args: rest,
      options: {
        branch: { type: "string" },
        target: { type: "string" },
        suite: { type: "string" },
        include: { type: "string" },
        pipeline: { type: "string" },
        "no-wait": { type: "boolean" },
        "no-merge": { type: "boolean" },
        on: { type: "string" },
      },
    }).values;
  } catch (e) {
    throw new AihubError((e as Error).message);
  }
  if (sub !== "needed" && sub !== "run" && sub !== "targets") throw new AihubError("usage: aihub robot needed|run|targets [flags] | robot local [--json] [--command --file f --test t --env e] | robot result [--since <epoch ms>] [--dir d] [--json]");

  const { root, client } = repoClient(ctx);
  const team = loadTeam(root);
  const cfg = robotConfig(team);

  if (sub === "targets") {
    ctx.out(formatTargets(cfg));
    return;
  }

  if (sub === "needed") {
    const c = changedFiles(root, team, { branch: v.branch as string | undefined, target: v.target as string | undefined });
    ctx.out(formatNeeded(robotNeeded(c.files, cfg), cfg, c.branch));
    return;
  }

  const pipeline = (v.pipeline as string | undefined) ?? cfg.pipeline;
  if (!pipeline) throw new AihubError("no Robot pipeline: set robot.pipeline in team.yaml or pass --pipeline <name>");
  const target = resolveTarget(cfg, client.remote.repo, v.on as string | undefined);
  if (!target) throw new AihubError("no Robot target: set robot.targets (and robot.defaultTarget) or robot.integrationBranch in team.yaml, or pass --on <name|branch>");
  const { branch, requires } = target;
  if (v.suite && cfg.suites.length && !cfg.suites.some((s) => s.name === v.suite)) {
    throw new AihubError(`unknown suite '${v.suite}'; team.yaml suites: ${cfg.suites.map((s) => s.name).join(", ")}`);
  }
  const definitionId = await robotDefinitionId(client, pipeline);
  if (target.merge && !v["no-merge"]) {
    const feature = currentBranch(root);
    if (feature === branch) throw new AihubError(`you are on the integration branch '${branch}'; check out the feature branch or pass --no-merge`);
    ctx.out(formatIntegrate(feature, integrate(root, { feature, integration: branch, requires })));
  }
  const b = await queueRobot(client, { definitionId, branch, suite: v.suite as string | undefined, include: v.include as string | undefined });
  ctx.out(`queued ${pipeline} build ${b.id} on ${branch}${v.suite ? ` (suite ${v.suite})` : ""}${v.include ? ` (include ${v.include})` : ""}`);
  if (v["no-wait"]) return;
  const done = await followBuild(client, b.id, Number(ctx.env.AIHUB_POLL_MS ?? 15000));
  ctx.out(await summarize(client, done));
  if (done.result !== "succeeded") throw new AihubError(`Robot build ${b.id} ended as ${done.result ?? done.status}`);
}
