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
import * as update from "./commands/update.js";
import * as explain from "./commands/explain.js";
import { setTrace } from "./lib/trace.js";
import * as prPolicy from "./commands/pr-policy.js";
import * as storyContext from "./commands/story-context.js";
import * as repos from "./commands/repos.js";
import * as open from "./commands/open.js";
import * as commit from "./commands/commit.js";
import * as search from "./commands/search.js";
import * as repo from "./commands/repo.js";
import * as policy from "./commands/policy.js";
import * as library from "./commands/library.js";
import * as testCmd from "./commands/test.js";
import * as legacy from "./commands/legacy.js";
import * as prList from "./commands/pr-list.js";
import * as prAdmin from "./commands/pr-admin.js";

export type CommandFn = (argv: string[], ctx: Ctx) => Promise<void>;

/**
 * Command registry. To add a command: create src/commands/<name>.ts exporting
 * `run(argv, ctx)` and add one line here. Commands print through ctx.out and
 * throw AihubError for user-facing failures.
 */
export const commands: Record<string, CommandFn> = {
  pr: (argv, ctx) =>
    prAdmin.PR_ADMIN_SUBS.includes(argv[0]) ? prAdmin.run(argv, ctx) : prList.PR_LIST_SUBS.includes(argv[0]) ? prList.run(argv, ctx) : prPolicy.PR_POLICY_SUBS.includes(argv[0]) ? prPolicy.run(argv, ctx) : review.PR_EXTRA_SUBS.includes(argv[0]) ? review.runPrExtra(argv, ctx) : pr.run(argv, ctx),
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
  story: (argv, ctx) =>
    storyContext.STORY_CONTEXT_SUBS.includes(argv[0])
      ? storyContext.run(argv, ctx)
      : storyFlow.STORY_FLOW_SUBS.includes(argv[0])
        ? storyFlow.run(argv, ctx)
        : story.run(argv, ctx),
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
  update: update.run,
  explain: explain.run,
  repos: repos.run,
  open: open.run,
  commit: commit.run,
  search: search.run,
  repo: repo.run,
  policy: policy.run,
  library: library.run,
  test: testCmd.run,
  legacy: legacy.run,
};

export const VERSION = cliVersion();

/** One-line usage per command, printed for `aihub <command> --help` (an agent that asks for help must not get an option error). */
export const HELP: Record<string, string> = {
  "cherry-pick": 'aihub cherry-pick --from <pr N|url|commit sha|story id> --to <branch> [--to <branch>...|--to-group <name>] [--summary-text "<1-2 sentences>"] [--no-pr|--direct]\n    Cherry-picks in a temp worktree, pushes a cherry-pick/... branch per target and opens a PR per target (template, story link) unless --no-pr.',
  comments: "aihub comments get [--pr <url|N>]\naihub comments reply [--pr <url|N>] --reply \"<threadId>:<status>:<text>\" [--reply ...]   (no file needed)\naihub comments reply [--pr <url|N>] --replies-file replies.yaml\n    replies.yaml: a list of {threadId, text, status} with status fixed|wontFix|closed|active (thread: and resolve: true also work).",
  story: "aihub story template   (prints the team story template: the headings to use)\naihub story create --title \"<title>\" --body-file story.md   (one ## <heading> section per template heading, all filled)",
  branch: "aihub branch update [--branch B] [--target T] [--rebase]",
  test: testCmd.TEST_USAGE,
};

/**
 * "--append-text - a bullet" is a value, not an option: Node's parser refuses a value that starts with a dash, but markdown bullets do.
 * A token that starts with "- " (dash and space) after a long option is joined as --option=value.
 */
export function mergeDashValues(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    if (a.startsWith("--") && !a.includes("=") && next !== undefined && /^- /.test(next)) {
      out.push(`${a}=${next}`);
      i++;
    } else out.push(a);
  }
  return out;
}

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
  if (HELP[name] && rest.includes("--help")) {
    ctx.out(HELP[name]);
    return 0;
  }
  const fn = registry[name];
  if (!fn) {
    ctx.err(`aihub: unknown command '${name}'. Commands: ${Object.keys(registry).join(", ")}.`);
    return 2;
  }
  // global flags: --verbose logs the real git/REST calls; --dry-run prints the writes it would do and skips them
  const ownDryRun = name === "fabric" || name === "legacy" || (name === "pr" && rest[0] === "create") || (name === "story" && storyFlow.STORY_FLOW_SUBS.includes(rest[0]));
  const verbose = rest.includes("--verbose");
  const dryRun = rest.includes("--dry-run");
  const args = mergeDashValues(rest.filter((a) => a !== "--verbose" && (ownDryRun || a !== "--dry-run")));
  let planned = 0;
  setTrace({
    dryRun,
    verbose,
    log: (l) => ctx.err(l),
    plan: (l) => {
      planned++;
      ctx.out(`dry-run: ${l}`);
    },
  });
  const run: Ctx = dryRun && !ownDryRun ? { ...ctx, out: (l) => ctx.out(`  (simulated) ${l}`) } : ctx;
  try {
    await fn(args, run);
    if (dryRun && name !== "fabric") ctx.out(`dry-run: ${planned} planned write(s), nothing was changed`);
    return 0;
  } catch (e) {
    if (dryRun && planned > 0) {
      ctx.out(`dry-run: stopped after the planned writes above, because the later steps need the real results (${(e as Error).message})`);
      return 0;
    }
    if (e instanceof AihubError) ctx.err(`aihub: ${e.message}`);
    else ctx.err(`aihub: unexpected error: ${(e as Error).message}`);
    return 1;
  } finally {
    setTrace({});
  }
}