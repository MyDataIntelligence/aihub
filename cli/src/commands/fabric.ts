import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { changedFiles } from "../lib/changes.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import {
  buildPlan,
  chooseWorkspace,
  executionDataFromParams,
  fabricWorkspaces,
  FabricClient,
  formatJob,
  formatPlan,
  guardEnv,
  makeFabricAuth,
  selectWorkspaces,
  workspaceGroups,
  type FabricWorkspace,
  type JobInstance,
  waitForJob,
} from "../lib/fabric.js";
import { git, repoRoot } from "../lib/git.js";
import { loadTeam } from "../lib/team.js";

const USAGE = "usage: aihub fabric plan|run|status [flags]";

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  let v: Record<string, string | boolean | string[] | undefined>;
  try {
    v = parseArgs({
      args: rest,
      options: {
        branch: { type: "string" },
        target: { type: "string" },
        workspace: { type: "string", multiple: true },
        workspaces: { type: "string" },
        item: { type: "string" },
        job: { type: "string" },
        "params-file": { type: "string" },
        "allow-env": { type: "string" },
        wait: { type: "boolean" },
      },
    }).values;
  } catch (e) {
    throw new AihubError((e as Error).message);
  }
  if (sub !== "plan" && sub !== "run" && sub !== "status") throw new AihubError(USAGE);

  const root = repoRoot(ctx.cwd);
  const team = loadTeam(root);
  const list = fabricWorkspaces(team);
  const given = v.branch as string | undefined;

  if (sub === "plan") {
    const c = changedFiles(root, team, { branch: given, target: v.target as string | undefined });
    ctx.out(formatPlan(buildPlan(c.files, list, { branch: c.branch, workspace: (v.workspace as string[] | undefined)?.[0] }), c.branch, c.target));
    return;
  }

  const branch = given ?? git(root, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true }).trim();

  const chosen = selectWorkspaces(list, workspaceGroups(team), { workspaces: v.workspace as string[] | undefined, group: v.workspaces as string | undefined, branch });
  if (!chosen.length) throw new AihubError("no dev/feature workspace in team.yaml fabric.workspaces; pass --workspace <name|id>");
  // refuse before any Fabric call when one of them is not allowed
  for (const w of chosen) guardEnv(w, v["allow-env"] as string | undefined);
  const ws = chosen[0];
  if (!v.item) throw new AihubError(`aihub fabric ${sub} needs --item <name|id>`);
  if (sub === "status" && !v.job) throw new AihubError("aihub fabric status needs --job <id> and --item <name|id>");

  const client = new FabricClient(makeFabricAuth({ env: ctx.env, exec: ctx.exec, cacheFile: ctx.tokenCache && `${ctx.tokenCache}.fabric` }), ctx.fetch);
  if (chosen.length > 1) {
    if (sub === "status") throw new AihubError("aihub fabric status takes one --workspace");
    await runMany(ctx, client, chosen, v);
    return;
  }
  const wsId = await client.workspaceId(ws);
  const item = await client.resolveItem(wsId, v.item as string);

  if (sub === "status") {
    ctx.out(formatJob(await client.jobStatus(wsId, item.id, v.job as string), item.displayName));
    return;
  }

  const exec = v["params-file"] ? executionDataFromParams(readFileSync(v["params-file"] as string, "utf8"), item) : undefined;
  const jobId = await client.startJob(wsId, item, exec);
  ctx.out(`started ${item.type} ${item.displayName} in ${ws.name} (${ws.environment}): job ${jobId}`);
  if (!v.wait) {
    ctx.out(`follow with: aihub fabric status --item ${item.displayName} --job ${jobId}`);
    return;
  }
  const j = await waitForJob(client, wsId, item.id, jobId, { pollMs: Number(ctx.env.AIHUB_POLL_MS ?? 5000) });
  ctx.out(formatJob(j, item.displayName));
  if (j.status !== "Completed") throw new AihubError(`${item.displayName} ended as ${j.status}`);
}

interface Row {
  ws: FabricWorkspace;
  jobId?: string;
  wsId?: string;
  itemId?: string;
  result?: JobInstance;
  error?: string;
}

/** Same item in several workspaces: start in each, wait for all, one table, keep going on errors. */
async function runMany(ctx: Ctx, client: FabricClient, chosen: FabricWorkspace[], v: Record<string, unknown>): Promise<void> {
  const rows: Row[] = chosen.map((ws) => ({ ws }));
  for (const r of rows) {
    try {
      r.wsId = await client.workspaceId(r.ws);
      const item = await client.resolveItem(r.wsId, v.item as string);
      r.itemId = item.id;
      const exec = v["params-file"] ? executionDataFromParams(readFileSync(v["params-file"] as string, "utf8"), item) : undefined;
      r.jobId = await client.startJob(r.wsId, item, exec);
      ctx.out(`started ${item.displayName} in ${r.ws.name} (${r.ws.environment}): job ${r.jobId}`);
    } catch (e) {
      r.error = (e as Error).message;
    }
  }
  if (v.wait) {
    const pollMs = Number(ctx.env.AIHUB_POLL_MS ?? 5000);
    for (const r of rows) {
      if (!r.jobId) continue;
      try {
        r.result = await waitForJob(client, r.wsId!, r.itemId!, r.jobId, { pollMs });
      } catch (e) {
        r.error = (e as Error).message;
      }
    }
  }
  const lines = ["workspace | environment | job | result"];
  for (const r of rows) {
    const res = r.error
      ? `error: ${r.error}`
      : r.result
        ? `${r.result.status}${r.result.status === "Failed" ? `: ${(r.result.failureReason?.message ?? "no details").replace(/\s+/g, " ").trim()}` : ""}`
        : "started";
    lines.push(`${r.ws.name} | ${r.ws.environment} | ${r.jobId ?? "-"} | ${res}`);
  }
  ctx.out(lines.join(String.fromCharCode(10)));
  const bad = rows.filter((r) => r.error || (v.wait && r.result?.status !== "Completed"));
  if (bad.length) throw new AihubError(`${bad.length} of ${rows.length} workspaces did not complete: ${bad.map((r) => r.ws.name).join(", ")}`);
}
