import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { confirmDelete, devopsClient, flags, need, requireFlag } from "../lib/devops.js";
import { libraryAuthorize, libraryCreate, libraryDelete, libraryDiff, libraryList, librarySet, libraryShow, libraryUnset, libraryUsage } from "../lib/library.js";

export const USAGE =
  "aihub library list [--filter text] | show --group <name|id> | create --group <name> [--vars-file f.json] [--description t] [--keyvault <connection>/<vault> --secrets a,b] | set --group G --name N (--value V | --secret --value-stdin) | unset --group G --name N | delete --group G --yes | usage --group G [--scan-yaml] | authorize --group G --pipeline P [--revoke] | diff --group A --with B";

/** The Library (variable groups). Secret values are never printed and only come in through stdin. */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  const s = need(sub, ["list", "show", "create", "set", "unset", "delete", "usage", "authorize", "diff"], USAGE);
  const v = flags(rest, {
    group: { type: "string" },
    name: { type: "string" },
    value: { type: "string" },
    "value-stdin": { type: "boolean" },
    secret: { type: "boolean" },
    plain: { type: "boolean" },
    "vars-file": { type: "string" },
    description: { type: "string" },
    keyvault: { type: "string" },
    secrets: { type: "string" },
    "scan-yaml": { type: "boolean" },
    pipeline: { type: "string" },
    revoke: { type: "boolean" },
    with: { type: "string" },
  });
  const { client } = devopsClient(ctx, v);
  if (s === "list") return libraryList(client, ctx, v);
  const group = requireFlag(v, "group", "a variable group name or id");
  if (s === "show") return libraryShow(client, ctx, v, group);
  if (s === "create") return libraryCreate(client, ctx, v, group);
  if (s === "usage") return libraryUsage(client, ctx, v, group);
  if (s === "diff") return libraryDiff(client, ctx, v, group, requireFlag(v, "with", "the second group"));
  if (s === "authorize") return libraryAuthorize(client, ctx, v, group, requireFlag(v, "pipeline", "a pipeline name"));
  if (s === "delete") {
    confirmDelete(v, `variable group '${group}'`);
    return libraryDelete(client, ctx, v, group);
  }
  const name = requireFlag(v, "name", "the variable name");
  if (s === "set") return librarySet(client, ctx, v, group, name);
  if (s === "unset") return libraryUnset(client, ctx, v, group, name);
  throw new AihubError(`usage: ${USAGE}`);
}
