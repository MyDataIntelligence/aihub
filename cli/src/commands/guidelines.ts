import { parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { guidelinesCheck, guidelinesShow } from "../lib/guidelines.js";

export const USAGE = "usage: aihub guidelines show --paths <file>[,<file>...] [--json] | guidelines check [--base <branch>] [--json]";

/** Exit code 1 after the findings were printed: the check found violations on the changed lines. */
class Violations extends AihubError {
  readonly exitCode = 1;
}

/**
 * aihub guidelines show: the rules for the files you are about to change (AGENTS.md nearest first, CLAUDE.md, copilot
 * instructions, .instructions.md with applyTo, team.yaml guidelines). aihub guidelines check: the changed files and lines of
 * the branch against its target, the team's linters on them, and the rules for those files; exit 1 on violations.
 */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  const p = parse(rest, { paths: { type: "string", multiple: true }, base: { type: "string" }, json: { type: "boolean" } }, true);
  if (sub === "show") {
    const paths = [...(p.values.paths ?? []), ...p.positionals].flatMap((s) => String(s).split(",")).map((s) => s.trim()).filter(Boolean);
    return void ctx.out(guidelinesShow(ctx, { paths, json: p.values.json }));
  }
  if (sub === "check") {
    const r = await guidelinesCheck(ctx, { base: p.values.base, json: p.values.json });
    ctx.out(r.text);
    if (r.code !== 0 && !p.values.json) throw new Violations("guideline violations on the changed lines: fix them, then run aihub guidelines check again");
    return;
  }
  throw new AihubError(USAGE);
}
