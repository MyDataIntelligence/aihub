import { parse } from "../lib/args.js";
import { branchUpdate } from "../lib/branch.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub !== "update") throw new AihubError("usage: aihub branch update [--branch B] [--target T] [--rebase]");
  const v = parse(rest, { branch: { type: "string" }, target: { type: "string" }, rebase: { type: "boolean" }, json: { type: "boolean" } }).values;
  ctx.out(await branchUpdate(ctx, { branch: v.branch, target: v.target, rebase: v.rebase, json: v.json }));
}
