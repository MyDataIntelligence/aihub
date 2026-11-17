import { parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { listWatches, runDetached, startWatch, stopWatches } from "../lib/watch.js";

/** aihub watch --pr N|--branch B [--until done|comment|vote] [--notify] | list | stop [--id X] */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const sub = argv[0] && !argv[0].startsWith("-") ? argv[0] : undefined;
  const v = parse(sub ? argv.slice(1) : argv, {
    pr: { type: "string" },
    branch: { type: "string" },
    until: { type: "string" },
    notify: { type: "boolean" },
    timeout: { type: "string" },
    interval: { type: "string" },
    id: { type: "string" },
    json: { type: "boolean" },
  }).values;
  if (sub === "list") return void ctx.out(listWatches(ctx, { json: v.json }));
  if (sub === "stop") return void ctx.out(stopWatches(ctx, { id: v.id, json: v.json }));
  if (sub === "_run") {
    if (!v.id) throw new AihubError("watch _run needs --id");
    return runDetached(ctx, v.id);
  }
  if (sub) throw new AihubError("usage: aihub watch --pr <n>|--branch <b> [--until done|comment|vote] [--notify] [--timeout 2h] | watch list | watch stop [--id X]");
  ctx.out(startWatch(ctx, { pr: v.pr, branch: v.branch, until: v.until, notify: v.notify, timeout: v.timeout, interval: v.interval, json: v.json }));
}
