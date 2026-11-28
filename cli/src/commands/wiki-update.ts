import { readFileSync } from "node:fs";
import { parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { browseOf, BrowseError, errorJson } from "../lib/browse/core.js";
import { readText } from "../lib/browse/push.js";

export const WIKI_UPDATE_USAGE = `usage: aihub wiki update <sub> [--org O]   (always JSON; a failure is {"error":{"kind","message"}} and exit 1)
  start   --project P --wiki W [--path /Page]... [--sources-file F] [--prompt-file F]   a workspace with the pages and TASK.md for the agent
  read    --id ID --path /Page                 fetch another page of the wiki into ./pages
  write   --id ID --path /Page --content-file F   set a page's proposal (agents without file tools)
  diff    --id ID                              the proposal per page (modified or new), with problems
  apply   --id ID [--path /Page]... [--comment-file C]   publish (If-Match on the ETag each page was read at; a conflict is never overwritten)
  discard --id ID [--path /Page]               undo one page's proposal, or the whole update
  list                                         the wiki updates on this PC
Sources file: JSON [{"project","repo","path"?,"ref"?,"local"?}] (local: a clone on this PC, read only).`;

const SUBS = ["start", "read", "write", "diff", "apply", "discard", "list"];
type V = Record<string, string | boolean | string[] | undefined>;

const need = (v: V, flag: string): string => {
  const x = v[flag];
  if (typeof x !== "string" || !x.trim()) throw new BrowseError("badInput", `aihub wiki update needs --${flag} (aihub wiki update --help)`);
  return x;
};
const str = (v: V, flag: string) => (typeof v[flag] === "string" ? (v[flag] as string) : undefined);
const many = (v: V, flag: string) => (Array.isArray(v[flag]) ? (v[flag] as string[]) : typeof v[flag] === "string" ? [v[flag] as string] : []);

export async function runWikiUpdate(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  if (!sub || !SUBS.includes(sub)) throw new AihubError(WIKI_UPDATE_USAGE);
  const v = parse(rest, {
    org: { type: "string" },
    project: { type: "string" },
    wiki: { type: "string" },
    id: { type: "string" },
    path: { type: "string", multiple: true },
    "sources-file": { type: "string" },
    "prompt-file": { type: "string" },
    "content-file": { type: "string" },
    "comment-file": { type: "string" },
    json: { type: "boolean" },
  }).values as V;
  try {
    ctx.out(JSON.stringify(await answer(sub, v, ctx)));
  } catch (e) {
    ctx.out(JSON.stringify(errorJson(e)));
    throw e instanceof AihubError ? e : new AihubError((e as Error).message);
  }
}

async function answer(sub: string, v: V, ctx: Ctx): Promise<unknown> {
  const u = await import("../lib/wiki/update.js");
  if (sub === "list") return u.updateList(ctx.env);
  if (sub === "diff") {
    const { contents: _c, ...d } = u.updateDiff(ctx.env, need(v, "id"));
    return d;
  }
  if (sub === "discard") return u.updateDiscard(ctx.env, need(v, "id"), many(v, "path")[0]);
  const id = sub === "start" ? undefined : need(v, "id");
  const org = str(v, "org") ?? (id ? u.readUpdate(ctx.env, id).meta.org : undefined);
  const b = browseOf(ctx, { org });
  switch (sub) {
    case "start": {
      let sources: unknown;
      const sf = str(v, "sources-file");
      if (sf) {
        try {
          sources = JSON.parse(readFileSync(sf, "utf8").replace(/^﻿/, ""));
        } catch (e) {
          throw new BrowseError("badInput", `the sources file is not JSON: ${(e as Error).message}`);
        }
      }
      const pf = str(v, "prompt-file");
      return u.updateStart(b, { project: need(v, "project"), wiki: need(v, "wiki"), pages: many(v, "path"), sources: u.parseSources(sources), prompt: pf ? readText(pf) : undefined });
    }
    case "read":
      return u.updateRead(b, id!, need({ path: many(v, "path")[0] }, "path"));
    case "write":
      return u.updateWrite(ctx.env, id!, need({ path: many(v, "path")[0] }, "path"), readText(need(v, "content-file")));
    case "apply": {
      const cf = str(v, "comment-file");
      return u.updateApply(b, id!, { paths: many(v, "path"), comment: cf ? readText(cf) : undefined });
    }
  }
  throw new AihubError(WIKI_UPDATE_USAGE);
}
