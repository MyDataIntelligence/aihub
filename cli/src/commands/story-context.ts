import { parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { list, posInt } from "../lib/cliargs.js";
import { storyContext } from "../lib/storyContext.js";

export const STORY_CONTEXT_SUBS = ["context"];

/** aihub story context --id N [--repos a,b] [--top 15] [--json] */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub !== "context") throw new AihubError("usage: aihub story context --id <n> [--repos a,b]");
  const p = parse(rest, { id: { type: "string" }, repos: { type: "string" }, top: { type: "string" }, json: { type: "boolean" } }, true);
  const id = posInt(p.values.id ?? p.positionals[0], "--id");
  ctx.out(await storyContext(ctx, { id, repos: list(p.values.repos), top: p.values.top ? posInt(p.values.top, "--top") : undefined, json: p.values.json }));
}
