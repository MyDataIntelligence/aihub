import { parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { forgetUse, formatRecent, readRecentUse } from "../lib/recentUse.js";

const USAGE = "usage: aihub recent [--json] | recent forget <path>";

/** The sets and repositories you worked in last, newest first (the same list the VS Code buttons show). */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const { values: v, positionals } = parse(argv, { json: { type: "boolean" } }, true);
  const [sub, ...rest] = positionals;
  if (sub === "forget") {
    if (!rest[0]) throw new AihubError(USAGE);
    forgetUse(ctx.env, rest[0]);
    return void ctx.out(`forgotten: ${rest[0]}`);
  }
  if (sub) throw new AihubError(USAGE);
  const items = readRecentUse(ctx.env);
  ctx.out(v.json ? JSON.stringify({ recent: items }) : formatRecent(items, (ctx.now ?? Date.now)()));
}
