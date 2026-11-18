import { parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { REPORT_TEMPLATE, researchSave } from "../lib/research.js";

export const RESEARCH_USAGE = [
  "aihub research template   print the report skeleton (the fixed headings, including Waar hoort het: Fabric, DevOps/CI-CD of beide?)",
  "aihub research save --file report.md [--wiki <page path>]   check the headings and keep the report in .git/aihub/research (never committed); --wiki also publishes it, only after the user said yes",
].join(String.fromCharCode(10));

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub === "template") return void ctx.out(REPORT_TEMPLATE.trimEnd());
  const v = parse(rest, { file: { type: "string" }, wiki: { type: "string" }, json: { type: "boolean" } }).values;
  if (sub !== "save" || !v.file) throw new AihubError(`usage:${String.fromCharCode(10)}${RESEARCH_USAGE}`);
  ctx.out(await researchSave(ctx, { file: v.file, wiki: v.wiki, json: v.json }));
}
