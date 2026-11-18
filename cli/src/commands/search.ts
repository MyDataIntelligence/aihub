import type { Ctx } from "../lib/context.js";
import { devopsClient, flags, need } from "../lib/devops.js";
import { searchCode, searchItems, searchWiki } from "../lib/searchAdmin.js";

export const USAGE = "aihub search code|wiki|items --text <text> [--repo R|--all-repos] [--path p] [--branch b] [--type Bug,Task] [--state s] [--top n] [--json]";

/** Search code, wiki pages and work items with Azure DevOps search. */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  const s = need(sub, ["code", "wiki", "items"], USAGE);
  const v = flags(rest, { text: { type: "string" }, repo: { type: "string" }, "all-repos": { type: "boolean" }, path: { type: "string" }, branch: { type: "string" }, type: { type: "string" }, state: { type: "string" } });
  const { client } = devopsClient(ctx, v);
  if (s === "code") return searchCode(client, ctx, v);
  if (s === "wiki") return searchWiki(client, ctx, v);
  return searchItems(client, ctx, v);
}
