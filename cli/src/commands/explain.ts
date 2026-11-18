import type { Ctx } from "../lib/context.js";
import { explain } from "../lib/explain.js";

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  for (const l of explain(argv[0])) ctx.out(l);
}