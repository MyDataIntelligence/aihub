import { parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { openEvent } from "../lib/open.js";

/** aihub open --event ID | --last | --url aihub://open?event=ID [--print]: back to the session a watch event belongs to. */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const v = parse(argv, { event: { type: "string" }, last: { type: "boolean" }, url: { type: "string" }, print: { type: "boolean" } }).values;
  ctx.out(openEvent(ctx, { event: v.event, last: v.last, url: v.url, print: v.print }));
}
