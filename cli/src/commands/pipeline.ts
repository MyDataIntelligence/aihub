import * as admin from "./pipeline-admin.js";
import { num, parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { repoRoot } from "../lib/git.js";
import { loadTeam } from "../lib/team.js";
import { parseRunRef, pipelineFailed, pipelineFollow, pipelineLogs, pipelineRerun, pipelineRetry, pipelineRun, pipelineRuns, pipelineStatus } from "../lib/pipeline.js";
import { ensureProtocol } from "../lib/open.js";
import { startWatch } from "../lib/watch.js";
import { pipelineList, pipelineLog, pipelinePoll, pipelineRunAgain, pipelineShow } from "../lib/pipelineView.js";

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
    mine: { type: "boolean" },
    today: { type: "boolean" },
    status: { type: "string" },
    "repo-dir": { type: "string", multiple: true },
    "rows-repo-dir": { type: "string" },
    project: { type: "string" },
    org: { type: "string" },
    "from-line": { type: "string" },
    plan: { type: "boolean" },
    commit: { type: "string" },
    "changes-file": { type: "string" },
  }).values;
  const sel = { pr: v.pr, branch: v.branch, run: v.run && !/^\d+$/.test(v.run) ? parseRunRef(v.run) : num(v.run, "--run"), definition: v.definition, top: num(v.top, "--top") };
  const repoDir = v["repo-dir"]?.[0];
  // --project (and --org): a run outside every repository of this PC
  const place = { repoDir, project: v.project, org: v.org };
  const needRun = () => {
    if (!sel.run) throw new AihubError(`aihub pipeline ${sub} needs --run <id> (see 'aihub pipeline list')`);
    return sel.run;
  };
  // the reads behind the bar: always JSON
  if (sub === "list") return void ctx.out(JSON.stringify(await pipelineList(ctx, { mine: v.mine, today: v.today, status: v.status, branch: v.branch, top: sel.top, repoDirs: v["repo-dir"], rowsRepoDir: v["rows-repo-dir"] })));
  if (sub === "show") return void ctx.out(JSON.stringify(await pipelineShow(ctx, { run: needRun(), ...place })));
  if (sub === "poll") return void ctx.out(JSON.stringify(await pipelinePoll(ctx, { run: needRun(), ...place })));
  if (sub === "log") return void ctx.out(JSON.stringify(await pipelineLog(ctx, { run: needRun(), step: v.step, tail: num(v.tail, "--tail"), fromLine: num(v["from-line"], "--from-line"), ...place })));
  if (sub === "run-again") return void ctx.out(JSON.stringify(await pipelineRunAgain(ctx, { run: needRun(), plan: v.plan, commit: v.commit, changesFile: v["changes-file"], ...place })));
  if (sub === "follow") return pipelineFollow(ctx, { ...sel, timeout: v.timeout });
  if (sub === "status") return void ctx.out(await pipelineStatus(ctx, { ...sel, json: v.json }));
  if (sub === "runs") return void ctx.out(await pipelineRuns(ctx, { ...sel, json: v.json }));
  if (sub === "logs" && v.failed) return void ctx.out(await pipelineFailed(ctx, { run: v.run, tail: num(v.tail, "--tail"), json: v.json }, loadTeam(repoRoot(ctx.cwd)).branches?.protected ?? []));
  if (sub === "logs") {
    if (!sel.run) throw new AihubError("aihub pipeline logs needs --run <id> (see 'aihub pipeline runs')");
    return void ctx.out(await pipelineLogs(ctx, { run: sel.run, step: v.step, search: v.search, tail: num(v.tail, "--tail"), json: v.json }));
  }
  if (sub === "run") return void ctx.out(await pipelineRun(ctx, { name: v.name, branch: v.branch, paramsFile: v["params-file"], json: v.json }));
  // after a pushed fix: the new run of the failed pipeline (started by the push, or queued now), followed in the background
  if (sub === "rerun") {
    const r = await pipelineRerun(ctx, { run: v.run });
    const watch = startWatch(ctx, { run: String(r.id), notify: true }, undefined, undefined, () => ensureProtocol());
    return void ctx.out(v.json ? JSON.stringify({ ...r, watch }) : `run ${r.id} of ${r.pipeline} on ${r.branch} ${r.queued ? "queued" : "started by the push"}; ${watch}`);
  }
  if (sub === "retry") {
    if (!sel.run) throw new AihubError("aihub pipeline retry needs --run <id> (see 'aihub pipeline runs')");
    return void ctx.out(await pipelineRetry(ctx, { run: sel.run, stage: v.stage, json: v.json, project: v.project, org: v.org }));
  }
  throw new AihubError("usage: aihub pipeline follow|status|runs|logs|run|rerun|retry|list|show|log|poll|run-again [flags]");
}
