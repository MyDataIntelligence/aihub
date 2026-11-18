import { readFileSync } from "node:fs";
import { parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { teamLearn } from "../lib/teamLearn.js";

const USAGE = 'aihub team learn "<one sentence rule>" [--rule-file <file>] [--json]  (appends it to the team guidelines through a pull request)';

/** aihub team learn: a rule the team learned, proposed as a pull request. */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub !== "learn") throw new AihubError(USAGE);
  const p = parse(rest, { "rule-file": { type: "string" }, json: { type: "boolean" } }, true);
  const rule = p.values["rule-file"] ? readFileSync(p.values["rule-file"], "utf8") : p.positionals.join(" ");
  ctx.out(await teamLearn(ctx, { rule, json: p.values.json }));
}
