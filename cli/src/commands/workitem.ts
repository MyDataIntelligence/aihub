import { repoClient, type Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { parseFlags, posInt } from "../lib/cliargs.js";
import { getWorkItem, setWorkItemState } from "../lib/workitems.js";

/** aihub workitem state --id N --to <state> */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  const v = parseFlags(rest, { id: { type: "string" }, to: { type: "string" }, json: { type: "boolean" } });
  if (sub !== "state") throw new AihubError("usage: aihub workitem state --id <n> --to <state>");
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
