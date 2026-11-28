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
    const storyE2e = await import("./commands/e2e.js");
    if (storyE2e.STORY_E2E_SUBS.includes(sub)) return storyE2e.runStoryE2e(argv, ctx);
    const storyFlow = await import("./commands/story-flow.js");
    if (storyFlow.STORY_FLOW_SUBS.includes(sub)) return storyFlow.run(argv, ctx);
    return (await import("./commands/story.js")).run(argv, ctx);
  },
  worktree: lazy(() => import("./commands/worktree.js")),
  recent: lazy(() => import("./commands/recent.js")),
  review: lazy(() => import("./commands/review.js")),
  wiki: lazy(() => import("./commands/wiki.js")),
  release: lazy(() => import("./commands/release.js")),
  workitem: lazy(() => import("./commands/workitem.js")),
  evidence: lazy(() => import("./commands/evidence.js")),
  port: lazy(() => import("./commands/port.js")),
  crossrepo: lazy(() => import("./commands/crossrepo.js")),
  note: lazy(() => import("./commands/note.js")),
  guidelines: lazy(() => import("./commands/guidelines.js")),
  status: lazy(() => import("./commands/status.js")),
  bar: lazy(() => import("./commands/bar.js")),
  token: lazy(() => import("./commands/token.js")),
  watch: lazy(() => import("./commands/watch.js")),
  update: lazy(() => import("./commands/update.js")),
  explain: lazy(() => import("./commands/explain.js")),
  repos: lazy(() => import("./commands/repos.js")),
  browse: lazy(() => import("./commands/browse.js")),
  stories: lazy(() => import("./commands/stories.js")),
  prompt: async (argv, ctx) => (await import("./commands/e2e.js")).runPrompt(argv, ctx),
  criteria: async (argv, ctx) => (await import("./commands/e2e.js")).runCriteria(argv, ctx),
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
  preflight: lazy(() => import("./commands/preflight.js")),
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
    ctx.out(`aihub ${VERSION}: Azure DevOps team workflows in one call. Commands: ${Object.keys(registry).join(", ")}. Usage of one: aihub <command> --help.`);
    return 0;
  }
  if (name === "--version" || name === "-v") {
    ctx.out(VERSION);
    return 0;
  }
  // --help and -h work for every command and subcommand (fabric prints its own); short: the usage lines and one example
  if (name !== "fabric" && registry[name] && (rest.includes("--help") || rest.includes("-h") || rest[0] === "help")) {
    const text = await (await import("./lib/help.js")).helpFor(name, rest[0] === "help" ? rest[1] : rest[0]);
    if (text) {
      ctx.out(text);
      return 0;
    }
  }
  const fn = registry[name];
  if (!fn) {
    const near = (await import("./lib/help.js")).suggest(name, Object.keys(registry));
    ctx.err(`aihub: unknown command '${name}'${near.length ? `; did you mean: ${near.join(", ")}?` : ""} (aihub --help lists them all)`);
    return 2;
  }
  // global flags: --verbose logs the real git/REST calls; --dry-run prints the writes it would do and skips them
  const ownDryRun = name === "fabric" || name === "dbt" || name === "preflight" || name === "legacy" || name === "doctor" || (name === "pr" && rest[0] === "create") || (name === "story" && (await import("./commands/story-flow.js")).STORY_FLOW_SUBS.includes(rest[0]));
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
    if (dryRun && name !== "fabric" && name !== "dbt" && name !== "doctor" && name !== "preflight") ctx.out(`dry-run: ${planned} planned write(s), nothing was changed`);
    return 0;
  } catch (e) {
    if (dryRun && planned > 0) {
      ctx.out(`dry-run: stopped after the planned writes above, because the later steps need the real results (${(e as Error).message})`);
      return 0;
    }
    keep(false, (e as Error).message);
    if (e instanceof AihubError) ctx.err(`aihub: ${name === "fabric" ? e.message : await (await import("./lib/help.js")).shortenUsageError(name, args, e.message)}`);
    else ctx.err(`aihub: unexpected error: ${(e as Error).message}`);
    // 3: one team setting is unclear (MissingTeamSetting); the agent asks the user and runs the `aihub team set` it names
    return (e as { exitCode?: number }).exitCode ?? 1;
  } finally {
    setTrace({});
  }
}