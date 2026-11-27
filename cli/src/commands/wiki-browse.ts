import { num, parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { browseOf, BrowseError, errorJson } from "../lib/browse/core.js";
import { readText } from "../lib/browse/push.js";

export const WIKI_BROWSE_USAGE = `usage: aihub wiki browse <sub> [--org O] [--refresh]   (always JSON; a failure is {"error":{"kind","message"}} and exit 1)
  wikis                                                        every project wiki and code wiki you can read
  tree       --project P --wiki W [--path /Parent]             one level of the page tree, in the order of Azure DevOps
  page       --project P --wiki W --path /Page [--version SHA] markdown, ETag, last change, attachments (code wiki: the file for aihub browse push)
  templates                                                    the templates of a new page (empty, runbook, decision)
  publish    --project P --wiki W --path /Page --content-file F --etag E [--comment-file C] [--force]   project wiki: a new version (stale ETag: status conflict)
  create     --project P --wiki W [--parent /P] --name N [--template empty|runbook|decision] [--content-file F] [--comment-file C]
  move-plan  --project P --wiki W --path /Page --to /New/Path   what a move changes (pages, links), changes nothing
  move       --project P --wiki W --path /Page --to /New/Path [--no-links] [--order N] [--comment-file C]
  history    --project P --wiki W --path /Page [--top 50]      the versions of a page, newest first
  diff       --project P --wiki W --path /Page --to SHA [--from SHA]   the change between two versions (from: the version before)
  search     --text T [--project P] [--wiki W] [--top 50] [--skip 0]   Azure DevOps wiki search
  attachment --project P --wiki W --ref /.attachments/x.png [--page /Page]   download for a preview (a cached file)
  upload     --project P --wiki W --file F [--name N]          project wiki: add an attachment, answers the markdown`;

const SUBS = ["wikis", "tree", "page", "templates", "publish", "create", "move-plan", "move", "history", "diff", "search", "attachment", "upload"];

type V = Record<string, string | boolean | undefined>;

const need = (v: V, flag: string): string => {
  const x = v[flag];
  if (typeof x !== "string" || !x.trim()) throw new BrowseError("badInput", `aihub wiki browse needs --${flag} (aihub wiki browse --help)`);
  return x;
};
const str = (v: V, flag: string) => (typeof v[flag] === "string" ? (v[flag] as string) : undefined);
const file = (v: V, flag: string) => (str(v, flag) ? readText(str(v, flag)!) : undefined);

export async function runWikiBrowse(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  if (!sub || !SUBS.includes(sub)) throw new AihubError(WIKI_BROWSE_USAGE);
  const v = parse(rest, {
    org: { type: "string" },
    project: { type: "string" },
    wiki: { type: "string" },
    path: { type: "string" },
    parent: { type: "string" },
    name: { type: "string" },
    template: { type: "string" },
    version: { type: "string" },
    "content-file": { type: "string" },
    "comment-file": { type: "string" },
    etag: { type: "string" },
    force: { type: "boolean" },
    to: { type: "string" },
    from: { type: "string" },
    "no-links": { type: "boolean" },
    order: { type: "string" },
    top: { type: "string" },
    skip: { type: "string" },
    text: { type: "string" },
    ref: { type: "string" },
    page: { type: "string" },
    file: { type: "string" },
    refresh: { type: "boolean" },
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
  if (sub === "templates") return { templates: (await import("../lib/wiki/templates.js")).WIKI_TEMPLATES };
  const b = browseOf(ctx, { org: str(v, "org"), refresh: !!v.refresh });
  const at = () => ({ project: need(v, "project"), wiki: need(v, "wiki") });
  switch (sub) {
    case "wikis":
      return (await import("../lib/wiki/core.js")).wikiList(b);
    case "tree":
      return (await import("../lib/wiki/read.js")).wikiTree(b, { ...at(), path: str(v, "path") });
    case "page":
      return (await import("../lib/wiki/read.js")).wikiPage(b, { ...at(), path: need(v, "path"), version: str(v, "version") });
    case "history":
      return (await import("../lib/wiki/read.js")).wikiHistory(b, { ...at(), path: need(v, "path"), top: num(str(v, "top"), "--top") });
    case "diff":
      return (await import("../lib/wiki/read.js")).wikiRevisionDiff(b, { ...at(), path: need(v, "path"), to: need(v, "to"), from: str(v, "from") });
    case "attachment":
      return (await import("../lib/wiki/read.js")).wikiAttachment(b, { ...at(), ref: need(v, "ref"), pagePath: str(v, "page") });
    case "search":
      return (await import("../lib/wiki/search.js")).wikiSearch(b, { text: need(v, "text"), project: str(v, "project"), wiki: str(v, "wiki"), top: num(str(v, "top"), "--top"), skip: str(v, "skip") === "0" ? 0 : num(str(v, "skip"), "--skip") });
    case "publish":
      return (await import("../lib/wiki/write.js")).wikiPublish(b, { ...at(), path: need(v, "path"), content: readText(need(v, "content-file")), etag: str(v, "etag"), comment: file(v, "comment-file"), force: !!v.force });
    case "create":
      return (await import("../lib/wiki/write.js")).wikiCreate(b, { ...at(), parent: str(v, "parent"), name: need(v, "name"), template: str(v, "template"), content: file(v, "content-file"), comment: file(v, "comment-file") });
    case "move-plan":
      return (await import("../lib/wiki/write.js")).wikiMovePlan(b, { ...at(), path: need(v, "path"), to: need(v, "to") });
    case "move":
      return (await import("../lib/wiki/write.js")).wikiMove(b, { ...at(), path: need(v, "path"), to: need(v, "to"), updateLinks: !v["no-links"], order: str(v, "order") === "0" ? 0 : num(str(v, "order"), "--order"), comment: file(v, "comment-file") });
    case "upload":
      return (await import("../lib/wiki/write.js")).wikiUpload(b, { ...at(), file: need(v, "file"), name: str(v, "name") });
  }
  throw new AihubError(WIKI_BROWSE_USAGE);
}
