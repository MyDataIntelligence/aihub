import { parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { fabricRunner, prDataDiff } from "../lib/dataDiff.js";
import { prList, prShow } from "../lib/prList.js";
import { run as fabricRun } from "./fabric.js";

export const PR_LIST_SUBS = ["list", "show", "data-diff"];

export const PR_LIST_USAGE =
  "aihub pr list [--mine|--reviewer] [--branch <b>] [--status active|completed|abandoned|all] [--repo <r>] [--json]\n" +
  "aihub pr show --pr <n|url> [--json]\n" +
  "aihub pr data-diff [--pr <n|url>] [--write] [--baseline <workspace>] [--feature <workspace>] [--json]\n" +
  "    list: pull requests of the team.yaml repositories (or --repo); show: title, description head, branches, reviewers with votes, policies, threads.";

/** aihub pr list | pr show */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  const v = parse(rest, {
    mine: { type: "boolean" },
    reviewer: { type: "boolean" },
    branch: { type: "string" },
    status: { type: "string" },
    repo: { type: "string" },
    pr: { type: "string" },
    write: { type: "boolean" },
    baseline: { type: "string" },
    feature: { type: "string" },
    json: { type: "boolean" },
  }).values;
  if (sub === "list") return void ctx.out(await prList(ctx, { mine: v.mine, reviewer: v.reviewer, branch: v.branch, status: v.status, repo: v.repo, json: v.json }));
  if (sub === "show") {
    if (!v.pr) throw new AihubError("aihub pr show needs --pr <number|url>");
    return void ctx.out(await prShow(ctx, { pr: v.pr, json: v.json }));
  }
  if (sub === "data-diff") return void ctx.out(await prDataDiff(ctx, { pr: v.pr, write: v.write, baseline: v.baseline, feature: v.feature, json: v.json }, fabricRunner(ctx, fabricRun)));
  throw new AihubError(`usage: ${PR_LIST_USAGE}`);
}
