import { parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { work } from "../lib/work.js";

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const v = parse(argv, { json: { type: "boolean" } }).values;
  ctx.out(await work(ctx, { json: v.json }));
}
