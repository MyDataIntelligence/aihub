import { parseArgs } from "node:util";
import { refreshTokenNow } from "../lib/auth.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";

/** aihub token refresh --resource <r> --cache <file>: renews a cached az token (started detached by aihub itself). */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const v = parseArgs({ args: argv.slice(1), options: { resource: { type: "string" }, cache: { type: "string" } } }).values;
  if (argv[0] !== "refresh" || !v.resource || !v.cache) throw new AihubError("usage: aihub token refresh --resource <resource> --cache <file>");
  refreshTokenNow(ctx.env, v.resource, v.cache);
}
