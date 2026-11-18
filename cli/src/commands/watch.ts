import { parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { ensureProtocol, listEvents } from "../lib/open.js";
import { parseDuration } from "../lib/pipeline.js";
import { MINE_ID, registerAtLogon, removeAtLogon, runDetachedMine, startMine } from "../lib/watchMine.js";
import { listWatches, runDetached, startWatch, stopWatches } from "../lib/watch.js";

/** aihub watch --run <id|link> | --robot <build> | --fabric-job <ws/item/job> [--notify]: follow one long run in the background; aihub watch --mine [--notify] [--interval 2m] [--at-logon] | --remove-at-logon | --pr N|--branch B [--until done|comment|vote] [--notify] [--client C] [--session S] | list | stop [--id X] */
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
    client: { type: "string" },
    session: { type: "string" },
    mine: { type: "boolean" },
    run: { type: "string" },
    robot: { type: "string" },
    "fabric-job": { type: "string" },
    limit: { type: "string" },
    since: { type: "string" },
    "include-existing": { type: "boolean" },
    "at-logon": { type: "boolean" },
    "remove-at-logon": { type: "boolean" },
    json: { type: "boolean" },
  }).values;
  if (sub === "events") {
    const limit = v.limit === undefined ? 20 : Number(v.limit);
    if (!Number.isInteger(limit) || limit <= 0) throw new AihubError("--limit must be a positive number");
    const sinceMs = v.since === undefined ? undefined : parseDuration(v.since, 0, { flag: "--since", unitRequired: true });
    const rows = listEvents(ctx.env, { limit, sinceMs, now: ctx.now?.() });
    if (v.json) return void ctx.out(JSON.stringify(rows));
    return void ctx.out(rows.length ? rows.map((r) => `${r.at.slice(0, 16).replace("T", " ")}  ${r.message}  (${r.id})`).join("\n") : "no watch events recorded");
  }
  if (sub === "list") return void ctx.out(listWatches(ctx, { json: v.json }));
  if (sub === "stop") return void ctx.out(stopWatches(ctx, { id: v.id, json: v.json }));
  if (sub === "_run") {
    if (!v.id) throw new AihubError("watch _run needs --id");
    if (v.id === MINE_ID) return runDetachedMine(ctx);
    return runDetached(ctx, v.id);
  }
  if (v["remove-at-logon"]) return void ctx.out(removeAtLogon());
  if (v.mine) {
    if (v.pr || v.branch) throw new AihubError("--mine watches everything that needs you; do not combine it with --pr or --branch");
    const out = startMine(ctx, { notify: v.notify, interval: v.interval, client: v.client, session: v.session, includeExisting: v["include-existing"], json: v.json }, undefined, undefined, () => ensureProtocol());
    ctx.out(out);
    if (v["at-logon"]) ctx.out(registerAtLogon(ctx, v.interval ?? "2m"));
    return;
  }
  if (v.run || v.robot || v["fabric-job"]) {
    ctx.out(startWatch(ctx, { run: v.run, robot: v.robot, fabricJob: v["fabric-job"], pr: v.pr, branch: v.branch, notify: v.notify, timeout: v.timeout, interval: v.interval, client: v.client, session: v.session, json: v.json }, undefined, undefined, () => ensureProtocol()));
    return;
  }
  if (sub) throw new AihubError("usage: aihub watch --mine [--notify] [--interval 2m] [--at-logon] | watch --remove-at-logon | aihub watch --pr <n>|--branch <b> [--until done|comment|vote] [--notify] [--client opencode|codex|claude|copilot] [--session <id>] [--timeout 2h] | watch list | watch stop [--id X] | watch events [--limit N] [--since 2h] [--json]");
  ctx.out(
    startWatch(
      ctx,
      { pr: v.pr, branch: v.branch, until: v.until, notify: v.notify, timeout: v.timeout, interval: v.interval, client: v.client, session: v.session, json: v.json },
      undefined,
      undefined,
      () => ensureProtocol(),
    ),
  );
}
