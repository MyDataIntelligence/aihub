import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { parseFlags } from "../lib/cliargs.js";
import { prChecks, prRequeue } from "../lib/policy.js";

export const PR_POLICY_SUBS = ["checks", "requeue"];

/** aihub pr checks --pr N | pr requeue --pr N [--policy build] */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  const v = parseFlags(rest, { pr: { type: "string" }, policy: { type: "string" }, json: { type: "boolean" } });
  if (typeof v.pr !== "string" || !v.pr) throw new AihubError(`aihub pr ${sub} needs --pr <number|url>`);
  if (sub === "checks") return void ctx.out(await prChecks(ctx, { pr: v.pr, json: !!v.json }));
  if (sub === "requeue") return void ctx.out(await prRequeue(ctx, { pr: v.pr, policy: v.policy as string | undefined, json: !!v.json }));
  throw new AihubError("usage: aihub pr checks|requeue --pr <n>");
}
