import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { devopsClient, flags, requireFlag } from "../lib/devops.js";
import { wikiAttach, wikiCreate, wikiCreateWiki, wikiDelete, wikiHistory, wikiList, wikiMove, wikiPages, wikiRead } from "../lib/wikiAdmin.js";
import { wikiUpdate } from "../lib/wiki.js";

export const USAGE =
  "aihub wiki list | pages [--path p] | read --page p | create --page p --body-file f | update --page p --body-file f [--publish] | move --page p --to q | delete --page p --yes | attach --file f [--name n] | history --page p | create-wiki --name n [--code --repo r --branch b --folder f]   (--wiki <name> picks the wiki) | browse <sub> (the wiki browser, always JSON: aihub wiki browse --help) | update <sub> (pages updated by an agent from source files, published only on apply: aihub wiki update --help)";

/** The project wiki: read, list, search (aihub search wiki), create, update, move, delete, attach, history. */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub === "browse") return (await import("./wiki-browse.js")).runWikiBrowse(rest, ctx);
  // `wiki update start|read|write|diff|apply|discard|list` is the agent flow; `wiki update --page` stays the one-page update
  if (sub === "update" && /^(start|read|write|diff|apply|discard|list)$/.test(rest[0] ?? "")) return (await import("./wiki-update.js")).runWikiUpdate(rest, ctx);
  const v = flags(rest, {
    page: { type: "string" },
    "body-file": { type: "string" },
    wiki: { type: "string" },
    publish: { type: "boolean" },
    path: { type: "string" },
    to: { type: "string" },
    order: { type: "string" },
    file: { type: "string" },
    name: { type: "string" },
    code: { type: "boolean" },
    repo: { type: "string" },
    branch: { type: "string" },
    folder: { type: "string" },
  });
  if (sub === "update") {
    if (!v.page || !v["body-file"]) throw new AihubError("aihub wiki update needs --page <path> and --body-file <file>");
    ctx.out(await wikiUpdate(ctx, { page: v.page as string, bodyFile: v["body-file"] as string, wiki: v.wiki as string | undefined, publish: !!v.publish, json: !!v.json }));
    return;
  }
  const { client } = devopsClient(ctx, v);
  switch (sub) {
    case "list":
      return wikiList(client, ctx, v);
    case "pages":
      return wikiPages(client, ctx, v);
    case "read":
      return wikiRead(client, ctx, v, requireFlag(v, "page", "the page path"));
    case "create":
      return wikiCreate(client, ctx, v, requireFlag(v, "page", "the page path"));
    case "move":
      return wikiMove(client, ctx, v, requireFlag(v, "page", "the page path"), requireFlag(v, "to", "the new path"));
    case "delete":
      return wikiDelete(client, ctx, v, requireFlag(v, "page", "the page path"));
    case "attach":
      return wikiAttach(client, ctx, v);
    case "history":
      return wikiHistory(client, ctx, v, requireFlag(v, "page", "the page path"));
    case "create-wiki":
      return wikiCreateWiki(client, ctx, v);
  }
  throw new AihubError(`usage: ${USAGE}`);
}
