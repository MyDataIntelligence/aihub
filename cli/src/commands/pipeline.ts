import { num, parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { pipelineFollow, pipelineLogs, pipelineRun, pipelineRuns, pipelineStatus } from "../lib/pipeline.js";

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  const v = parse(rest, {
    pr: { type: "string" },
    branch: { type: "string" },
    run: { type: "string" },
    definition: { type: "string" },
    name: { type: "string" },
    top: { type: "string" },
    timeout: { type: "string" },
    step: { type: "string" },
    search: { type: "string" },
    tail: { type: "string" },
    "params-file": { type: "string" },
    json: { type: "boolean" },
  }).values;
  const sel = { pr: v.pr, branch: v.branch, run: num(v.run, "--run"), definition: v.definition, top: num(v.top, "--top") };
  if (sub === "follow") return pipelineFollow(ctx, { ...sel, timeout: v.timeout });
  if (sub === "status") return void ctx.out(await pipelineStatus(ctx, { ...sel, json: v.json }));
  if (sub === "runs") return void ctx.out(await pipelineRuns(ctx, { ...sel, json: v.json }));
  if (sub === "logs") {
    if (!sel.run) throw new AihubError("aihub pipeline logs needs --run <id> (see 'aihub pipeline runs')");
    return void ctx.out(await pipelineLogs(ctx, { run: sel.run, step: v.step, search: v.search, tail: num(v.tail, "--tail"), json: v.json }));
  }
  if (sub === "run") return void ctx.out(await pipelineRun(ctx, { name: v.name, branch: v.branch, paramsFile: v["params-file"], json: v.json }));
  throw new AihubError("usage: aihub pipeline follow|status|runs|logs|run [flags]");
}
