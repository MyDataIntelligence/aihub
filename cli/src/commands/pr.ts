import { parseArgs } from "node:util";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { createPr, updatePr } from "../lib/pr.js";
import { run as runChanges } from "./pr-changes.js";

function parse(argv: string[], options: Record<string, { type: "string" | "boolean" }>) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true }).values;
  } catch (e) {
    throw new AihubError(`${(e as Error).message}`);
  }
}

function num(v: unknown, flag: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(String(v).replace(/^AB#/i, ""));
  if (!Number.isInteger(n) || n <= 0) throw new AihubError(`${flag} must be a number`);
  return n;
}

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub === "changes") return runChanges(rest, ctx);
  if (sub === "create") {
    const v = parse(rest, {
      title: { type: "string" },
      "body-file": { type: "string" },
      target: { type: "string" },
      draft: { type: "boolean" },
      "work-item": { type: "string" },
      "dry-run": { type: "boolean" },
      "no-notes": { type: "boolean" },
      json: { type: "boolean" },
    });
    ctx.out(
      await createPr(ctx, {
        title: v.title as string | undefined,
        bodyFile: v["body-file"] as string | undefined,
        target: v.target as string | undefined,
        draft: v.draft as boolean | undefined,
        workItem: num(v["work-item"], "--work-item"),
        dryRun: v["dry-run"] as boolean | undefined,
        noNotes: v["no-notes"] as boolean | undefined,
        json: v.json as boolean | undefined,
      }),
    );
    return;
  }
  if (sub === "update") {
    const v = parse(rest, {
      pr: { type: "string" },
      "body-file": { type: "string" },
      section: { type: "string" },
      "append-file": { type: "string" },
      "replace-file": { type: "string" },
      title: { type: "string" },
      draft: { type: "string" },
      target: { type: "string" },
      "no-notes": { type: "boolean" },
      json: { type: "boolean" },
    });
    let draft: boolean | undefined;
    if (v.draft !== undefined) {
      if (v.draft !== "true" && v.draft !== "false") throw new AihubError("--draft must be true or false");
      draft = v.draft === "true";
    }
    ctx.out(
      await updatePr(ctx, {
        pr: v.pr as string | undefined,
        bodyFile: v["body-file"] as string | undefined,
        section: v.section as string | undefined,
        appendFile: v["append-file"] as string | undefined,
        replaceFile: v["replace-file"] as string | undefined,
        title: v.title as string | undefined,
        draft,
        target: v.target as string | undefined,
        noNotes: v["no-notes"] as boolean | undefined,
        json: v.json as boolean | undefined,
      }),
    );
    return;
  }
  throw new AihubError("usage: aihub pr create|update [flags] (see README)");
}
