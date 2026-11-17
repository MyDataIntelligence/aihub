import { parseArgs } from "node:util";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { runUpdate } from "../lib/update.js";
import { report } from "./skills.js";

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  let v: Record<string, string | boolean | undefined>;
  try {
    v = parseArgs({ args: argv, options: { check: { type: "boolean" }, after: { type: "string" } } }).values;
  } catch (e) {
    throw new AihubError((e as Error).message);
  }
  const r = runUpdate(ctx, { check: !!v.check, after: v.after as string | undefined });
  for (const l of r.lines) ctx.out(l);
  report(r.reports, ctx.out);
}