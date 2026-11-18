import { readFileSync } from "node:fs";
import { parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { changeFacts, formatChange, formatRepo, repoFacts, type ChangeFacts } from "../lib/learn.js";
import { validateExplanation } from "../lib/learnSchema.js";

export const LEARN_USAGE = [
  "aihub learn change [--pr N|url] [--branch B] [--range base..head] [--json]   facts of a change: files, hunks, changed names, who uses them, tests, dbt lineage",
  "aihub learn repo [--json]                                                    facts of the repository: folders, languages, entry points, tests, pipelines, dbt graph",
  "aihub learn validate --file explanation.json [--facts facts.json] [--json]   check a written explanation against the schema (docs/learn-schema.md)",
  "    The CLI only gives facts (git and files, under a second); the learn skill writes the lesson. Nothing is stored in the repository.",
].join(String.fromCharCode(10));

/** aihub learn change|repo|validate */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  const v = parse(rest, { pr: { type: "string" }, branch: { type: "string" }, range: { type: "string" }, file: { type: "string" }, facts: { type: "string" }, json: { type: "boolean" } }).values;
  if (sub === "change") {
    const f = await changeFacts(ctx, { pr: v.pr, branch: v.branch, range: v.range });
    return void ctx.out(v.json ? JSON.stringify(f) : formatChange(f));
  }
  if (sub === "repo") {
    const f = repoFacts(ctx);
    return void ctx.out(v.json ? JSON.stringify(f) : formatRepo(f));
  }
  if (sub === "validate") {
    if (!v.file) throw new AihubError("aihub learn validate needs --file <explanation.json>");
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(v.file, "utf8"));
    } catch (e) {
      throw new AihubError(`${v.file} is not valid JSON: ${(e as Error).message}`);
    }
    const facts = v.facts ? (JSON.parse(readFileSync(v.facts, "utf8")) as ChangeFacts) : undefined;
    const r = validateExplanation(json, facts);
    const nl = String.fromCharCode(10);
    ctx.out(v.json ? JSON.stringify(r) : r.ok ? `OK${r.warnings.map((w) => `${nl}  warning: ${w}`).join("")}` : `INVALID${nl}${r.errors.map((x) => `  ${x}`).join(nl)}${r.warnings.map((w) => `${nl}  warning: ${w}`).join("")}`);
    if (!r.ok) throw new AihubError("the explanation is not valid; fix the lines above and validate again");
    return;
  }
  throw new AihubError(`usage:${String.fromCharCode(10)}${LEARN_USAGE}`);
}
