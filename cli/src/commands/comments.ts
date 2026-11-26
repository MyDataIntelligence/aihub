import { parseArgs } from "node:util";
import { commentsGet, commentsReply } from "../lib/comments.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { commentsThreads } from "../lib/prThreads.js";

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  let v: Record<string, string | boolean | string[] | undefined>;
  try {
    v = parseArgs({
      args: rest,
      options: {
        pr: { type: "string", multiple: true },
        "include-resolved": { type: "boolean" },
        "replies-file": { type: "string" },
        reply: { type: "string", multiple: true },
        "return-threads": { type: "boolean" },
        json: { type: "boolean" },
      },
    }).values;
  } catch (e) {
    throw new AihubError((e as Error).message);
  }
  const prs = v.pr as string[] | undefined;
  if (sub === "get") {
    ctx.out(await commentsGet(ctx, { pr: prs?.[0], includeResolved: !!v["include-resolved"], json: !!v.json }));
    return;
  }
  if (sub === "reply") {
    ctx.out(await commentsReply(ctx, { pr: prs?.[0], repliesFile: v["replies-file"] as string | undefined, replies: v.reply as string[] | undefined, json: !!v.json, returnThreads: !!v["return-threads"] }));
    return;
  }
  // the editor's read: every thread of one or more pull requests, positions, outdated, suggestions (always JSON)
  if (sub === "threads") {
    ctx.out(await commentsThreads(ctx, { prs }));
    return;
  }
  throw new AihubError("usage: aihub comments get|reply|threads [flags]");
}
