import { parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { testChanged } from "../lib/testChanged.js";

export const TEST_USAGE =
  "aihub test changed [--base <branch>] [--run] [--json]\n" +
  "    Lists the tests that belong to the files this branch changed (vs the merge base with the target) and with --run runs only those.\n" +
  "    The team sets tests.command (for example \"pytest {tests}\") and optional tests.map in team.yaml; never run the whole suite locally, the pipeline does.";

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "help") return void ctx.out(TEST_USAGE);
  if (sub !== "changed") throw new AihubError(`usage: ${TEST_USAGE}`);
  const v = parse(rest, { base: { type: "string" }, run: { type: "boolean" }, json: { type: "boolean" } }).values;
  ctx.out(testChanged(ctx, { base: v.base, run: v.run, json: v.json }));
}
