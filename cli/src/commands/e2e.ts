import { readFileSync } from "node:fs";
import { num as numOrThrow, parse } from "../lib/args.js";
import type { Ctx } from "../lib/context.js";
import { AihubError } from "../lib/errors.js";
import { BrowseError, errorJson } from "../lib/browse/core.js";

/**
 * aihub prompt ... | aihub criteria ... | aihub story progress|yolo: Run End to End and the agent actions per story.
 * Text for the agent by default, JSON with --json (the bar always passes --json).
 */

export const PROMPT_USAGE = `usage: aihub prompt render <action> --id N [--json] | list [--json] | save <action> --id N --text-file f | reset <action> --id N
  actions: story-start, story-run, story-criteria, story-refine, story-test-fabric, story-tests, story-pr, story-pr-review, story-fix-pipeline, story-explain, bug-reproduce, bug-run
  the team prompt (.agents/skills/_shared/prompts/<action>.md) wins over the default; placeholders come from the story, its set and team.yaml`;

export const CRITERIA_USAGE = `usage: aihub criteria show|status --id N [--json] | record --id N --criterion K --result pass|fail|notrun [--evidence <link>] [--reason <text>]
       aihub criteria proposal-file --id N | proposal --id N [--json] | apply --id N --rev R --take 1,2,3
  criteria live in the criteria field of the work item, each with "Hoe getest:" and "Bewijs:" under it; the status is kept in the set or branch`;

export const STORY_E2E_SUBS = ["progress", "yolo", "plan-file"];

type V = Record<string, string | boolean | undefined>;

const str = (v: V, k: string) => (typeof v[k] === "string" && (v[k] as string).trim() ? (v[k] as string) : undefined);
const num = (x: unknown, flag: string) => {
  try {
    return numOrThrow(x, flag);
  } catch (e) {
    throw new BrowseError("badInput", (e as Error).message);
  }
};
const need = (v: V, k: string) => {
  const x = str(v, k);
  if (!x) throw new BrowseError("badInput", `--${k} is needed`);
  return x;
};
const idOf = (v: V) => num(need(v, "id"), "--id")!;
const fileText = (f: string) => readFileSync(f, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");

const COMMON = { org: { type: "string" }, project: { type: "string" }, team: { type: "string" }, id: { type: "string" }, json: { type: "boolean" }, refresh: { type: "boolean" } } as const;

/** Runs one call: the answer as text or JSON; a failure as `{"error":...}` too when --json. */
async function answer(ctx: Ctx, json: boolean, work: () => Promise<{ data: unknown; text: string }>): Promise<void> {
  try {
    const r = await work();
    ctx.out(json ? JSON.stringify(r.data) : r.text);
  } catch (e) {
    if (json) {
      const k = (e as { kind?: string })?.kind;
      ctx.out(JSON.stringify(k === "criteriaNotProven" ? { error: { kind: k, message: String((e as Error).message) } } : errorJson(e)));
    }
    throw e instanceof AihubError ? e : new AihubError((e as Error).message);
  }
}

async function stories(ctx: Ctx, v: V) {
  const core = await import("../lib/stories/core.js");
  const s = core.storiesOf(ctx, { org: str(v, "org"), project: str(v, "project"), team: str(v, "team"), refresh: !!v.refresh });
  // with an id: the item's own project (its link, area, iteration, template), never the saved or default project
  const id = str(v, "id");
  return id && /^(AB#)?\d+$/i.test(id) ? core.storiesForItem(ctx, s, Number(id.replace(/^AB#/i, ""))) : s;
}

export async function runPrompt(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  if (!["render", "list", "save", "reset"].includes(sub ?? "")) throw new AihubError(PROMPT_USAGE);
  const p = parse(rest, { ...COMMON, "text-file": { type: "string" }, option: { type: "string" } }, true);
  const v = p.values as V;
  const json = !!v.json;
  await answer(ctx, json, async () => {
    const pr = await import("../lib/e2e/prompts.js");
    const s = await stories(ctx, v);
    if (sub === "list") {
      const l = pr.listPrompts(ctx, s);
      return { data: l, text: l.prompts.map((x) => `${x.slash.padEnd(20)} ${x.title} (${x.source})`).join("\n") };
    }
    const action = pr.checkAction(p.positionals[0]);
    const id = idOf(v);
    if (sub === "save") return { data: { action, id, ...pr.savePrompt(s, id, action, fileText(need(v, "text-file"))) }, text: `prompt ${action} for ${id} saved` };
    if (sub === "reset") return { data: { action, id, ...pr.resetPrompt(s, id, action) }, text: `prompt ${action} for ${id} back to the team version` };
    const given = Object.fromEntries(String(v.option ?? "").split(",").map((x) => x.trim()).filter(Boolean).map((x) => (x.includes("=") ? x.split("=", 2) : [x, "true"])));
    const r = await pr.renderPrompt(ctx, s, action, id, given);
    return { data: r, text: r.text };
  });
}

export async function runCriteria(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  if (!["show", "status", "record", "proposal-file", "proposal", "apply"].includes(sub ?? "")) throw new AihubError(CRITERIA_USAGE);
  const v = parse(rest, { ...COMMON, criterion: { type: "string" }, result: { type: "string" }, evidence: { type: "string" }, reason: { type: "string" }, rev: { type: "string" }, take: { type: "string" } }).values as V;
  const json = !!v.json;
  await answer(ctx, json, async () => {
    const w = await import("../lib/e2e/workitem.js");
    const s = await stories(ctx, v);
    const id = idOf(v);
    if (sub === "show") {
      const c = await w.readCriteria(s, id);
      return { data: c, text: c.criteria.length ? c.markdown : `story ${id} has no acceptance criteria yet (/story-criteria ${id})` };
    }
    if (sub === "proposal-file") {
      await w.readCriteria(s, id); // refuses a bug
      const f = w.proposalFileFor(s, id);
      return { data: { id, proposalFile: f }, text: f };
    }
    if (sub === "proposal") {
      const p = await w.criteriaProposal(s, id);
      return { data: p, text: p.rows.map((r) => `${r.n}. ${r.proposed}${r.vague ? `  [${r.vague}]` : ""}`).join("\n") };
    }
    if (sub === "apply") {
      const take = (need(v, "take").split(",").map((x) => num(x.trim(), "--take")) as number[]).filter(Boolean);
      const r = await w.criteriaApply(s, { id, rev: num(need(v, "rev"), "--rev")!, take });
      return { data: r, text: r.status === "saved" ? `criteria of ${id} saved (rev ${r.rev})` : `conflict: ${id} was changed by someone else (rev ${r.rev}); nothing written` };
    }
    const st =
      sub === "record"
        ? await w.criteriaRecord(ctx, s, { id, criterion: num(need(v, "criterion"), "--criterion")!, result: need(v, "result") as never, evidence: str(v, "evidence"), reason: str(v, "reason") })
        : await w.criteriaStatus(ctx, s, id);
    const word = { pass: "passed", fail: "failed", notrun: "not run yet" } as const;
    const text = [`story ${id}: ${st.proven}/${st.total} proven`, ...st.criteria.map((c) => `${c.n}. [${word[c.result]}] ${c.text}${c.evidence ? ` -> ${c.evidence}` : ""}${c.reason ? ` (${c.reason})` : ""}`)].join("\n");
    return { data: st, text };
  });
}

/** aihub story progress --id N [--step k --total n --label t] [--steps a|b|c] [--done] | aihub story yolo --on|--off [--folder F] */
export async function runStoryE2e(argv: string[], ctx: Ctx): Promise<void> {
  const [sub, ...rest] = argv;
  const v = parse(rest, { ...COMMON, step: { type: "string" }, total: { type: "string" }, label: { type: "string" }, steps: { type: "string" }, done: { type: "boolean" }, stop: { type: "boolean" }, options: { type: "string" }, action: { type: "string" }, waiting: { type: "string" }, "plan-file": { type: "string" }, resume: { type: "boolean" }, on: { type: "boolean" }, off: { type: "boolean" }, folder: { type: "string" } }).values as V;
  const json = !!v.json;
  await answer(ctx, json, async () => {
    const run = await import("../lib/e2e/run.js");
    if (sub === "plan-file") {
      // the plan of a run goes next to the proposals: a folder opencode may write to without asking
      const { mkdirSync } = await import("node:fs");
      const { dirname } = await import("node:path");
      const { criteriaProposalFile } = await import("../lib/e2e/workitem.js");
      const s = await stories(ctx, v);
      const f = criteriaProposalFile(s, idOf(v)).replace(/-criteria\.md$/, "-plan.md");
      mkdirSync(dirname(f), { recursive: true });
      return { data: { id: idOf(v), planFile: f }, text: f };
    }
    if (sub === "yolo") {
      if (!v.on === !v.off) throw new BrowseError("badInput", "pass --on or --off");
      const r = run.yolo(ctx, { on: !!v.on, folder: str(v, "folder") });
      return { data: r, text: r.note ?? `YOLO ${r.yolo ? "on" : "off"} in ${r.folder}` };
    }
    const r = run.progress(ctx, {
      id: idOf(v),
      step: num(str(v, "step"), "--step"),
      total: num(str(v, "total"), "--total"),
      label: str(v, "label"),
      steps: str(v, "steps")?.split("|").map((x) => x.trim()).filter(Boolean),
      done: !!v.done,
      stop: !!v.stop,
      waiting: str(v, "waiting"),
      planFile: str(v, "plan-file"),
      resume: !!v.resume,
      action: str(v, "action"),
      options: str(v, "options") ? Object.fromEntries(str(v, "options")!.split(",").map((x) => x.trim()).filter(Boolean).map((x) => (x.includes("=") ? [x.split("=")[0], /^(true|yes|1)$/i.test(x.split("=")[1])] : [x, true]))) : undefined,
    });
    const data = { ...r, stepsView: run.stepsView(r) };
    const waits = r.waiting ? ` (waits for ${r.waitingFor}${r.planFile ? `: ${r.planFile}` : ""})` : "";
    return { data, text: r.running ? `story ${r.id}: step ${r.step}/${r.total} ${r.label}${waits}` : `story ${r.id}: ${r.stopped ? "stopped" : r.step ? `done (${r.total} steps)` : "no run"}` };
  });
}
