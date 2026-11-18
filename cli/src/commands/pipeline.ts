import * as admin from "./pipeline-admin.js";
import { num, parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { repoRoot } from "../lib/git.js";
import { loadTeam } from "../lib/team.js";
import { parseRunRef, pipelineFailed, pipelineFollow, pipelineLogs, pipelineRetry, pipelineRun, pipelineRuns, pipelineStatus } from "../lib/pipeline.js";

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  if (admin.PIPELINE_ADMIN_SUBS.includes(sub)) return admin.run(argv, ctx);
  const v = parse(rest, {
    pr: { type: "string" },
    branch: { type: "string" },
    run: { type: "string" },
    definition: { type: "string" },
    name: { type: "string" },
    top: { type: "string" },
    timeout: { type: "string" },
    step: { type: "string" },
    stage: { type: "string" },
    search: { type: "string" },
    tail: { type: "string" },
    "params-file": { type: "string" },
    failed: { type: "boolean" },
    json: { type: "boolean" },
  }).values;
  const sel = { pr: v.pr, branch: v.branch, run: v.run && !/^\d+$/.test(v.run) ? parseRunRef(v.run) : num(v.run, "--run"), definition: v.definition, top: num(v.top, "--top") };
  if (sub === "follow") return pipelineFollow(ctx, { ...sel, timeout: v.timeout });
  if (sub === "status") return void ctx.out(await pipelineStatus(ctx, { ...sel, json: v.json }));
  if (sub === "runs") return void ctx.out(await pipelineRuns(ctx, { ...sel, json: v.json }));
  if (sub === "logs" && v.failed) return void ctx.out(await pipelineFailed(ctx, { run: v.run, tail: num(v.tail, "--tail"), json: v.json }, loadTeam(repoRoot(ctx.cwd)).branches?.protected ?? []));
  if (sub === "logs") {
    if (!sel.run) throw new AihubError("aihub pipeline logs needs --run <id> (see 'aihub pipeline runs')");
    return void ctx.out(await pipelineLogs(ctx, { run: sel.run, step: v.step, search: v.search, tail: num(v.tail, "--tail"), json: v.json }));
  }
  if (sub === "run") return void ctx.out(await pipelineRun(ctx, { name: v.name, branch: v.branch, paramsFile: v["params-file"], json: v.json }));
  if (sub === "retry") {
    if (!sel.run) throw new AihubError("aihub pipeline retry needs --run <id> (see 'aihub pipeline runs')");
    return void ctx.out(await pipelineRetry(ctx, { run: sel.run, stage: v.stage, json: v.json }));
  }
  throw new AihubError("usage: aihub pipeline follow|status|runs|logs|run|retry [flags]");
}
