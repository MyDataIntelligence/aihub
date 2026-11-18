import { parseArgs } from "node:util";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { COMMON_FLAGS, devopsClient, type Flags } from "../lib/devops.js";
import { posInt } from "../lib/cliargs.js";
import { attach, attachments, commentAdd, commentsList, history, itemDelete, itemGet, itemRestore, itemUpdate, link, tags, types } from "../lib/workitemAdmin.js";

export const WORKITEM_ADMIN_SUBS = ["get", "update", "comment", "comments", "history", "link", "unlink", "tag", "untag", "attach", "attachments", "types", "delete", "restore"];

export const USAGE =
  "aihub workitem get --id N [--full] | update --id N --field name=value [--field ...] | comment --id N --text t|--text-file f | comments --id N | history --id N | link|unlink --id N --type parent|child|related|predecessor|successor|duplicate|tests|tested-by --to M | tag|untag --id N --tags a,b | attach --id N --file f | attachments --id N [--download name --out dir] | types | delete --id N --yes | restore --id N   (plus state and create)";

/** Work item administration beyond state and create. */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  let v: Flags;
  let fields: string[] = [];
  try {
    const p = parseArgs({
      args: rest,
      options: {
        ...COMMON_FLAGS,
        id: { type: "string" },
        field: { type: "string", multiple: true },
        text: { type: "string" },
        "text-file": { type: "string" },
        type: { type: "string" },
        to: { type: "string" },
        comment: { type: "string" },
        tags: { type: "string" },
        file: { type: "string" },
        name: { type: "string" },
        download: { type: "string" },
        out: { type: "string" },
        full: { type: "boolean" },
      },
      allowPositionals: false,
    });
    v = p.values as Flags;
    fields = (p.values.field as string[] | undefined) ?? [];
  } catch (e) {
    throw new AihubError((e as Error).message);
  }
  const { client } = devopsClient(ctx, v);
  if (sub === "types") return types(client, ctx, v);
  const id = posInt(v.id, "--id");
  switch (sub) {
    case "get":
      return itemGet(client, ctx, v, id);
    case "update":
      return itemUpdate(client, ctx, v, id, fields);
    case "comment":
      return commentAdd(client, ctx, v, id);
    case "comments":
      return commentsList(client, ctx, v, id);
    case "history":
      return history(client, ctx, v, id);
    case "link":
    case "unlink":
      return link(client, ctx, v, id, sub === "link");
    case "tag":
    case "untag":
      return tags(client, ctx, v, id, sub === "tag");
    case "attach":
      return attach(client, ctx, v, id);
    case "attachments":
      return attachments(client, ctx, v, id);
    case "delete":
      return itemDelete(client, ctx, v, id);
    case "restore":
      return itemRestore(client, ctx, v, id);
  }
  throw new AihubError(`usage: ${USAGE}`);
}
