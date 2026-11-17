import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { parseFlags } from "../lib/cliargs.js";
import { wikiUpdate } from "../lib/wiki.js";

/** aihub wiki update --page path --body-file F [--publish] */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  const v = parseFlags(rest, {
    page: { type: "string" },
    "body-file": { type: "string" },
    wiki: { type: "string" },
    publish: { type: "boolean" },
    json: { type: "boolean" },
  });
  if (sub !== "update") throw new AihubError("usage: aihub wiki update --page <path> --body-file <file> [--publish]");
  if (!v.page || !v["body-file"]) throw new AihubError("aihub wiki update needs --page <path> and --body-file <file>");
  ctx.out(await wikiUpdate(ctx, { page: v.page as string, bodyFile: v["body-file"] as string, wiki: v.wiki as string | undefined, publish: !!v.publish, json: !!v.json }));
}
