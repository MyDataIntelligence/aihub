import { parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { standup } from "../lib/standup.js";

/** aihub standup [--since yesterday|today|<duration>] [--json]: 3-5 lines of what I did, read-only. */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const v = parse(argv, { since: { type: "string" }, json: { type: "boolean" } }).values;
  ctx.out(await standup(ctx, { since: v.since, json: v.json }));
}
