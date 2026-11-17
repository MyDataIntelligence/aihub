import type { Ctx } from "./lib/context.js";
import { AihubError } from "./lib/errors.js";
import { cliVersion } from "./lib/pack.js";
import * as comments from "./commands/comments.js";
import * as doctor from "./commands/doctor.js";
import * as init from "./commands/init.js";
import * as pr from "./commands/pr.js";
import * as skills from "./commands/skills.js";

export type CommandFn = (argv: string[], ctx: Ctx) => Promise<void>;

/**
 * Command registry. To add a command: create src/commands/<name>.ts exporting
 * `run(argv, ctx)` and add one line here. Commands print through ctx.out and
 * throw AihubError for user-facing failures.
 */
export const commands: Record<string, CommandFn> = {
  pr: pr.run,
  comments: comments.run,
  init: init.run,
  skills: skills.run,
  doctor: doctor.run,
};

export const VERSION = cliVersion();

/** Returns the process exit code. */
export async function main(argv: string[], ctx: Ctx, registry: Record<string, CommandFn> = commands): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "--help" || name === "-h" || name === "help") {
    ctx.out(`aihub ${VERSION}: Azure DevOps team workflows in one call. Commands: ${Object.keys(registry).join(", ")}.`);
    return 0;
  }
  if (name === "--version" || name === "-v") {
    ctx.out(VERSION);
    return 0;
  }
  const fn = registry[name];
  if (!fn) {
    ctx.err(`aihub: unknown command '${name}'. Commands: ${Object.keys(registry).join(", ")}.`);
    return 2;
  }
  try {
    await fn(rest, ctx);
    return 0;
  } catch (e) {
    if (e instanceof AihubError) ctx.err(`aihub: ${e.message}`);
    else ctx.err(`aihub: unexpected error: ${(e as Error).message}`);
    return 1;
  }
}
