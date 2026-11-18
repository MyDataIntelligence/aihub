import { afterPrOffer } from "../lib/learnProfile.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { list, parseFlags, posInt } from "../lib/cliargs.js";
import { finishStory, linkStory, startStory } from "../lib/story-flow.js";

export const STORY_FLOW_SUBS = ["start", "link", "finish"];

/** aihub story start|link|finish (create|refine|show live in the story command of the stories flow). */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  const v = parseFlags(rest, {
    id: { type: "string" },
    repos: { type: "string" },
    base: { type: "string" },
    root: { type: "string" },
    branch: { type: "string" },
    checkout: { type: "boolean" },
    "no-checkout": { type: "boolean" },
    "dry-run": { type: "boolean" },
    "no-state": { type: "boolean" },
    json: { type: "boolean" },
  });
  if (!STORY_FLOW_SUBS.includes(sub ?? "")) throw new AihubError("usage: aihub story start|link|finish --id <story> [flags]");
  const id = posInt(v.id, "--id");
  const json = !!v.json;
  if (sub === "start") {
    ctx.out(
      await startStory(ctx, {
        id,
        repos: list(v.repos),
        base: v.base as string | undefined,
        root: v.root as string | undefined,
        checkout: v.checkout as boolean | undefined,
        noCheckout: v["no-checkout"] as boolean | undefined,
        json,
      }),
    );
  } else if (sub === "link") {
    ctx.out(await linkStory(ctx, { id, branch: v.branch as string | undefined, json }));
  } else {
    ctx.out(
      await finishStory(ctx, {
        id,
        repos: list(v.repos),
        root: v.root as string | undefined,
        dryRun: !!v["dry-run"],
        noState: !!v["no-state"],
        json,
      }),
    );
    if (!json && !v["dry-run"]) {
      const offer = afterPrOffer(ctx);
      if (offer) ctx.out(offer);
    }
  }
}
