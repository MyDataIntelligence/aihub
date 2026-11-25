import { parse } from "../lib/args.js";
import { branchUpdate } from "../lib/branch.js";
import { list } from "../lib/cliargs.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { branchSwitch, formatOpenSet, type OpenMode } from "../lib/repoSet.js";

export const USAGE = "usage: aihub branch update [--branch B] [--target T] [--rebase] | branch switch [--repo r[,s]] --branch X [--from T] [--mode worktree] [--json]";

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub === "switch") return switchBranch(rest, ctx);
  if (sub !== "update") throw new AihubError(USAGE);
  const v = parse(rest, { branch: { type: "string" }, target: { type: "string" }, rebase: { type: "boolean" }, json: { type: "boolean" } }).values;
  ctx.out(await branchUpdate(ctx, { branch: v.branch, target: v.target, rebase: v.rebase, json: v.json }));
}

/** One repository (of the set you are in) on another branch; the window stays. */
function switchBranch(argv: string[], ctx: Ctx): void {
  const v = parse(argv, { repo: { type: "string" }, repos: { type: "string" }, branch: { type: "string" }, from: { type: "string" }, base: { type: "string" }, mode: { type: "string" }, json: { type: "boolean" } }).values;
  if (v.mode !== undefined && v.mode !== "worktree" && v.mode !== "switch") throw new AihubError("--mode must be worktree or switch");
  const r = branchSwitch(ctx, { repos: [...list(v.repo), ...list(v.repos)], branch: v.branch ?? "", from: v.from ?? v.base, mode: v.mode as OpenMode | undefined });
  ctx.out(v.json ? JSON.stringify(r) : formatOpenSet(r));
  const bad = r.repos.filter((x) => !x.ok).length;
  if (bad && !v.json) throw new AihubError(`${bad} of ${r.repos.length} repositories were not switched`);
}
