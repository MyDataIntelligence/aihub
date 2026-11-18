import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { devopsClient, flags } from "../lib/devops.js";
import { dashboards, permissions, pools, projects, subscriptions, teams } from "../lib/orgAdmin.js";

export const USAGE =
  "aihub devops projects [--filter t] | teams [--members <team>] | dashboards [--show name] | subscriptions [--all] | pools [--agents <pool>] | permissions namespaces | permissions actions --namespace N | permissions check --namespace N --token T --actions a,b   (read only)";

/** Organisation reads: projects, teams, dashboards, notification subscriptions, agent pools and permissions. Nothing here writes. */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...r1] = argv;
  const action = sub === "permissions" ? r1[0] : undefined;
  const rest = sub === "permissions" ? r1.slice(1) : r1;
  const v = flags(rest, { members: { type: "string" }, team: { type: "string" }, show: { type: "string" }, all: { type: "boolean" }, agents: { type: "string" }, namespace: { type: "string" }, token: { type: "string" }, actions: { type: "string" } });
  const { client } = devopsClient(ctx, v);
  switch (sub) {
    case "projects":
      return projects(client, ctx, v);
    case "teams":
      return teams(client, ctx, v);
    case "dashboards":
      return dashboards(client, ctx, v);
    case "subscriptions":
      return subscriptions(client, ctx, v);
    case "pools":
      return pools(client, ctx, v);
    case "permissions":
      if (action && ["namespaces", "actions", "check"].includes(action)) return permissions(client, ctx, v, action);
      break;
  }
  throw new AihubError(`usage: ${USAGE}`);
}
