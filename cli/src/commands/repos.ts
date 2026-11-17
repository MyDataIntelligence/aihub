import { parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { list } from "../lib/cliargs.js";
import { reposClone, reposList } from "../lib/projectRepos.js";

/** aihub repos list [--filter text] | repos clone --name a[,b] [--root dir] */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  const v = parse(rest, { filter: { type: "string" }, name: { type: "string" }, root: { type: "string" }, json: { type: "boolean" } }).values;
  if (sub === "list") return void ctx.out(await reposList(ctx, { filter: v.filter, root: v.root, json: v.json }));
  if (sub === "clone") return void ctx.out(await reposClone(ctx, { names: list(v.name), root: v.root, json: v.json }));
  throw new AihubError("usage: aihub repos list [--filter text] | repos clone --name <repository>[,<repository>] [--root <folder>]");
}
