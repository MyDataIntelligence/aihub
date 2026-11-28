import type { AdoClient } from "../ado.js";
import type { Ctx } from "../context.js";
import { AihubError } from "../errors.js";
import { ACCEPTANCE_FIELD as ACCEPTANCE, DESCRIPTION } from "../fieldLayout.js";
import { htmlToMd } from "../story.js";
import { partOf } from "../stories/template.js";
import { headingsMatch, parseSections } from "../templates.js";
import { howKind, parseCriteria, type Lang } from "./criteria.js";
import { stateFile } from "./state.js";
import { statusOf, type CriteriaStatus } from "./workitem.js";

/**
 * The required section of a pull request: the acceptance criteria of its story with how each was tested, the outcome
 * and the link to the proof, or honestly "not run yet". Made by the CLI from the criteria and their recorded status
 * (the agent writes no outcome), and "N/M proven" on top. Not all proven: `pr create` stops with the choices.
 */

export const CRITERIA_NOT_PROVEN_EXIT = 5;

export class CriteriaNotProven extends AihubError {
  readonly exitCode = CRITERIA_NOT_PROVEN_EXIT;
  readonly kind = "criteriaNotProven";
  constructor(
    message: string,
    readonly proven: number,
    readonly total: number,
  ) {
    super(message);
  }
}

const W = {
  nl: { heading: "Acceptatiecriteria", crit: "Criterium", how: "Hoe getest", out: "Uitkomst", link: "Link", pass: "Geslaagd", fail: "Gefaald", notrun: "Nog niet uitgevoerd", proven: "bewezen" },
  en: { heading: "Acceptance criteria", crit: "Criterion", how: "How tested", out: "Outcome", link: "Link", pass: "Passed", fail: "Failed", notrun: "Not run yet", proven: "proven" },
} as const;

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
/** A short label for the proof: "run 812" for a build, "PR !5" for a pull request, else the last part of the address. */
function linkOf(e: string | undefined): string {
  const v = (e ?? "").trim();
  if (!v) return "—";
  if (!/^https?:\/\//i.test(v)) return cell(v);
  const label = /buildId=(\d+)/i.exec(v)?.[1] ? `run ${/buildId=(\d+)/i.exec(v)![1]}` : /pullrequest\/(\d+)/i.exec(v) ? `PR !${/pullrequest\/(\d+)/i.exec(v)![1]}` : (v.replace(/[?#].*$/, "").split("/").filter(Boolean).pop() ?? "link").slice(0, 30);
  return `[${label}](${v})`;
}

export function criteriaTable(st: CriteriaStatus, lang: Lang): string {
  const L = W[lang];
  const rows = st.criteria.map((c) => {
    const out = c.result === "pass" ? `${L.pass}${c.reason ? `: ${c.reason}` : ""}` : c.result === "fail" ? `${L.fail}: ${c.reason ?? ""}` : `${L.notrun}${c.reason ? `: ${c.reason}` : ""}`;
    return `| ${cell(c.text)} | ${cell(howKind(c.how) || "—")} | ${cell(out)} | ${c.result === "pass" ? linkOf(c.evidence) : "—"} |`;
  });
  return [`| ${L.crit} | ${L.how} | ${L.out} | ${L.link} |`, "|---|---|---|---|", ...rows].join("\n");
}

/** The line on top of the PR: "3/3 bewezen", or which criteria are not proven yet. */
export function provenLine(st: CriteriaStatus, lang: Lang): string {
  const L = W[lang];
  if (st.proven === st.total) return `**${st.proven}/${st.total} ${L.heading.toLowerCase()} ${L.proven}**`;
  const open = st.criteria.filter((c) => c.result !== "pass").map((c) => String(c.n));
  const n = st.total - st.proven;
  return lang === "nl"
    ? `> **Let op: ${n} ${n === 1 ? "criterium" : "criteria"} niet bewezen** (${st.proven}/${st.total} bewezen): ${n === 1 ? "criterium" : "criteria"} ${open.join(", ")}. Deze pull request blijft een concept tot dat bewezen is.`
    : `> **Note: ${n} ${n === 1 ? "criterion" : "criteria"} not proven** (${st.proven}/${st.total} proven): ${open.join(", ")}. This pull request stays a draft until that is proven.`;
}

/** Puts the line on top and the section after the first section (or replaces the section of the team template). */
export function withCriteria(description: string, st: CriteriaStatus, lang: Lang): string {
  const L = W[lang];
  const table = criteriaTable(st, lang);
  const parsed = parseSections(description);
  const has = parsed.sections.findIndex((s) => headingsMatch(s.heading, L.heading) || headingsMatch(s.heading, W.en.heading) || headingsMatch(s.heading, W.nl.heading));
  const sections = parsed.sections.map((s) => ({ ...s }));
  if (has >= 0) sections[has].body = table;
  else sections.splice(Math.min(1, sections.length), 0, { heading: L.heading, body: table });
  const pre = parsed.preamble.trim().replace(/^(\*\*\d+\/\d+ [^*]+\*\*|> \*\*(?:Let op|Note):[^\n]*)\s*/m, "").trim();
  return [provenLine(st, lang), pre, ...sections.map((s) => `## ${s.heading}\n\n${s.body.trim()}`)].filter(Boolean).join("\n\n") + "\n";
}

/**
 * The criteria and their status of the story of a PR; undefined when the story has none (then nothing changes). Cheap on
 * purpose (it runs in every `pr create` with a story): one read of the work item, no git process, no template lookup.
 */
export async function prCriteria(ctx: Ctx, client: AdoClient, story: number, language?: string): Promise<{ status: CriteriaStatus; lang: Lang } | undefined> {
  const w = await client.get<{ fields?: Record<string, unknown> }>(`wit/workitems/${story}`); // all fields: a type without the criteria field would refuse a named list
  if (/^bug$/i.test(String(w.fields?.["System.WorkItemType"] ?? "").trim())) return undefined; // bugs have no acceptance criteria
  const ac = htmlToMd(String(w.fields?.[ACCEPTANCE] ?? ""));
  const fromDesc = parseSections(htmlToMd(String(w.fields?.[DESCRIPTION] ?? ""))).sections.find((x) => partOf(x.heading) === "criteria")?.body ?? "";
  const criteria = parseCriteria(ac.trim() ? ac : fromDesc);
  if (!criteria.length) return undefined;
  const lang: Lang = String(language ?? "en").toLowerCase().startsWith("nl") ? "nl" : "en";
  return { status: statusOf(stateFile(ctx, story, "criteria"), story, criteria), lang };
}

export function notProvenError(st: CriteriaStatus, story: number, lang: Lang): CriteriaNotProven {
  const open = st.criteria.filter((c) => c.result !== "pass").map((c) => `${c.n}. ${c.text.replace(/[.\s]+$/, "")}${c.result === "fail" ? ` (${lang === "nl" ? "gefaald" : "failed"})` : ""}`);
  return new CriteriaNotProven(
    `${st.total - st.proven} of ${st.total} acceptance criteria of story ${story} are not proven: ${open.join("; ")}. Nothing was written. Choose: test first (/story-test-fabric ${story}), --draft (create as draft) or --anyway (create anyway).`,
    st.proven,
    st.total,
  );
}
