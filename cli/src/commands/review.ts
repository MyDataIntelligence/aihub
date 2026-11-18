import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { optInt, parseFlags } from "../lib/cliargs.js";
import { prComplete, prExplain, reviewPost, reviewPostPicked, reviewPrepare, reviewShow } from "../lib/review.js";

export const PR_EXTRA_SUBS = ["explain", "complete"];

function need(v: unknown, flag: string): string {
  if (typeof v !== "string" || !v) throw new AihubError(`${flag} is required`);
  return v;
}

/** aihub review show|post */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  const v = parseFlags(rest, {
    pr: { type: "string" },
    "comments-file": { type: "string" },
    "findings-file": { type: "string" },
    pick: { type: "string" },
    "max-files": { type: "string" },
    "max-diff-lines": { type: "string" },
    "no-diff": { type: "boolean" },
    json: { type: "boolean" },
  });
  if (sub === "show") {
    ctx.out(
      await reviewShow(ctx, {
        pr: need(v.pr, "--pr"),
        maxFiles: optInt(v["max-files"], "--max-files"),
        maxDiffLines: optInt(v["max-diff-lines"], "--max-diff-lines"),
        noDiff: !!v["no-diff"],
        json: !!v.json,
      }),
    );
  } else if (sub === "prepare") {
    ctx.out(await reviewPrepare(ctx, { pr: need(v.pr, "--pr"), maxFiles: optInt(v["max-files"], "--max-files"), maxDiffLines: optInt(v["max-diff-lines"], "--max-diff-lines"), json: !!v.json }));
  } else if (sub === "post" && !v["comments-file"]) {
    ctx.out(await reviewPostPicked(ctx, { pr: need(v.pr, "--pr"), findingsFile: v["findings-file"] as string | undefined, pick: v.pick as string | undefined, json: !!v.json }));
  } else if (sub === "post") {
    ctx.out(await reviewPost(ctx, { pr: need(v.pr, "--pr"), commentsFile: need(v["comments-file"], "--comments-file"), json: !!v.json }));
  } else throw new AihubError("usage: aihub review show|prepare --pr <n|url> | review post --pr <n> [--pick 1,3,5] [--findings-file f] | review post --pr <n> --comments-file <file.yaml>");
}

/** aihub pr explain|complete (the other pr subcommands live in commands/pr.ts). */
export async function runPrExtra(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  const v = parseFlags(rest, {
    pr: { type: "string" },
    auto: { type: "boolean" },
    "delete-source": { type: "boolean" },
    squash: { type: "boolean" },
    json: { type: "boolean" },
  });
  const pr = need(v.pr, "--pr");
  if (sub === "explain") ctx.out(await prExplain(ctx, { pr, json: !!v.json }));
  else if (sub === "complete") {
    ctx.out(await prComplete(ctx, { pr, auto: !!v.auto, deleteSource: !!v["delete-source"], squash: !!v.squash, json: !!v.json }));
  } else throw new AihubError("usage: aihub pr explain|complete --pr <n>");
}
