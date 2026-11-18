import { parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { researchSave } from "../lib/research.js";

export const RESEARCH_USAGE = "aihub research save --file report.md [--wiki <page path>]   keep a feasibility report in .git/aihub/research (never committed); --wiki also publishes it, only after the user said yes";

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  const v = parse(rest, { file: { type: "string" }, wiki: { type: "string" }, json: { type: "boolean" } }).values;
  if (sub !== "save" || !v.file) throw new AihubError(`usage: ${RESEARCH_USAGE}`);
  ctx.out(await researchSave(ctx, { file: v.file, wiki: v.wiki, json: v.json }));
}
