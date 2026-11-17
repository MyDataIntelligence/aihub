import { parse } from "../lib/args.js";
import { cherryPick } from "../lib/cherryPick.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const v = parse(argv, {
    from: { type: "string" },
    to: { type: "string", multiple: true },
    "to-group": { type: "string" },
    pr: { type: "boolean" },
    direct: { type: "boolean" },
    "body-file": { type: "string" },
    json: { type: "boolean" },
  }).values;
  if (!v.from) throw new AihubError("aihub cherry-pick needs --from <pr N|url|commit sha,...|story id>");
  await cherryPick(ctx, {
    from: v.from,
    to: v.to ?? [],
    toGroup: v["to-group"],
    pr: v.pr,
    direct: v.direct,
    bodyFile: v["body-file"],
    json: v.json,
  });
}
