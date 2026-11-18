import { parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { format, probeApi, probeDevops, probeFabricCapacity, probeFabricEndpoint, type ProbeResult } from "../lib/probe.js";

export const PROBE_USAGE = `aihub probe fabric endpoint <path> [--workspace W]     GET one Fabric REST path, written without a leading slash: workspaces/{workspace}/notebooks ({workspace} = the id of --workspace)
aihub probe fabric capacity [--feature spark|notebooks|copyjob|mirroring|graphql|variablelibrary|pipelines|lakehouse|warehouse|eventstream|gitintegration] [--workspace W]
aihub probe devops feature <pipelines|builds|releases|environments|wiki|boards|testplans|policy|variablegroups|serviceconnections|identity>
aihub probe api --get <url>                            Fabric and Azure DevOps URLs with your sign-in (status and shape only); public docs hosts as text
    Every probe is read-only and prints YES, NO or UNKNOWN with the raw status. Add --json for data. It never shows item contents.`;

/** aihub probe fabric|devops|api ... */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [area, sub, ...rest] = argv;
  const v = parse(area === "api" ? argv.slice(1) : rest, { workspace: { type: "string" }, feature: { type: "string" }, get: { type: "string" }, json: { type: "boolean" } }, true);
  const pos = v.positionals;
  let r: ProbeResult;
  if (area === "fabric" && sub === "endpoint") r = await probeFabricEndpoint(ctx, pos[0] ?? "", { workspace: v.values.workspace });
  else if (area === "fabric" && sub === "capacity") r = await probeFabricCapacity(ctx, { feature: v.values.feature, workspace: v.values.workspace });
  else if (area === "devops" && sub === "feature") r = await probeDevops(ctx, pos[0] ?? "");
  else if (area === "api") {
    if (!v.values.get) throw new AihubError("usage: aihub probe api --get <url>");
    r = await probeApi(ctx, v.values.get);
  } else throw new AihubError(`usage:\n${PROBE_USAGE}`);
  ctx.out(v.values.json ? JSON.stringify(r) : format(r));
}
