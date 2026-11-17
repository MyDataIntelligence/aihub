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
  waitForJob,
} from "../lib/fabric.js";
import { git, repoRoot } from "../lib/git.js";
import { loadTeam } from "../lib/team.js";

const USAGE = "usage: aihub fabric plan|run|status [flags]";

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  let v: Record<string, string | boolean | undefined>;
  try {
    v = parseArgs({
      args: rest,
      options: {
        branch: { type: "string" },
        target: { type: "string" },
        workspace: { type: "string" },
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
    ctx.out(formatPlan(buildPlan(c.files, list, { branch: c.branch, workspace: v.workspace as string | undefined }), c.branch, c.target));
    return;
  }

  const branch = given ?? git(root, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true }).trim();

  const ws = chooseWorkspace(list, { workspace: v.workspace as string | undefined, branch });
  if (!ws) {
    if (v.workspace) throw new AihubError(`workspace '${v.workspace}' is not in team.yaml fabric.workspaces; the CLI only runs workspaces the team listed`);
    throw new AihubError("no dev/feature workspace in team.yaml fabric.workspaces; pass --workspace <name|id>");
  }
  guardEnv(ws, v["allow-env"] as string | undefined);
  if (!v.item) throw new AihubError(`aihub fabric ${sub} needs --item <name|id>`);
  if (sub === "status" && !v.job) throw new AihubError("aihub fabric status needs --job <id> and --item <name|id>");

  const client = new FabricClient(makeFabricAuth({ env: ctx.env, exec: ctx.exec, cacheFile: ctx.tokenCache && `${ctx.tokenCache}.fabric` }), ctx.fetch);
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
