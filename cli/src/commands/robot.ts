import { parseArgs } from "node:util";
import { changedFiles } from "../lib/changes.js";
import { repoClient, type Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { formatIntegrate, integrate } from "../lib/integrate.js";
import { currentBranch } from "../lib/git.js";
import { followBuild, formatNeeded, queueRobot, formatTargets, resolveTarget, robotConfig, robotDefinitionId, robotNeeded, summarize } from "../lib/robot.js";
import { loadTeam } from "../lib/team.js";

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
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
  if (sub !== "needed" && sub !== "run" && sub !== "targets") throw new AihubError("usage: aihub robot needed|run|targets [flags]");

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
