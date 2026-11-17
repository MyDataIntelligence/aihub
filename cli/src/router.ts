import type { Ctx } from "./lib/context.js";
import { AihubError } from "./lib/errors.js";
import { cliVersion } from "./lib/pack.js";
import * as comments from "./commands/comments.js";
import * as doctor from "./commands/doctor.js";
import * as init from "./commands/init.js";
import * as pr from "./commands/pr.js";
import * as skills from "./commands/skills.js";
import * as fabric from "./commands/fabric.js";
import * as robot from "./commands/robot.js";
import * as cherryPick from "./commands/cherry-pick.js";
import * as branch from "./commands/branch.js";
import * as story from "./commands/story.js";
import * as pipeline from "./commands/pipeline.js";
import * as batch from "./commands/batch.js";
import * as work from "./commands/work.js";
import * as storyFlow from "./commands/story-flow.js";
import * as worktree from "./commands/worktree.js";
import * as review from "./commands/review.js";
import * as wiki from "./commands/wiki.js";
import * as release from "./commands/release.js";
import * as workitem from "./commands/workitem.js";
import * as evidence from "./commands/evidence.js";
import * as port from "./commands/port.js";
import * as crossrepo from "./commands/crossrepo.js";
import * as note from "./commands/note.js";
import * as status from "./commands/status.js";
import * as watch from "./commands/watch.js";

export type CommandFn = (argv: string[], ctx: Ctx) => Promise<void>;

/**
 * Command registry. To add a command: create src/commands/<name>.ts exporting
 * `run(argv, ctx)` and add one line here. Commands print through ctx.out and
 * throw AihubError for user-facing failures.
 */
export const commands: Record<string, CommandFn> = {
  pr: (argv, ctx) => (review.PR_EXTRA_SUBS.includes(argv[0]) ? review.runPrExtra(argv, ctx) : pr.run(argv, ctx)),
  comments: comments.run,
  init: init.run,
  skills: skills.run,
  doctor: doctor.run,
  fabric: fabric.run,
  robot: robot.run,
  "cherry-pick": cherryPick.run,
  branch: branch.run,
  pipeline: pipeline.run,
  batch: batch.run,
  work: work.run,
  story: (argv, ctx) => (storyFlow.STORY_FLOW_SUBS.includes(argv[0]) ? storyFlow.run(argv, ctx) : story.run(argv, ctx)),
  worktree: worktree.run,
  review: review.run,
  wiki: wiki.run,
  release: release.run,
  workitem: workitem.run,
  evidence: evidence.run,
  port: port.run,
  crossrepo: crossrepo.run,
  note: note.run,
  status: status.run,
  watch: watch.run,
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
