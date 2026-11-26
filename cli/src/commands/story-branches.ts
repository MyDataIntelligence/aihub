import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { list, optInt, parseFlags, posInt } from "../lib/cliargs.js";
import { againOf, formatOpenSet, type OpenMode, type OpenWindow } from "../lib/repoSet.js";
import { existingFlag, orChoiceAsync } from "../lib/existingWorktree.js";
import { formatStoryBranches, linkStoryBranches, listStoryBranches, markStoryBranch, openStory, placeWorktrees, removeStoryBranch, unlinkStoryBranch } from "../lib/storyBranches.js";
import type { BranchStatus } from "../lib/storyWorktrees.js";

export const STORY_BRANCHES_SUBS = ["branches", "open"];

const USAGE = `usage: aihub story branches [--id <story>] [--json]            (your active stories, or one: repo -> branches, ★ = the one you work on)
       aihub story branches link --id <story> [--branch a,b] [--repo <name>] [--current]
       aihub story branches unlink --id <story> --branch <b> [--repo <name>]
       aihub story branches mark --branch <b> --status current|old|parked [--label <text>] [--id <story>] [--repo <name>]
       aihub story branches remove --branch <b> [--repo <name>] [--delete-branch]   (never throws away local work)
       aihub story branches place [--move all|<path>,<repo:branch>] [--json]        (worktrees to <root>/<id>-<slug>/<repo>[--variant])
       aihub story open --id <story> [--mode worktree|switch] [--window new|this|none] [--existing move|reuse|recreate] [--json]   (the ★ of every repository as one set)`;

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  const action = sub === "branches" && rest[0] && !rest[0].startsWith("-") ? rest.shift() : undefined;
  const v = parseFlags(rest, {
    id: { type: "string" },
    branch: { type: "string" },
    repo: { type: "string" },
    status: { type: "string" },
    label: { type: "string" },
    current: { type: "boolean" },
    "delete-branch": { type: "boolean" },
    move: { type: "string" },
    mode: { type: "string" },
    window: { type: "string" },
    root: { type: "string" },
    existing: { type: "string" },
    "discard-local-work": { type: "boolean" },
    json: { type: "boolean" },
  });
  const json = !!v.json;
  const repo = v.repo as string | undefined;
  const say = (lines: string | string[], data?: unknown) => ctx.out(json ? JSON.stringify(data ?? { messages: ([] as string[]).concat(lines) }) : ([] as string[]).concat(lines).join("\n"));
  if (sub === "open") {
    const mode = ((v.mode as string | undefined) ?? "worktree") as OpenMode;
    const window = ((v.window as string | undefined) ?? "new") as OpenWindow;
    if (mode !== "worktree" && mode !== "switch") throw new AihubError("--mode must be worktree or switch");
    if (!["new", "this", "none"].includes(window)) throw new AihubError("--window must be new, this or none");
    const r = await orChoiceAsync(json, ctx.out, () => openStory(ctx, { id: posInt(v.id, "--id"), mode, window, root: v.root as string | undefined, existing: existingFlag(v.existing), discardLocalWork: !!v["discard-local-work"], again: againOf(["story", ...argv]) }));
    if (!r) return;
    return void ctx.out(json ? JSON.stringify(r) : formatOpenSet(r));
  }
  if (sub !== "branches") throw new AihubError(USAGE);
  if (!action || action === "list") {
    const rows = await listStoryBranches(ctx, { id: optInt(v.id, "--id") });
    return void ctx.out(json ? JSON.stringify({ stories: rows }) : formatStoryBranches(rows));
  }
  if (action === "link") return say(await linkStoryBranches(ctx, { id: posInt(v.id, "--id"), branches: list(v.branch), repo, current: !!v.current }));
  if (action === "unlink") return say(await unlinkStoryBranch(ctx, { id: posInt(v.id, "--id"), branch: need(v.branch), repo }));
  if (action === "mark") {
    const status = v.status as BranchStatus | undefined;
    if (status && !["current", "old", "parked"].includes(status)) throw new AihubError("--status must be current, old or parked");
    if (!status && v.label === undefined) throw new AihubError("give --status current|old|parked and/or --label <text>");
    return say(markStoryBranch(ctx, { branch: need(v.branch), status, label: v.label as string | undefined, id: optInt(v.id, "--id"), repo }));
  }
  if (action === "remove") return say(removeStoryBranch(ctx, { branch: need(v.branch), repo, deleteBranch: !!v["delete-branch"], discardLocalWork: !!v["discard-local-work"] }));
  if (action === "place") {
    const move = v.move === "all" ? "all" : list(v.move);
    const r = placeWorktrees(ctx, { root: v.root as string | undefined, move: move === "all" || move.length ? move : undefined });
    if (json) return void ctx.out(JSON.stringify(r));
    const lines = r.misplaced.length ? r.misplaced.map((m) => `${m.repo} ${m.branch}: ${m.path} -> ${m.target}`) : ["every story worktree is in its story folder"];
    return void ctx.out([...lines, ...r.moved].join("\n"));
  }
  throw new AihubError(USAGE);
}

function need(b: unknown): string {
  if (typeof b !== "string" || !b.trim()) throw new AihubError("--branch <name> is required");
  return b.trim();
}
