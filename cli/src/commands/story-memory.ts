import { parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { posInt } from "../lib/cliargs.js";
import { recallStory, searchStories } from "../lib/storyMemory.js";

export const STORY_MEMORY_SUBS = ["recall", "search"];

/** aihub story recall --id N [--json] | aihub story search "<words>" [--json]: what happened to a story, and finding one by words. */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  const p = parse(rest, { id: { type: "string" }, json: { type: "boolean" } }, true);
  if (sub === "recall") return void ctx.out(await recallStory(ctx, { id: posInt(p.values.id ?? p.positionals[0], "--id"), json: p.values.json }));
  if (sub === "search") return void ctx.out(await searchStories(ctx, { text: p.positionals.join(" "), json: p.values.json }));
  throw new AihubError('usage: aihub story recall --id <n> | aihub story search "<words>"');
}
