import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { devopsClient, flags, need, requireFlag } from "../lib/devops.js";
import { backlog, boardShow, capacityShow, capacitySet, nodesCreate, nodesList, queryCreate, queryDelete, queryList, queryRun, queryShow, sprintItems, sprintList, tagList } from "../lib/boards.js";
import { WORKITEM_ADMIN_SUBS, run as workitem } from "./workitem-admin.js";

export const USAGE =
  "aihub boards query run [--wiql q|--query-file f|--saved name|--mine] | query list | query show --name n | query create --name n --wiql q | query delete --name n --yes | sprint list|items [--sprint s] | capacity show|set [--sprint s] [--member m --per-day h] | areas list|create --name n [--parent p] | iterations list|create --name n [--start d --finish d] | show [--board Stories] | backlog [--level Stories] | tags [--filter t]   (--team T picks the team; link|tag|attach|comment|get|update work as in: aihub workitem ...)";

/** Boards, queries, sprints, capacity, areas and iterations, backlogs. Item-level actions are `aihub workitem`. */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...r1] = argv;
  // the item-level actions also work under boards (boards link|tag|attach ...)
  if (sub && WORKITEM_ADMIN_SUBS.includes(sub)) return workitem(argv, ctx);
  const s = need(sub, ["query", "sprint", "capacity", "areas", "iterations", "show", "backlog", "tags"], USAGE);
  const grouped = ["query", "sprint", "capacity", "areas", "iterations"].includes(s);
  const action = grouped ? r1[0] : undefined;
  const rest = grouped ? r1.slice(1) : r1;
  const v = flags(rest, {
    team: { type: "string" },
    wiql: { type: "string" },
    "query-file": { type: "string" },
    saved: { type: "string" },
    mine: { type: "boolean" },
    name: { type: "string" },
    folder: { type: "string" },
    sprint: { type: "string" },
    member: { type: "string" },
    "per-day": { type: "string" },
    activity: { type: "string" },
    parent: { type: "string" },
    start: { type: "string" },
    finish: { type: "string" },
    board: { type: "string" },
    level: { type: "string" },
  });
  const { client } = devopsClient(ctx, v);
  switch (s) {
    case "query": {
      const a = need(action, ["run", "list", "show", "create", "delete"], USAGE);
      if (a === "run") return queryRun(client, ctx, v);
      if (a === "list") return queryList(client, ctx, v);
      if (a === "show") return queryShow(client, ctx, v, requireFlag(v, "name", "a saved query name, path or id"));
      if (a === "delete") return queryDelete(client, ctx, v, requireFlag(v, "name", "a saved query name, path or id"));
      return queryCreate(client, ctx, v);
    }
    case "sprint": {
      const a = need(action, ["list", "items"], USAGE);
      return a === "list" ? sprintList(client, ctx, v) : sprintItems(client, ctx, v);
    }
    case "capacity": {
      const a = need(action, ["show", "set"], USAGE);
      return a === "show" ? capacityShow(client, ctx, v) : capacitySet(client, ctx, v);
    }
    case "areas":
    case "iterations": {
      const a = need(action, ["list", "create"], USAGE);
      return a === "list" ? nodesList(client, ctx, v, s) : nodesCreate(client, ctx, v, s);
    }
    case "show":
      return boardShow(client, ctx, v);
    case "backlog":
      return backlog(client, ctx, v);
    case "tags":
      return tagList(client, ctx, v);
  }
  throw new AihubError(`usage: ${USAGE}`);
}
