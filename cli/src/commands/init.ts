import { parseArgs } from "node:util";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { reportInit, runInit } from "../lib/init.js";

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  let v: Record<string, string | boolean | undefined>;
  try {
    v = parseArgs({
      args: argv,
      options: { repo: { type: "string" }, "no-pr": { type: "boolean" }, language: { type: "string" }, "into-repo": { type: "boolean" }, "no-instructions": { type: "boolean" }, "no-agents-md": { type: "boolean" } },
    }).values;
  } catch (e) {
    throw new AihubError((e as Error).message);
  }
  const r = await runInit(ctx, { repo: v.repo as string | undefined, noPr: !!v["no-pr"], language: v.language as string | undefined, intoRepo: !!v["into-repo"], noInstructions: !!v["no-instructions"], noAgentsMd: !!v["no-agents-md"] });
  for (const l of reportInit(r)) ctx.out(l);
}
