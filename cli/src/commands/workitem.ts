import { repoClient, type Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { optInt, parseFlags, posInt } from "../lib/cliargs.js";
import { getWorkItem, setWorkItemState } from "../lib/workitems.js";
import { createWorkItem } from "../lib/workitemCreate.js";
import { WORKITEM_ADMIN_SUBS, run as admin } from "./workitem-admin.js";

/** aihub workitem state --id N --to <state> | create --type Bug|Task --title T --body-file F [--parent N] */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub && WORKITEM_ADMIN_SUBS.includes(sub)) return admin(argv, ctx);
  const v = parseFlags(rest, {
    id: { type: "string" },
    to: { type: "string" },
    type: { type: "string" },
    title: { type: "string" },
    "body-file": { type: "string" },
    parent: { type: "string" },
    json: { type: "boolean" },
  });
  if (sub === "create") {
    ctx.out(
      await createWorkItem(ctx, {
        type: v.type as string | undefined,
        title: v.title as string | undefined,
        bodyFile: v["body-file"] as string | undefined,
        parent: optInt(v.parent, "--parent"),
        json: !!v.json,
      }),
    );
    return;
  }
  if (sub !== "state") throw new AihubError("usage: aihub workitem state --id <n> --to <state> | workitem create --type Bug|Task --title <t> --body-file <f> [--parent <n>]");
  const id = posInt(v.id, "--id");
  const to = String(v.to ?? "").trim();
  if (!to) throw new AihubError("--to <state> is required (for example Active, Resolved, Done)");
  const { client } = repoClient(ctx);
  const wi = await getWorkItem(client, id);
  if (wi.state.toLowerCase() === to.toLowerCase()) {
    ctx.out(v.json ? JSON.stringify({ id, from: wi.state, to: wi.state, changed: false }) : `work item ${id} is already ${wi.state}`);
    return;
  }
  await setWorkItemState(client, id, to);
  ctx.out(v.json ? JSON.stringify({ id, from: wi.state, to, changed: true }) : `work item ${id}: ${wi.state} -> ${to}`);
}
