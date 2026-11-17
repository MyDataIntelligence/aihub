import { parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { formatStatus, getStatus } from "../lib/status.js";

/** aihub status [--json]: where this branch stands and the next step. */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const v = parse(argv, { json: { type: "boolean" } }).values;
  const s = await getStatus(ctx);
  ctx.out(v.json ? JSON.stringify(s) : formatStatus(s));
}
