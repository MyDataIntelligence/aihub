import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { parseFlags } from "../lib/cliargs.js";
import { addEvidence } from "../lib/evidence.js";

/** aihub evidence add --pr N --file img.png [--caption text] */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  const v = parseFlags(rest, { pr: { type: "string" }, file: { type: "string" }, caption: { type: "string" }, section: { type: "string" }, json: { type: "boolean" } });
  if (sub !== "add") throw new AihubError("usage: aihub evidence add --pr <n> --file <image> [--caption <text>]");
  if (!v.pr || !v.file) throw new AihubError("aihub evidence add needs --pr <n> and --file <image>");
  ctx.out(await addEvidence(ctx, { pr: v.pr as string, file: v.file as string, caption: v.caption as string | undefined, section: v.section as string | undefined, json: !!v.json }));
}
