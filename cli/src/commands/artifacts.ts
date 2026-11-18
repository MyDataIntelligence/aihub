import type { Ctx } from "../lib/context.js";
import { devopsClient, flags, need, requireFlag } from "../lib/devops.js";
import { feeds, packages, versions } from "../lib/feeds.js";

export const USAGE = "aihub artifacts feeds [--org-feeds] | packages --feed F [--type npm|nuget|maven|pypi|upack] [--filter text] | versions --feed F --package name   (read only; builds publish packages, not the CLI)";

/** Azure Artifacts feeds, packages and versions (read only). */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  const s = need(sub, ["feeds", "packages", "versions"], USAGE);
  const v = flags(rest, { feed: { type: "string" }, package: { type: "string" }, type: { type: "string" }, "org-feeds": { type: "boolean" } });
  const { client } = devopsClient(ctx, v);
  if (s === "feeds") return feeds(client, ctx, v);
  const feed = requireFlag(v, "feed", "a feed name");
  if (s === "packages") return packages(client, ctx, v, feed);
  return versions(client, ctx, v, feed, requireFlag(v, "package", "a package name"));
}
