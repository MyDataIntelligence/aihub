import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { confirmDelete, devopsClient, flags, need } from "../lib/devops.js";
import { posInt } from "../lib/cliargs.js";
import { policyCreate, policyDelete, policyList, policyShow, policyTypesCmd, policyUpdate } from "../lib/policyAdmin.js";

export const USAGE =
  "aihub policy types | list [--branch B] [--type T] [--all-repos] | show --id N | create --type <min-reviewers|build|work-item-linking|comment-resolution|required-reviewers|merge-strategy|status> (--branch B|--branch-prefix P|--default-branch) [flags] | update --id N [flags] | delete --id N --yes";

/** Branch policies: list, show, create, update, delete (types are looked up by name, never by id). */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  const s = need(sub, ["types", "list", "show", "create", "update", "delete"], USAGE);
  const v = flags(rest, {
    id: { type: "string" },
    type: { type: "string" },
    branch: { type: "string" },
    "branch-prefix": { type: "string" },
    "default-branch": { type: "boolean" },
    "all-repos": { type: "boolean" },
    path: { type: "string" },
    optional: { type: "boolean" },
    blocking: { type: "boolean" },
    disabled: { type: "boolean" },
    enable: { type: "boolean" },
    disable: { type: "boolean" },
    count: { type: "string" },
    "creator-vote-counts": { type: "string" },
    "allow-downvotes": { type: "string" },
    "reset-on-push": { type: "string" },
    "require-vote-on-last-iteration": { type: "string" },
    "block-last-pusher-vote": { type: "string" },
    definition: { type: "string" },
    pipeline: { type: "string" },
    name: { type: "string" },
    "queue-on-update-only": { type: "string" },
    manual: { type: "string" },
    "valid-minutes": { type: "string" },
    reviewers: { type: "string" },
    "added-files-only": { type: "string" },
    message: { type: "string" },
    "allow-squash": { type: "string" },
    "allow-merge": { type: "string" },
    "allow-rebase": { type: "string" },
    "allow-rebase-merge": { type: "string" },
    "status-name": { type: "string" },
    "status-genre": { type: "string" },
    "invalidate-on-update": { type: "string" },
  });
  const { client } = devopsClient(ctx, v);
  if (s === "types") return policyTypesCmd(client, ctx, v);
  if (s === "list") return policyList(client, ctx, v);
  if (s === "create") {
    if (!v.type) throw new AihubError("aihub policy create needs --type (see: aihub policy types)");
    return policyCreate(client, ctx, v);
  }
  const id = posInt(v.id, "--id");
  if (s === "show") return policyShow(client, ctx, v, id);
  if (s === "update") return policyUpdate(client, ctx, v, id);
  confirmDelete(v, `policy #${id}`);
  return policyDelete(client, ctx, v, id);
}
