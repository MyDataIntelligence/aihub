import { parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { fabricRunner, prDataDiff } from "../lib/dataDiff.js";
import { prComment, prTestsAdd } from "../lib/prGold.js";
import { prList, prShow } from "../lib/prList.js";
import { run as fabricRun } from "./fabric.js";

export const PR_LIST_SUBS = ["list", "show", "data-diff", "comment", "tests"];

export const PR_LIST_USAGE =
  "aihub pr list [--mine|--reviewer] [--branch <b>] [--status active|completed|abandoned|all] [--repo <r>] [--json]\n" +
  "aihub pr show --pr <n|url> [--json]\n" +
  "aihub pr comment [--pr <n|url>] --title \"<what>\" (--text <markdown>|--body-file f) [--closed] [--link-section <section>] [--json]\n" +
  "aihub pr tests add [--pr <n|url>] --from-run <build> | --from-robot <build> | --from-fabric-job <ws>/<item>/<job> [--name <n>] [--json]\n" +
  "aihub pr data-diff [--pr <n|url>] [--write] [--baseline <workspace>] [--feature <workspace>] [--json]\n" +
  "    list: pull requests of the team.yaml repositories (or --repo); show: title, description head, branches, reviewers with votes, policies, threads; comment: a detail comment (closed thread) linked from a section; tests add: an honest row from a real run in the test table.";

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
    title: { type: "string" },
    text: { type: "string" },
    "body-file": { type: "string" },
    closed: { type: "boolean" },
    "link-section": { type: "string" },
    "from-run": { type: "string" },
    "from-robot": { type: "string" },
    "from-fabric-job": { type: "string" },
    name: { type: "string" },
    json: { type: "boolean" },
  }, true).values;
  if (sub === "list") return void ctx.out(await prList(ctx, { mine: v.mine, reviewer: v.reviewer, branch: v.branch, status: v.status, repo: v.repo, json: v.json }));
  if (sub === "show") {
    if (!v.pr) throw new AihubError("aihub pr show needs --pr <number|url>");
    return void ctx.out(await prShow(ctx, { pr: v.pr, json: v.json }));
  }
  if (sub === "comment") return void ctx.out(await prComment(ctx, { pr: v.pr, title: v.title, text: v.text, bodyFile: v["body-file"], closed: v.closed, linkSection: v["link-section"], json: v.json }));
  if (sub === "tests") {
    if (rest[0] !== "add") throw new AihubError("usage: aihub pr tests add [--pr N] --from-run <build> | --from-robot <build> | --from-fabric-job <workspace>/<item>/<job> [--name <name>]");
    return void ctx.out(await prTestsAdd(ctx, { pr: v.pr, fromRun: v["from-run"], fromRobot: v["from-robot"], fromFabricJob: v["from-fabric-job"], name: v.name, json: v.json }));
  }
  if (sub === "data-diff") return void ctx.out(await prDataDiff(ctx, { pr: v.pr, write: v.write, baseline: v.baseline, feature: v.feature, json: v.json }, fabricRunner(ctx, fabricRun)));
  throw new AihubError(`usage: ${PR_LIST_USAGE}`);
}
