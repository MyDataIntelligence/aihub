import { parseArgs } from "node:util";
import { changedFiles } from "../lib/changes.js";
import { repoClient, type Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { followBuild, formatNeeded, queueRobot, robotConfig, robotNeeded, summarize } from "../lib/robot.js";
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
      },
    }).values;
  } catch (e) {
    throw new AihubError((e as Error).message);
  }
  if (sub !== "needed" && sub !== "run") throw new AihubError("usage: aihub robot needed|run [flags]");

  const { root, client } = repoClient(ctx);
  const team = loadTeam(root);
  const cfg = robotConfig(team);

  if (sub === "needed") {
    const c = changedFiles(root, team, { branch: v.branch as string | undefined, target: v.target as string | undefined });
    ctx.out(formatNeeded(robotNeeded(c.files, cfg), cfg, c.branch));
    return;
  }

  const pipeline = (v.pipeline as string | undefined) ?? cfg.pipeline;
  if (!pipeline) throw new AihubError("no Robot pipeline: set robot.pipeline in team.yaml or pass --pipeline <name>");
  const branch = cfg.integrationBranch;
  if (!branch) throw new AihubError("robot.integrationBranch is not set in team.yaml; the Robot pipeline runs on that branch");
  if (v.suite && cfg.suites.length && !cfg.suites.some((s) => s.name === v.suite)) {
    throw new AihubError(`unknown suite '${v.suite}'; team.yaml suites: ${cfg.suites.map((s) => s.name).join(", ")}`);
  }
  const b = await queueRobot(client, { pipeline, branch, suite: v.suite as string | undefined, include: v.include as string | undefined });
  ctx.out(`queued ${pipeline} build ${b.id} on ${branch}${v.suite ? ` (suite ${v.suite})` : ""}${v.include ? ` (include ${v.include})` : ""}`);
  if (v["no-wait"]) return;
  const done = await followBuild(client, b.id, Number(ctx.env.AIHUB_POLL_MS ?? 15000));
  ctx.out(await summarize(client, done));
  if (done.result !== "succeeded") throw new AihubError(`Robot build ${b.id} ended as ${done.result ?? done.status}`);
}
