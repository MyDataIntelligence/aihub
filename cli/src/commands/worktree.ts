import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { list, parseFlags, posInt } from "../lib/cliargs.js";
import { createSet, listSets, removeSet } from "../lib/worktree.js";

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  const v = parseFlags(rest, {
    story: { type: "string" },
    repos: { type: "string" },
    root: { type: "string" },
    branch: { type: "string" },
    base: { type: "string" },
    json: { type: "boolean" },
  });
  const root = v.root as string | undefined;
  const json = !!v.json;
  if (sub === "create") {
    ctx.out(await createSet(ctx, { story: posInt(v.story, "--story"), repos: list(v.repos), root, branch: v.branch as string | undefined, base: v.base as string | undefined, json }));
  } else if (sub === "list") {
    ctx.out(listSets(ctx, { root, json }));
  } else if (sub === "remove") {
    ctx.out(removeSet(ctx, { story: posInt(v.story, "--story"), root, json }));
  } else throw new AihubError("usage: aihub worktree create|list|remove --story <id> [--repos a,b] [--root <folder>]");
}
