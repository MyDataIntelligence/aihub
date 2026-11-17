import { num, parse } from "../lib/args.js";
import { batch, type Runner } from "../lib/batch.js";
import type { Ctx } from "../lib/context.js";

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const v = parse(argv, {
    select: { type: "string" },
    run: { type: "string" },
    parallel: { type: "string" },
    "retry-failed": { type: "string" },
    json: { type: "boolean" },
  }).values;
  // In-process runner: every target runs one aihub command with its own captured output.
  const runner: Runner = async (args) => {
    const { main } = await import("../router.js");
    const lines: string[] = [];
    const code = await main(args, { ...ctx, out: (l) => lines.push(l), err: (l) => lines.push(l) });
    return { code, output: lines.join("\n") };
  };
  await batch(ctx, { select: v.select, run: v.run, parallel: num(v.parallel, "--parallel"), retryFailed: v["retry-failed"], json: v.json }, runner);
}
