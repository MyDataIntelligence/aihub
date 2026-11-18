import { parse } from "../lib/args.js";
import { commitChanges } from "../lib/commit.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";

export const COMMIT_USAGE =
  'aihub commit --type <type> --subject "<what changed>" [--scope s] [--story id] [--push] [--no-add] [--no-verify]\n' +
  "    One call: stages everything, builds the message from the team's commits.format in team.yaml (story id from the branch name, scope from the changed folder), commits, optionally pushes. Prints a line before the repository's git hooks run and how long they took; --no-verify skips them ONLY when the user explicitly asked for that.";

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  if (argv.includes("--help") || argv[0] === "help") {
    ctx.out(COMMIT_USAGE);
    return;
  }
  const v = parse(argv, {
    type: { type: "string" },
    scope: { type: "string" },
    subject: { type: "string" },
    story: { type: "string" },
    push: { type: "boolean" },
    "no-add": { type: "boolean" },
    "no-verify": { type: "boolean" },
    json: { type: "boolean" },
  }).values;
  const story = v.story === undefined ? undefined : Number(String(v.story).replace(/^AB#/i, ""));
  if (story !== undefined && (!Number.isInteger(story) || story <= 0)) throw new AihubError("--story must be a number");
  ctx.out(await commitChanges(ctx, { type: v.type, scope: v.scope, subject: v.subject, story, push: v.push, noAdd: v["no-add"], noVerify: v["no-verify"], json: v.json }));
}
