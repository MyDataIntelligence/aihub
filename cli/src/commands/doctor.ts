import { parseArgs } from "node:util";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { formatChecks, runChecks } from "../lib/doctor.js";

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  let json = false;
  try {
    json = !!parseArgs({ args: argv, options: { json: { type: "boolean" } } }).values.json;
  } catch (e) {
    throw new AihubError((e as Error).message);
  }
  const checks = runChecks(ctx);
  if (json) {
    ctx.out(JSON.stringify({ ok: checks.every((c) => c.status === "OK"), checks }));
    return;
  }
  for (const l of formatChecks(checks)) ctx.out(l);
  const bad = checks.filter((c) => c.status === "FIX").length;
  ctx.out(bad ? `${bad} check(s) need a fix` : "all checks passed");
}
