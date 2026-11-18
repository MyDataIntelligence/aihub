import { parseArgs } from "node:util";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { prChanges } from "../lib/prChanges.js";

function int(v: string | undefined, flag: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new AihubError(`${flag} must be a number`);
  return n;
}

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  let v;
  try {
    v = parseArgs({
      args: argv,
      options: {
        pr: { type: "string" },
        "since-iteration": { type: "string" },
        paths: { type: "string", multiple: true },
        page: { type: "string" },
        json: { type: "boolean" },
      },
    }).values;
  } catch (e) {
    throw new AihubError((e as Error).message);
  }
  ctx.out(
    await prChanges(ctx, {
      pr: v.pr,
      sinceIteration: int(v["since-iteration"], "--since-iteration"),
      paths: (v.paths ?? []).flatMap((p) => p.split(",")),
      page: int(v.page, "--page"),
      json: v.json,
    }),
  );
}
