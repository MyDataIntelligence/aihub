import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { intList, list, parseFlags } from "../lib/cliargs.js";
import { releasePlan, releaseRun } from "../lib/release.js";

/** aihub release plan|run */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  const v = parseFlags(rest, {
    stories: { type: "string" },
    prs: { type: "string" },
    target: { type: "string" },
    "also-cherry-pick-to": { type: "string" },
    name: { type: "string" },
    version: { type: "string" },
    commits: { type: "string" },
    tags: { type: "string" },
    out: { type: "string" },
    "plan-file": { type: "string" },
    json: { type: "boolean" },
  });
  if (sub === "plan") {
    ctx.out(
      await releasePlan(ctx, {
        stories: intList(v.stories, "--stories"),
        prs: intList(v.prs, "--prs"),
        target: v.target as string | undefined,
        also: list(v["also-cherry-pick-to"]),
        name: v.name as string | undefined,
        version: v.version as string | undefined,
        commits: list(v.commits),
        tags: list(v.tags),
        out: v.out as string | undefined,
        json: !!v.json,
      }),
    );
  } else if (sub === "run") {
    if (!v["plan-file"]) throw new AihubError("aihub release run needs --plan-file <file.yaml>");
    ctx.out(await releaseRun(ctx, { planFile: v["plan-file"] as string, json: !!v.json }));
  } else throw new AihubError("usage: aihub release plan --stories a,b|--prs a,b --target <branch> | release run --plan-file <file>");
}
