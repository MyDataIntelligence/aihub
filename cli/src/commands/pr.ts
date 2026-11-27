import { afterPrOffer } from "../lib/learnProfile.js";
import { parseArgs } from "node:util";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { setHint } from "../lib/allRepos.js";
import { createPr, updatePr } from "../lib/pr.js";
import { run as runChanges } from "./pr-changes.js";

function parse(argv: string[], options: Record<string, { type: "string" | "boolean" }>) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true });
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

export const PR_USAGE = [
  "aihub pr create [--summary-text \"<1-2 sentences>\"] [--body-file f.md] [--title t] [--target b] [--draft] [--work-item n] [--dry-run] [--as-is] [--anyway]",
  "    One call: pushes the branch, fills the team template (story link, commits, empty sections) and opens the PR.",
  "    A vague section for the reader's actions (user actions, migration, ...) is refused: name files, fields old -> new, how to check. --as-is skips that check.",
  "    The story's acceptance criteria become the section Acceptatiecriteria with \"N/M bewezen\" on top; not all proven: exit 5 with the choices (test first, --draft, --anyway).",
  "aihub pr update [--pr <url|N>] --section \"<heading>\" (--append-text \"<text>\" | --append-file f | --replace-text \"<text>\" | --replace-file f)",
  "    Changes ONE section and keeps the rest. Short text inline, long prose from a file.",
  "aihub pr update [--pr <url|N>] [--body-file f.md] [--title t] [--draft true|false] [--target b]   (--body-file merges the sections it contains)",
  "aihub pr impact [--target b] [--json]",
  "    What changed in the platform contract (team.yaml pullRequest.userImpact) and which user files still use removed keys: the facts for the user-actions section.",
  "aihub pr changes [--pr <url|N>]",
].join("\n");

export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "help" || rest.includes("--help")) {
    ctx.out(PR_USAGE);
    return;
  }
  if (sub === "changes") return runChanges(rest, ctx);
  if (sub === "impact") {
    const v = parse(rest, { target: { type: "string" }, json: { type: "boolean" } }).values;
    ctx.out(await (await import("../lib/prImpact.js")).prImpact(ctx, { target: v.target as string | undefined, json: v.json as boolean | undefined }));
    return;
  }
  if (sub === "create") {
    const v = parse(rest, {
      title: { type: "string" },
      "summary-text": { type: "string" },
      "body-file": { type: "string" },
      target: { type: "string" },
      draft: { type: "boolean" },
      "work-item": { type: "string" },
      "dry-run": { type: "boolean" },
      "no-notes": { type: "boolean" },
      "as-is": { type: "boolean" },
      anyway: { type: "boolean" },
      json: { type: "boolean" },
    }).values;
    const created = await createPr(ctx, {
        summaryText: v["summary-text"] as string | undefined,
        title: v.title as string | undefined,
        bodyFile: v["body-file"] as string | undefined,
        target: v.target as string | undefined,
        draft: v.draft as boolean | undefined,
        workItem: num(v["work-item"], "--work-item"),
        dryRun: v["dry-run"] as boolean | undefined,
        noNotes: v["no-notes"] as boolean | undefined,
        asIs: v["as-is"] as boolean | undefined,
        anyway: v.anyway as boolean | undefined,
        json: v.json as boolean | undefined,
      });
    ctx.out(created);
    const hint = v.json || v["dry-run"] ? "" : setHint(ctx.cwd, "pr create");
    if (hint) ctx.out(hint);
    const offer = v.json || v["dry-run"] ? "" : afterPrOffer(ctx);
    if (offer) ctx.out(offer);
    return;
  }
  if (sub === "update") {
    const parsed = parse(rest, {
      pr: { type: "string" },
      "body-file": { type: "string" },
      section: { type: "string" },
      "append-file": { type: "string" },
      "append-text": { type: "string" },
      "replace-file": { type: "string" },
      "replace-text": { type: "string" },
      title: { type: "string" },
      draft: { type: "string" },
      target: { type: "string" },
      "no-notes": { type: "boolean" },
      "as-is": { type: "boolean" },
      json: { type: "boolean" },
    });
    const v = parsed.values;
    let draft: boolean | undefined;
    if (v.draft !== undefined) {
      if (v.draft !== "true" && v.draft !== "false") throw new AihubError("--draft must be true or false");
      draft = v.draft === "true";
    }
    ctx.out(
      await updatePr(ctx, {
        pr: (v.pr as string | undefined) ?? parsed.positionals[0],
        bodyFile: v["body-file"] as string | undefined,
        section: v.section as string | undefined,
        appendFile: v["append-file"] as string | undefined,
        appendText: v["append-text"] as string | undefined,
        replaceFile: v["replace-file"] as string | undefined,
        replaceText: v["replace-text"] as string | undefined,
        title: v.title as string | undefined,
        draft,
        target: v.target as string | undefined,
        noNotes: v["no-notes"] as boolean | undefined,
        asIs: v["as-is"] as boolean | undefined,
        json: v.json as boolean | undefined,
      }),
    );
    return;
  }
  throw new AihubError("usage: aihub pr create|update [flags] (see README)");
}
