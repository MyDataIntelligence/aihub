import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BrowseError } from "../browse/core.js";
import { configHome } from "../configHome.js";
import type { Ctx } from "../context.js";
import { fieldsToSections, htmlToMd } from "../story.js";
import { F, type Stories } from "../stories/core.js";
import { partOf, templateOf } from "../stories/template.js";
import { storyEdit, type Conflict, type Saved } from "../stories/write.js";
import { criterionKey, parseCriteria, renderCriteria, vagueness, type Criterion, type Lang } from "./criteria.js";
import { readState, stateFile, writeState, type CriteriaState, type Result } from "./state.js";

export const isBug = (type: string) => /^bug$/i.test(type.trim());

export const langOf = (s: Pick<Stories, "teamCfg">): Lang => (String((s.teamCfg as { language?: string }).language ?? "nl").toLowerCase().startsWith("en") ? "en" : "nl");

export interface ItemCriteria {
  id: number;
  rev: number;
  type: string;
  title: string;
  /** the template heading the criteria live under ("Acceptance criteria"), or the field when the template has no heading for them */
  heading: string;
  field: string;
  markdown: string;
  criteria: Criterion[];
}

/** The criteria of a work item: the template section whose heading is the criteria, else the type's criteria field. */
export async function readCriteria(s: Stories, id: number): Promise<ItemCriteria> {
  const w = await s.c.get<{ id: number; rev: number; fields: Record<string, any> }>(`wit/workitems/${id}`);
  const type = String(w.fields[F.type] ?? "");
  // a bug has no acceptance criteria: it is proven by its Repro Steps (Reproduce, Fix End to End)
  if (isBug(type)) throw new BrowseError("badInput", `${id} is a ${type}: bugs have no acceptance criteria; use Reproduce or Fix End to End`);
  const tpl = await templateOf(s, type);
  const secs = fieldsToSections(s.teamCfg, w.fields, tpl.headings, tpl.layout);
  const sec = secs.find((x) => partOf(x.heading) === "criteria");
  const markdown = sec ? sec.body : tpl.layout.acceptance !== tpl.layout.primary ? htmlToMd(String(w.fields[tpl.layout.acceptance] ?? "")) : "";
  return { id, rev: Number(w.rev), type, title: String(w.fields[F.title] ?? ""), // without a section the criteria go to the type's criteria field, which the heading "Acceptance criteria" maps to
    heading: sec?.heading ?? "Acceptance criteria", field: tpl.layout.acceptance, markdown, criteria: parseCriteria(markdown) };
}

/** Writes the criteria (with their how-tested and proof lines) into the criteria field, with the revision test. */
export async function writeCriteria(s: Stories, id: number, rev: number, list: Pick<Criterion, "text" | "how" | "proof">[]): Promise<Saved | Conflict> {
  const cur = await readCriteria(s, id);
  return storyEdit(s, { id, rev, sections: `## ${cur.heading}\n\n${renderCriteria(list, langOf(s))}\n` });
}

// ---- the proposal of /story-criteria ---------------------------------------------------------------------------------

const safe = (x: string) => x.replace(/[^A-Za-z0-9._-]+/g, "-");
export const criteriaProposalFile = (s: Stories, id: number) => join(configHome(s.b.env), "stories", "proposals", `${safe(s.b.org)}-${safe(s.project)}-${id}-criteria.md`);

export interface ProposalRow {
  n: number;
  current?: string;
  proposed: string;
  how?: string;
  proof?: string;
  /** why the proposed criterion is not testable yet (then it is not ticked by default) */
  vague?: string;
  isNew: boolean;
  changed: boolean;
}

export function proposalFileFor(s: Stories, id: number): string {
  const f = criteriaProposalFile(s, id);
  mkdirSync(dirname(f), { recursive: true });
  return f;
}

/** The proposal next to the current criteria: a proposed criterion replaces the current one with the same number. */
export async function criteriaProposal(s: Stories, id: number): Promise<{ id: number; rev: number; proposalFile: string; rows: ProposalRow[] }> {
  const file = criteriaProposalFile(s, id);
  if (!existsSync(file)) throw new BrowseError("notFound", `no criteria proposal yet for ${id}: run /story-criteria ${id} in opencode first`);
  const cur = await readCriteria(s, id);
  const proposed = parseCriteria(readFileSync(file, "utf8"));
  const lang = langOf(s);
  const rows: ProposalRow[] = proposed.map((p, i) => {
    const old = cur.criteria[i];
    return {
      n: i + 1,
      ...(old ? { current: old.text } : {}),
      proposed: p.text,
      ...(p.how ? { how: p.how } : {}),
      ...(p.proof ? { proof: p.proof } : {}),
      ...(vagueness(p, lang) ? { vague: vagueness(p, lang) } : {}),
      isNew: !old,
      changed: !old || old.text !== p.text || old.how !== p.how || old.proof !== p.proof,
    };
  });
  return { id, rev: cur.rev, proposalFile: file, rows };
}

/** Writes the ticked rows of the proposal; the current criteria that were not ticked stay as they are. */
export async function criteriaApply(s: Stories, o: { id: number; rev: number; take: number[] }): Promise<(Saved & { criteria: number }) | Conflict> {
  if (!o.take.length) throw new BrowseError("badInput", "--take names the proposed criteria to apply (1,2,3)");
  const p = await criteriaProposal(s, o.id);
  const cur = await readCriteria(s, o.id);
  const proposed = parseCriteria(readFileSync(p.proposalFile, "utf8"));
  const out: Pick<Criterion, "text" | "how" | "proof">[] = [];
  const n = Math.max(proposed.length, cur.criteria.length);
  for (let i = 0; i < n; i++) {
    if (o.take.includes(i + 1) && proposed[i]) out.push(proposed[i]);
    else if (cur.criteria[i]) out.push(cur.criteria[i]);
  }
  const r = await writeCriteria(s, o.id, o.rev, out);
  return r.status === "saved" ? { ...r, criteria: out.length } : r;
}

// ---- test status -----------------------------------------------------------------------------------------------------

export interface CriterionStatus extends Criterion {
  result: Result;
  evidence?: string;
  reason?: string;
  at?: string;
}

export interface CriteriaStatus {
  id: number;
  total: number;
  proven: number;
  criteria: CriterionStatus[];
  stateFile: string;
}

export function statusOf(file: string, id: number, criteria: Criterion[]): CriteriaStatus {
  const st = readState<CriteriaState>(file, { schema: 1, id, records: {} });
  const list: CriterionStatus[] = criteria.map((c) => {
    const r = st.records[criterionKey(c.text)];
    return { ...c, result: r?.result ?? "notrun", ...(r?.evidence ? { evidence: r.evidence } : {}), ...(r?.reason ? { reason: r.reason } : {}), ...(r?.at ? { at: r.at } : {}) };
  });
  return { id, total: list.length, proven: list.filter((x) => x.result === "pass").length, criteria: list, stateFile: file };
}

export async function criteriaStatus(ctx: Ctx, s: Stories, id: number): Promise<CriteriaStatus> {
  const cur = await readCriteria(s, id);
  return statusOf(stateFile(ctx, id, "criteria"), id, cur.criteria);
}

export async function criteriaRecord(ctx: Ctx, s: Stories, o: { id: number; criterion: number; result: Result; evidence?: string; reason?: string }): Promise<CriteriaStatus> {
  if (!["pass", "fail", "notrun"].includes(o.result)) throw new BrowseError("badInput", "--result is pass, fail or notrun");
  if (o.result === "pass" && !o.evidence?.trim()) throw new BrowseError("badInput", "a passed criterion needs --evidence (a run link, a query and its outcome, a test name)");
  if (o.result === "fail" && !o.reason?.trim()) throw new BrowseError("badInput", "a failed criterion needs --reason");
  const cur = await readCriteria(s, o.id);
  const c = cur.criteria[o.criterion - 1];
  if (!c) throw new BrowseError("badInput", `story ${o.id} has ${cur.criteria.length} criteria; there is no criterion ${o.criterion}`);
  const file = stateFile(ctx, o.id, "criteria");
  const st = readState<CriteriaState>(file, { schema: 1, id: o.id, records: {} });
  st.records[criterionKey(c.text)] = { n: c.n, text: c.text, result: o.result, ...(o.evidence ? { evidence: o.evidence.trim() } : {}), ...(o.reason ? { reason: o.reason.trim() } : {}), at: new Date((ctx.now ?? Date.now)()).toISOString() };
  writeState(file, st);
  return statusOf(file, o.id, cur.criteria);
}
