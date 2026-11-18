import { parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { resume } from "../lib/resume.js";
import { formatStatus, getStatus } from "../lib/status.js";

/** aihub status [--json]: where this branch stands and the next step. --resume: the same from the local journal, without network (after a compaction or in a new chat). */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const v = parse(argv, { json: { type: "boolean" }, resume: { type: "boolean" } }).values;
  if (v.resume) {
    const r = resume(ctx);
    ctx.out(v.json ? JSON.stringify({ branch: r.branch, story: r.story, last: r.last, done: r.done, rest: r.rest, next: r.next, dirty: r.dirty, unpushed: r.unpushed, note: r.note }) : r.text);
    return;
  }
  const s = await getStatus(ctx);
  ctx.out(v.json ? JSON.stringify(s) : formatStatus(s));
}
