import { parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { acceptStep, formatResult, formatSteps, listSteps, resultJson, runPreflight, type PreflightDeps } from "../lib/preflight/run.js";

export const PREFLIGHT_USAGE =
  'aihub preflight [--plan | --apply [--yes] [--force]] [--step "<name>"] [--workspace W] [--no-fetch] [--dry-run] [--json]\n' +
  "    Runs the team's deploy-job steps on this PC from the pipeline YAML (team.yaml preflight); --plan adds steps that read the branch's feature workspace, --apply steps that write there.\n" +
  "aihub preflight steps [--job <path>] [--source <repo>] [--ref <branch>] [--no-fetch] [--json]\n" +
  '    Lists every step of the job with its kind and level; nothing runs. aihub preflight accept "<read step>" accepts new write calls.';

/** Test hook: the network and machine of a run (default: the real ones). */
export let preflightDeps: PreflightDeps = {};
export const setPreflightDeps = (d: PreflightDeps) => (preflightDeps = d);

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const sub = argv[0] && !argv[0].startsWith("-") ? argv[0] : undefined;
  if (sub === "help") return void ctx.out(PREFLIGHT_USAGE);
  if (sub === "steps") {
    const v = parse(argv.slice(1), { job: { type: "string" }, source: { type: "string" }, ref: { type: "string" }, "no-fetch": { type: "boolean" }, json: { type: "boolean" } }).values;
    const l = listSteps(ctx, { job: v.job, source: v.source, ref: v.ref, fetch: !v["no-fetch"] });
    return void ctx.out(v.json ? JSON.stringify(l) : formatSteps(l));
  }
  if (sub === "accept") {
    const p = parse(argv.slice(1), { "no-fetch": { type: "boolean" } }, true);
    const name = p.positionals.join(" ").trim();
    if (!name) throw new AihubError('usage: aihub preflight accept "<read step name>"');
    return void ctx.out(acceptStep(ctx, name, !p.values["no-fetch"]));
  }
  if (sub) throw new AihubError(`usage: ${PREFLIGHT_USAGE}`);
  const v = parse(argv, {
    plan: { type: "boolean" },
    apply: { type: "boolean" },
    yes: { type: "boolean" },
    force: { type: "boolean" },
    step: { type: "string" },
    workspace: { type: "string" },
    "no-fetch": { type: "boolean" },
    "dry-run": { type: "boolean" },
    json: { type: "boolean" },
  }).values;
  if (v.plan && v.apply) throw new AihubError("--plan and --apply: pick one (--apply includes the read steps of --plan)");
  if (v.yes && !v.apply) throw new AihubError("--yes only goes with --apply");
  const r = await runPreflight(
    ctx,
    { level: v.apply ? "apply" : v.plan ? "plan" : "local", step: v.step, workspace: v.workspace, fetch: !v["no-fetch"], dryRun: !!v["dry-run"], yes: !!v.yes, force: !!v.force },
    preflightDeps,
  );
  ctx.out(v.json ? JSON.stringify(resultJson(r)) : formatResult(r));
  if (!r.ok && !r.dryRun) throw new AihubError(r.verdict);
}
