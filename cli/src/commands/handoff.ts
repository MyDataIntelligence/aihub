import { parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { handoff } from "../lib/standup.js";

/** aihub handoff [--to <name>] [--clipboard] [--wiki [--wiki-page <path>]] [--json]: my open work as a short markdown note (read-only unless --wiki). */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const v = parse(argv, { to: { type: "string" }, clipboard: { type: "boolean" }, wiki: { type: "boolean" }, "wiki-page": { type: "string" }, json: { type: "boolean" } }).values;
  ctx.out(await handoff(ctx, { to: v.to, clipboard: v.clipboard, wiki: v.wiki, wikiPage: v["wiki-page"], json: v.json }));
}
