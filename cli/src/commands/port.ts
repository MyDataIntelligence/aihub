import { parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { formatPort, port } from "../lib/port.js";

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const v = parse(argv, {
    "from-repo": { type: "string" },
    from: { type: "string" },
    "to-repo": { type: "string" },
    "to-branch": { type: "string" },
    "path-map": { type: "string", multiple: true },
    map: { type: "string" },
    strict: { type: "boolean" },
    pr: { type: "boolean" },
    "body-file": { type: "string" },
    json: { type: "boolean" },
  }).values;
  if (!v["from-repo"] || !v.from || !v["to-repo"]) {
    throw new AihubError("aihub port needs --from-repo <A> --from <pr N|commit sha,...|story id> --to-repo <B> [--to-branch T] [--path-map 'src=>dst' | --map <name>] [--pr --body-file F]");
  }
  const r = await port(ctx, {
    fromRepo: v["from-repo"],
    from: v.from,
    toRepo: v["to-repo"],
    toBranch: v["to-branch"],
    pathMaps: v["path-map"],
    map: v.map,
    strict: v.strict,
    pr: v.pr,
    bodyFile: v["body-file"],
  });
  if (v.json) ctx.out(JSON.stringify(r));
  else for (const l of formatPort(r, v["from-repo"], v["to-repo"])) ctx.out(l);
  if (r.result === "conflict" || r.result === "failed" || r.result === "refused") throw new AihubError(`port stopped: ${r.detail}`);
}
