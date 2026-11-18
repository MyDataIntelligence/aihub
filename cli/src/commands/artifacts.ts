import { AihubError } from "../lib/errors.js";
import type { Ctx } from "../lib/context.js";
import { devopsClient, flags } from "../lib/devops.js";
import { ARTIFACTS_USAGE, feeds, packages, versions } from "../lib/artifactsAdmin.js";

/** aihub artifacts feeds|packages|versions (read only) */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  const v = flags(rest, { feed: { type: "string" }, package: { type: "string" }, type: { type: "string" } });
  const { client } = devopsClient(ctx, v);
  if (sub === "feeds") return feeds(client, ctx, v);
  if (sub === "packages") return packages(client, ctx, v);
  if (sub === "versions") return versions(client, ctx, v);
  throw new AihubError(`usage: ${ARTIFACTS_USAGE}`);
}
