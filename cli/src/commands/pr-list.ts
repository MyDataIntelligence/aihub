import { parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { prList, prShow } from "../lib/prList.js";

export const PR_LIST_SUBS = ["list", "show"];

export const PR_LIST_USAGE =
  "aihub pr list [--mine|--reviewer] [--branch <b>] [--status active|completed|abandoned|all] [--repo <r>] [--json]\n" +
  "aihub pr show --pr <n|url> [--json]\n" +
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
    json: { type: "boolean" },
  }).values;
  if (sub === "list") return void ctx.out(await prList(ctx, { mine: v.mine, reviewer: v.reviewer, branch: v.branch, status: v.status, repo: v.repo, json: v.json }));
  if (sub === "show") {
    if (!v.pr) throw new AihubError("aihub pr show needs --pr <number|url>");
    return void ctx.out(await prShow(ctx, { pr: v.pr, json: v.json }));
  }
  throw new AihubError(`usage: ${PR_LIST_USAGE}`);
}
