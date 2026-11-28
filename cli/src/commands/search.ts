import { num, parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { devopsClient, flags, need } from "../lib/devops.js";
import { AihubError } from "../lib/errors.js";
import { searchCode, searchItems, searchWiki } from "../lib/searchAdmin.js";

export const USAGE = `usage: aihub search code|wiki|items --text <text> [--repo R|--all-repos] [--path p] [--branch b] [--type Bug,Task] [--state s] [--top n] [--json]
       aihub search all <text> [--kinds repos,files,text,branches,workitems,prs,wiki,pipelines,logs] [--top 5] [--project P] [--org O] [--refresh] [--stream] [--json]
                       [--since 30d] [--failed] [--pipeline ID|name] [--branch B] [--max-logs 200]
         Search Everywhere: every kind at the same time in the projects you can read; a kind that fails says why, the others still come.
         logs only when asked (--kinds logs): step logs of finished runs of the last 30 days, failed first, at most 200, kept on disk.
         --stream prints each kind as one JSON line on stderr ({"part":{...}}) as soon as it is ready.`;

/** Search code, wiki pages and work items with Azure DevOps search; `all` searches every kind at once. */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub === "all") return all(rest, ctx);
  const s = need(sub, ["code", "wiki", "items", "all"], USAGE);
  const v = flags(rest, { text: { type: "string" }, repo: { type: "string" }, "all-repos": { type: "boolean" }, path: { type: "string" }, branch: { type: "string" }, type: { type: "string" }, state: { type: "string" } });
  const { client } = devopsClient(ctx, v);
  if (s === "code") return searchCode(client, ctx, v);
  if (s === "wiki") return searchWiki(client, ctx, v);
  return searchItems(client, ctx, v);
}

async function all(argv: string[], ctx: Ctx): Promise<void> {
  const { values: v, positionals } = parse(
    argv,
    { text: { type: "string" }, kinds: { type: "string" }, top: { type: "string" }, project: { type: "string" }, org: { type: "string" }, refresh: { type: "boolean" }, stream: { type: "boolean" }, json: { type: "boolean" }, since: { type: "string" }, failed: { type: "boolean" }, pipeline: { type: "string" }, branch: { type: "string" }, "max-logs": { type: "string" } },
    true,
  );
  const text = (v.text ?? positionals.join(" ")).trim();
  if (!text) throw new AihubError(USAGE);
  const { browseOf, errorJson } = await import("../lib/browse/core.js");
  const s = await import("../lib/searchAll.js");
  try {
    const b = browseOf(ctx, { org: v.org, refresh: !!v.refresh });
    const since = v.since ? /^(\d+)\s*d?$/i.exec(v.since.trim()) : null;
    if (v.since && !since) throw new AihubError("--since is a number of days, for example 30d");
    const logs = { sinceDays: since ? Number(since[1]) : undefined, failedOnly: !!v.failed, pipeline: v.pipeline, branch: v.branch, maxLogs: num(v["max-logs"], "--max-logs") };
    const r = await s.searchAll(b, { text, kinds: s.parseKinds(v.kinds), top: num(v.top, "--top"), project: v.project, logs, onPart: v.stream ? (p) => ctx.err(JSON.stringify({ part: p })) : undefined });
    ctx.out(v.json ? JSON.stringify(r) : s.searchAllText(r));
  } catch (e) {
    if (v.json) ctx.out(JSON.stringify(errorJson(e)));
    throw e instanceof AihubError ? e : new AihubError((e as Error).message);
  }
}
