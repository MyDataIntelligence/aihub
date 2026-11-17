import { parseArgs } from "node:util";
import { commentsGet, commentsReply } from "../lib/comments.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  let v: Record<string, string | boolean | undefined>;
  try {
    v = parseArgs({
      args: rest,
      options: {
        pr: { type: "string" },
        "include-resolved": { type: "boolean" },
        "replies-file": { type: "string" },
        json: { type: "boolean" },
      },
    }).values;
  } catch (e) {
    throw new AihubError((e as Error).message);
  }
  if (sub === "get") {
    ctx.out(await commentsGet(ctx, { pr: v.pr as string | undefined, includeResolved: !!v["include-resolved"], json: !!v.json }));
    return;
  }
  if (sub === "reply") {
    if (!v["replies-file"]) throw new AihubError("aihub comments reply needs --replies-file <file.yaml>");
    ctx.out(await commentsReply(ctx, { pr: v.pr as string | undefined, repliesFile: v["replies-file"] as string, json: !!v.json }));
    return;
  }
  throw new AihubError("usage: aihub comments get|reply [flags]");
}
