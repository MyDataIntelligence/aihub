import { parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { addNote, listNotes } from "../lib/notes.js";

/** aihub note add "text" | --file F, aihub note list: private per-branch notes, never committed. */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  const p = parse(rest, { file: { type: "string" }, json: { type: "boolean" } }, true);
  if (sub === "add") return void ctx.out(addNote(ctx, { text: p.positionals.join(" "), file: p.values.file, json: p.values.json }));
  if (sub === "list") return void ctx.out(listNotes(ctx, { json: p.values.json }));
  throw new AihubError('usage: aihub note add "text" | add --file <file> | list');
}
