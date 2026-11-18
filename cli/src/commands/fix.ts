import { parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { fixKnown, fixRemember } from "../lib/knownFixes.js";

const USAGE = 'aihub fix known [--run <id|link> | --error "<text>"] [--json] | aihub fix remember --error "<error line>" --fix "<1-3 lines>"  (proposes a pull request; nothing is stored silently)';

/** aihub fix known|remember: the team's memory of errors it has fixed (known-fixes.md in the team pack). */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  const v = parse(rest, { run: { type: "string" }, error: { type: "string" }, fix: { type: "string" }, by: { type: "string" }, json: { type: "boolean" } }).values;
  if (sub === "known") return void ctx.out(await fixKnown(ctx, { run: v.run, error: v.error, json: v.json }));
  if (sub === "remember") return void ctx.out(await fixRemember(ctx, { error: v.error, fix: v.fix, who: v.by, json: v.json }));
  throw new AihubError(USAGE);
}
