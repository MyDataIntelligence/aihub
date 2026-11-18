import { readFileSync } from "node:fs";
import { parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { changeFacts, formatChange, formatRepo, repoFacts, type ChangeFacts } from "../lib/learn.js";
import { validateExplanation } from "../lib/learnSchema.js";
import { learnConcepts, learnForget, learnHome, learnList, learnMark, learnQuiz, learnSave, learnScore, learnShow } from "../lib/learnStore.js";

const NL = String.fromCharCode(10);

export const LEARN_USAGE = [
  "aihub learn change [--pr N|url] [--branch B] [--range base..head] [--json]   facts of a change: files, hunks, changed names, who uses them, tests, dbt lineage",
  "aihub learn repo [--json]                                                    facts of the repository: folders, languages, entry points, tests, pipelines, dbt graph",
  "aihub learn validate --file explanation.json [--facts facts.json] [--json]   check a written explanation against the schema (docs/learn-schema.md)",
  "aihub learn save --file explanation.json [--facts facts.json] [--json]       validate and keep it in your personal store (~/.config/aihub/learn); nothing goes into the repository",
  "aihub learn list [--all] [--json] | show --id ID [--json] | forget --id ID    your saved lessons (this repository, or --all)",
  "aihub learn concepts [--all] [--mark NAME|--unmark NAME] [--json]            the concepts of your lessons and which you marked as learned",
  "aihub learn quiz [--id ID] [--score ID --correct N --of M] [--json]          the questions of a lesson (or of the newest ones); --score keeps a result",
  "    The CLI gives facts and keeps your lessons (git and files, under a second); the learn skill writes the lesson.",
].join(NL);

/** aihub learn change|repo|validate|save|list|show|forget|concepts|quiz */
export async function run(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  const v = parse(rest, {
    pr: { type: "string" },
    branch: { type: "string" },
    range: { type: "string" },
    file: { type: "string" },
    facts: { type: "string" },
    id: { type: "string" },
    all: { type: "boolean" },
    mark: { type: "string" },
    unmark: { type: "string" },
    score: { type: "string" },
    correct: { type: "string" },
    of: { type: "string" },
    json: { type: "boolean" },
  }).values;
  const out = (data: unknown, text: string) => ctx.out(v.json ? JSON.stringify(data) : text);
  if (sub === "change") {
    const f = await changeFacts(ctx, { pr: v.pr, branch: v.branch, range: v.range });
    return out(f, formatChange(f));
  }
  if (sub === "repo") {
    const f = repoFacts(ctx);
    return out(f, formatRepo(f));
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
    ctx.out(v.json ? JSON.stringify(r) : r.ok ? `OK${r.warnings.map((w) => `${NL}  warning: ${w}`).join("")}` : `INVALID${NL}${r.errors.map((x) => `  ${x}`).join(NL)}${r.warnings.map((w) => `${NL}  warning: ${w}`).join("")}`);
    if (!r.ok) throw new AihubError("the explanation is not valid; fix the lines above and validate again");
    return;
  }
  if (sub === "save") {
    if (!v.file) throw new AihubError("aihub learn save needs --file <explanation.json>");
    const l = learnSave(ctx, { file: v.file, facts: v.facts });
    return out(l.meta, `saved lesson ${l.meta.id} in ${learnHome(ctx.env)}${NL}open it in VS Code: AI Context Hub: Learn, or aihub learn show --id ${l.meta.id}`);
  }
  if (sub === "list") {
    const list = learnList(ctx, { all: v.all });
    return out(list, list.length ? list.map((m) => `${m.id}  ${m.savedAt.slice(0, 10)}  ${m.title}`).join(NL) : "no saved lessons yet (the /leer skill saves one with aihub learn save)");
  }
  if (sub === "show") {
    if (!v.id) throw new AihubError("aihub learn show needs --id <lesson id> (see aihub learn list)");
    const l = learnShow(ctx, v.id);
    const e = l.explanation;
    return out(l, [l.meta.title, `before: ${String(e.before)}`, `after: ${String(e.after)}`, `${l.meta.concepts} concept(s), ${l.meta.quiz} quiz question(s); use --json for the whole lesson`].join(NL));
  }
  if (sub === "forget") {
    if (!v.id) throw new AihubError("aihub learn forget needs --id <lesson id>");
    learnForget(ctx, v.id);
    return ctx.out(`forgot ${v.id}`);
  }
  if (sub === "concepts") {
    if (v.mark || v.unmark) {
      learnMark(ctx, (v.mark ?? v.unmark) as string, !!v.mark);
      return ctx.out(v.mark ? `marked "${v.mark}" as learned` : `"${v.unmark}" is open again`);
    }
    const rows = learnConcepts(ctx, { all: v.all });
    return out(rows, rows.length ? rows.map((r) => `${r.learned ? "[x]" : "[ ]"} ${r.name}: ${r.eli5}`).join(NL) : "no concepts yet: they come with your saved lessons");
  }
  if (sub === "quiz") {
    if (v.score) {
      const n = Number(v.correct);
      const of = Number(v.of);
      if (!Number.isInteger(n) || !Number.isInteger(of) || of < 1 || n < 0 || n > of) throw new AihubError("--score <lesson id> needs --correct N --of M (whole numbers, N <= M)");
      learnScore(ctx, v.score, n, of);
      return ctx.out(`kept ${n}/${of} for ${v.score}`);
    }
    const items = learnQuiz(ctx, { id: v.id });
    return out(items, items.length ? items.map((q, i) => `${i + 1}. ${q.item.question}${NL}${q.item.options.map((o, k) => `   ${String.fromCharCode(97 + k)}) ${o}`).join(NL)}`).join(NL) : "no quiz questions yet");
  }
  throw new AihubError(`usage:${NL}${LEARN_USAGE}`);
}
