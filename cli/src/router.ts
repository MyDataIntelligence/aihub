import type { Ctx } from "./lib/context.js";
import { AihubError } from "./lib/errors.js";
import { cliVersion } from "./lib/pack.js";
import { setTrace } from "./lib/trace.js";
import { runAllRepos, wantsAllRepos } from "./lib/allRepos.js";
import { appendJournal, isJournaled } from "./lib/journal.js";

export type CommandFn = (argv: string[], ctx: Ctx) => Promise<void>;

/** A command whose module is loaded when it runs: a call loads only what it needs (start-up ~0.15 s faster). */
const lazy =
  (load: () => Promise<{ run: CommandFn }>): CommandFn =>
  async (argv, ctx) =>
    (await load()).run(argv, ctx);

/**
 * Command registry. To add a command: create src/commands/<name>.ts exporting
 * `run(argv, ctx)` and add one line here. Commands print through ctx.out and
 * throw AihubError for user-facing failures.
 */
export const commands: Record<string, CommandFn> = {
  pr: async (argv, ctx) => {
    const sub = argv[0];
    const prAdmin = await import("./commands/pr-admin.js");
    if (prAdmin.PR_ADMIN_SUBS.includes(sub)) return prAdmin.run(argv, ctx);
    const prList = await import("./commands/pr-list.js");
    if (prList.PR_LIST_SUBS.includes(sub)) return prList.run(argv, ctx);
    const prPolicy = await import("./commands/pr-policy.js");
    if (prPolicy.PR_POLICY_SUBS.includes(sub)) return prPolicy.run(argv, ctx);
    const review = await import("./commands/review.js");
    if (review.PR_EXTRA_SUBS.includes(sub)) return review.runPrExtra(argv, ctx);
    return (await import("./commands/pr.js")).run(argv, ctx);
  },
  comments: lazy(() => import("./commands/comments.js")),
  init: lazy(() => import("./commands/init.js")),
  skills: lazy(() => import("./commands/skills.js")),
  doctor: lazy(() => import("./commands/doctor.js")),
  fabric: lazy(() => import("./commands/fabric.js")),
  dbt: lazy(() => import("./commands/dbt.js")),
  robot: lazy(() => import("./commands/robot.js")),
  "cherry-pick": lazy(() => import("./commands/cherry-pick.js")),
  branch: lazy(() => import("./commands/branch.js")),
  pipeline: lazy(() => import("./commands/pipeline.js")),
  batch: lazy(() => import("./commands/batch.js")),
  work: lazy(() => import("./commands/work.js")),
  story: async (argv, ctx) => {
    const sub = argv[0];
    const storyContext = await import("./commands/story-context.js");
    if (storyContext.STORY_CONTEXT_SUBS.includes(sub)) return storyContext.run(argv, ctx);
    const storyMemory = await import("./commands/story-memory.js");
    if (storyMemory.STORY_MEMORY_SUBS.includes(sub)) return storyMemory.run(argv, ctx);
    const storyBranches = await import("./commands/story-branches.js");
    if (storyBranches.STORY_BRANCHES_SUBS.includes(sub)) return storyBranches.run(argv, ctx);
    const storyFlow = await import("./commands/story-flow.js");
    if (storyFlow.STORY_FLOW_SUBS.includes(sub)) return storyFlow.run(argv, ctx);
    return (await import("./commands/story.js")).run(argv, ctx);
  },
  worktree: lazy(() => import("./commands/worktree.js")),
  review: lazy(() => import("./commands/review.js")),
  wiki: lazy(() => import("./commands/wiki.js")),
  release: lazy(() => import("./commands/release.js")),
  workitem: lazy(() => import("./commands/workitem.js")),
  evidence: lazy(() => import("./commands/evidence.js")),
  port: lazy(() => import("./commands/port.js")),
  crossrepo: lazy(() => import("./commands/crossrepo.js")),
  note: lazy(() => import("./commands/note.js")),
  status: lazy(() => import("./commands/status.js")),
  bar: lazy(() => import("./commands/bar.js")),
  watch: lazy(() => import("./commands/watch.js")),
  update: lazy(() => import("./commands/update.js")),
  explain: lazy(() => import("./commands/explain.js")),
  repos: lazy(() => import("./commands/repos.js")),
  open: lazy(() => import("./commands/open.js")),
  commit: lazy(() => import("./commands/commit.js")),
  boards: lazy(() => import("./commands/boards.js")),
  testplan: lazy(() => import("./commands/testplan.js")),
  artifacts: lazy(() => import("./commands/artifacts.js")),
  devops: lazy(() => import("./commands/devops.js")),
  search: lazy(() => import("./commands/search.js")),
  repo: lazy(() => import("./commands/repo.js")),
  policy: lazy(() => import("./commands/policy.js")),
  library: lazy(() => import("./commands/library.js")),
  test: lazy(() => import("./commands/test.js")),
  legacy: lazy(() => import("./commands/legacy.js")),
  fix: lazy(() => import("./commands/fix.js")),
  team: lazy(() => import("./commands/team.js")),
  probe: lazy(() => import("./commands/probe.js")),
  research: lazy(() => import("./commands/research.js")),
  learn: lazy(() => import("./commands/learn.js")),
  standup: lazy(() => import("./commands/standup.js")),
  handoff: lazy(() => import("./commands/handoff.js")),
};

export const VERSION = cliVersion();

/** One-line usage per command, printed for `aihub <command> --help` (an agent that asks for help must not get an option error). */
export const HELP: Record<string, string> = {
  bar: "aihub bar --json [--fabric] [--events N]\n    Everything the VS Code status bar shows in one process: status, checks of the active PR, Fabric failures and logs (--fabric), watching, the newest events.",
  "cherry-pick": 'aihub cherry-pick --from <pr N|url|commit sha|story id> --to <branch> [--to <branch>...|--to-group <name>] [--summary-text "<1-2 sentences>"] [--no-pr|--direct]\n    Cherry-picks in a temp worktree, pushes a cherry-pick/... branch per target and opens a PR per target (template, story link) unless --no-pr.',
  comments: "aihub comments get [--pr <url|N>]\naihub comments reply [--pr <url|N>] --reply \"<threadId>:<status>:<text>\" [--reply ...]   (no file needed)\naihub comments reply [--pr <url|N>] --replies-file replies.yaml\n    replies.yaml: a list of {threadId, text, status} with status fixed|wontFix|closed|active (thread: and resolve: true also work).",
  story: "aihub story branches [--id <story>]   (repo -> branches/worktrees of your stories; ★ = the one you work on)\naihub story branches link|unlink|mark|remove|place ...   (see aihub story branches --help)\naihub story open --id <story> [--mode worktree|switch] [--window new|this|none]   (the ★ of every repository as one set)\naihub story template   (prints the team story template: the headings to use)\naihub story create --title \"<title>\" --body-file story.md   (one ## <heading> section per template heading, all filled)",
  branch: "aihub branch update [--branch B] [--target T] [--rebase]",
};

/** The usage texts that live in their command module: loaded only for --help. */
export const LAZY_HELP: Record<string, () => Promise<string>> = {
  test: async () => (await import("./commands/test.js")).TEST_USAGE,
  probe: async () => (await import("./commands/probe.js")).PROBE_USAGE,
  research: async () => (await import("./commands/research.js")).RESEARCH_USAGE,
  learn: async () => (await import("./commands/learn.js")).LEARN_USAGE,
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
  if ((HELP[name] || LAZY_HELP[name]) && rest.includes("--help")) {
    ctx.out(HELP[name] ?? (await LAZY_HELP[name]()));
    return 0;
  }
  const fn = registry[name];
  if (!fn) {
    ctx.err(`aihub: unknown command '${name}'. Commands: ${Object.keys(registry).join(", ")}.`);
    return 2;
  }
  // global flags: --verbose logs the real git/REST calls; --dry-run prints the writes it would do and skips them
  const ownDryRun = name === "fabric" || name === "dbt" || name === "legacy" || name === "doctor" || (name === "pr" && rest[0] === "create") || (name === "story" && (await import("./commands/story-flow.js")).STORY_FLOW_SUBS.includes(rest[0]));
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
  const outLines: string[] = [];
  const base: Ctx = dryRun && !ownDryRun ? { ...ctx, out: (l) => ctx.out(`  (simulated) ${l}`) } : ctx;
  const run: Ctx = { ...base, out: (l) => (outLines.push(l), base.out(l)) };
  const journal = isJournaled(name, args) && !wantsAllRepos(name, args);
  const keep = (ok: boolean, err = "") => {
    if (journal) appendJournal(ctx.cwd, name, args, ok, name === "pipeline" && args[0] === "follow" ? [...outLines].reverse() : outLines, err, (ctx.now ?? Date.now)());
  };
  try {
    if (wantsAllRepos(name, args)) await runAllRepos(name, args, run, registry);
    else await fn(args, run);
    keep(true);
    if (dryRun && name !== "fabric" && name !== "dbt" && name !== "doctor") ctx.out(`dry-run: ${planned} planned write(s), nothing was changed`);
    return 0;
  } catch (e) {
    if (dryRun && planned > 0) {
      ctx.out(`dry-run: stopped after the planned writes above, because the later steps need the real results (${(e as Error).message})`);
      return 0;
    }
    keep(false, (e as Error).message);
    if (e instanceof AihubError) ctx.err(`aihub: ${e.message}`);
    else ctx.err(`aihub: unexpected error: ${(e as Error).message}`);
    return 1;
  } finally {
    setTrace({});
  }
}