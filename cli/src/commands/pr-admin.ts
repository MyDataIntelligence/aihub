import { repoClient, type Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { flags } from "../lib/devops.js";
import { iterationsList, labelsChange, labelsList, prCancelAuto, prIdOf, prSetDraft, prSetStatus, prVote, reviewersAdd, reviewersList, reviewersRemove, statusesList, statusesPost, workitemsChange, workitemsList } from "../lib/prAdmin.js";

export const PR_ADMIN_SUBS = ["abandon", "reactivate", "publish", "draft", "reviewers", "vote", "labels", "status", "workitems", "iterations", "autocomplete"];

export const USAGE =
  "aihub pr abandon|reactivate|publish|draft [--pr N] | reviewers list|add|remove [--reviewers a,b] [--required] | vote --vote approve|approve-with-suggestions|wait|reject|reset | labels list|add|remove [--labels a,b] | status list|post [--state s --name n] | workitems list|add|remove [--work-item N] | iterations [--iteration n] | autocomplete --cancel   (--pr defaults to the active PR of the checked-out branch)";

/** Pull request administration: abandon, reactivate, draft state, reviewers, votes, labels, statuses, linked work items, iterations. */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...r1] = argv;
  const grouped = ["reviewers", "labels", "status", "workitems"].includes(sub);
  const action = grouped ? r1[0] : undefined;
  const rest = grouped ? r1.slice(1) : r1;
  if (grouped && !action) throw new AihubError(`usage: ${USAGE}`);
  const v = flags(rest, {
    pr: { type: "string" },
    reviewers: { type: "string" },
    required: { type: "boolean" },
    vote: { type: "string" },
    labels: { type: "string" },
    state: { type: "string" },
    name: { type: "string" },
    description: { type: "string" },
    genre: { type: "string" },
    url: { type: "string" },
    "work-item": { type: "string" },
    iteration: { type: "string" },
    cancel: { type: "boolean" },
  });
  const { client, root } = repoClient(ctx);
  const id = await prIdOf(client, root, v, sub === "reactivate" ? "abandoned" : "active");
  switch (sub) {
    case "abandon":
      return prSetStatus(client, ctx, v, id, "abandoned");
    case "reactivate":
      return prSetStatus(client, ctx, v, id, "active");
    case "publish":
      return prSetDraft(client, ctx, v, id, false);
    case "draft":
      return prSetDraft(client, ctx, v, id, true);
    case "vote":
      return prVote(client, ctx, v, id);
    case "iterations":
      return iterationsList(client, ctx, v, id);
    case "autocomplete":
      if (!v.cancel) throw new AihubError("aihub pr autocomplete only cancels: add --cancel (to set it use: aihub pr complete --auto)");
      return prCancelAuto(client, ctx, v, id);
    case "reviewers":
      if (action === "list") return reviewersList(client, ctx, v, id);
      if (action === "add") return reviewersAdd(client, ctx, v, id);
      if (action === "remove") return reviewersRemove(client, ctx, v, id);
      break;
    case "labels":
      if (action === "list") return labelsList(client, ctx, v, id);
      if (action === "add" || action === "remove") return labelsChange(client, ctx, v, id, action === "add");
      break;
    case "status":
      if (action === "list") return statusesList(client, ctx, v, id);
      if (action === "post") return statusesPost(client, ctx, v, id);
      break;
    case "workitems":
      if (action === "list") return workitemsList(client, ctx, v, id);
      if (action === "add" || action === "remove") return workitemsChange(client, ctx, v, id, action === "add");
      break;
  }
  throw new AihubError(`usage: ${USAGE}`);
}
