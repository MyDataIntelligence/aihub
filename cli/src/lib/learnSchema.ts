import type { ChangeFacts } from "./learn.js";

/**
 * The explanation a lesson is written as: the 1:1 port of the old EXPLANATION.json (kind "change-explanation") without
 * the try-it code, plus a list of named diagrams. The skill writes it, the extension renders it, this file checks it.
 */
export const DIAGRAM_KINDS = ["before-after", "flow", "architecture", "lineage", "sequence"] as const;
const MERMAID_START = /^\s*(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph)\b/;
const SEVERITIES = ["blocker", "major", "minor", "info"];
const MAX_MERMAID = 4000;

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const isStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A cheap Mermaid check: a known diagram type, balanced brackets, not too big. The view renders the real thing. */
export function mermaidProblem(src: unknown): string | undefined {
  if (!isStr(src)) return "is empty";
  if (src.length > MAX_MERMAID) return `is longer than ${MAX_MERMAID} characters`;
  if (!MERMAID_START.test(src)) return "does not start with a Mermaid diagram type (flowchart LR, sequenceDiagram, erDiagram, ...)";
  const pairs: [string, string][] = [["[", "]"], ["(", ")"], ["{", "}"]];
  for (const [o, c] of pairs) {
    if (src.split(o).length !== src.split(c).length) return `has unbalanced ${o}${c}`;
  }
  if (src.includes("```")) return "must not contain code fences";
  return undefined;
}

export function validateExplanation(json: unknown, facts?: ChangeFacts): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const e = (m: string) => errors.push(m);
  if (!isObj(json)) return { ok: false, errors: ["the explanation must be a JSON object"], warnings };
  const j = json;
  if (j.kind !== "change-explanation") e('kind must be "change-explanation"');
  for (const k of ["oneSentence", "before", "after"]) if (!isStr(j[k])) e(`${k} is required (a sentence)`);
  if (isStr(j.oneSentence) && j.oneSentence.length > 240) warnings.push("oneSentence is long; one sentence of at most about 200 characters reads best");

  const diagrams: { where: string; src: unknown }[] = [];
  if (j.diagram === undefined) e("diagram { before, after } is required: the picture of how it worked and how it works now");
  else if (!isObj(j.diagram)) e("diagram must be { before, after } with Mermaid text");
  else for (const k of ["before", "after"]) diagrams.push({ where: `diagram.${k}`, src: j.diagram[k] });
  if (j.diagrams !== undefined) {
    if (!Array.isArray(j.diagrams)) e("diagrams must be a list of { title, kind, mermaid }");
    else
      j.diagrams.forEach((d: unknown, i: number) => {
        if (!isObj(d) || !isStr(d.title)) return e(`diagrams[${i}].title is required`);
        if (!DIAGRAM_KINDS.includes(d.kind as (typeof DIAGRAM_KINDS)[number])) e(`diagrams[${i}].kind must be one of ${DIAGRAM_KINDS.join(", ")}`);
        for (const k of ["idiagramUrl", "playUrl"]) if (d[k] !== undefined && !(typeof d[k] === "string" && /^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)/.test(d[k] as string))) e(`diagrams[${i}].${k} must be an https link`);
        diagrams.push({ where: `diagrams[${i}].mermaid`, src: d.mermaid });
      });
  }
  for (const d of diagrams) {
    const p = mermaidProblem(d.src);
    if (p) e(`${d.where} ${p}`);
  }

  const list = (key: string, min: number, check: (x: unknown, i: number) => void, required = true) => {
    const v = j[key];
    if (v === undefined) return required ? e(`${key} is required`) : undefined;
    if (!Array.isArray(v) || v.length < min) return e(`${key} must be a list of at least ${min}`);
    v.forEach(check);
  };
  list("designChoices", 1, (c, i) => {
    if (!isObj(c) || !isStr(c.choice)) return e(`designChoices[${i}].choice is required`);
    if (!Array.isArray(c.alternatives) || !c.alternatives.length) return e(`designChoices[${i}].alternatives needs at least one { option, whyNot }`);
    c.alternatives.forEach((a: unknown, k: number) => {
      if (!isObj(a) || !isStr(a.option) || !isStr(a.whyNot)) e(`designChoices[${i}].alternatives[${k}] needs option and whyNot`);
    });
  });
  list("tellAColleague", 2, (s, i) => !isStr(s) && e(`tellAColleague[${i}] must be a sentence`));
  list("risks", 0, (s, i) => !isStr(s) && e(`risks[${i}] must be a sentence`), false);
  list(
    "quiz",
    1,
    (q, i) => {
      if (!isObj(q) || !isStr(q.question) || !isStr(q.explanation)) return e(`quiz[${i}] needs question and explanation`);
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 5 || !q.options.every(isStr)) return e(`quiz[${i}].options must be 2 to 5 texts`);
      if (!Number.isInteger(q.answerIndex) || (q.answerIndex as number) < 0 || (q.answerIndex as number) >= q.options.length) e(`quiz[${i}].answerIndex must point at one of the options`);
    },
    false,
  );
  list(
    "concepts",
    0,
    (c, i) => {
      if (!isObj(c) || !isStr(c.name) || !isStr(c.eli5) || !isStr(c.exampleFromThisChange)) e(`concepts[${i}] needs name, eli5 and exampleFromThisChange`);
    },
    false,
  );
  list("hunkReasons", 1, (h, i) => {
    if (!isObj(h) || !isStr(h.path) || !isStr(h.reason)) return e(`hunkReasons[${i}] needs path and reason`);
    if (!Number.isInteger(h.line) || (h.line as number) < 0) e(`hunkReasons[${i}].line must be a whole number (0 when no line is meant)`);
    if (Array.isArray(h.findings))
      h.findings.forEach((f: unknown, k: number) => {
        if (!isObj(f) || !SEVERITIES.includes(String(f.severity)) || !isStr(f.text)) e(`hunkReasons[${i}].findings[${k}] needs severity (${SEVERITIES.join("/")}) and text`);
      });
    if (facts && Array.isArray(facts.files) && !facts.files.some((f) => f.path === h.path || `/${f.path}` === h.path)) warnings.push(`hunkReasons[${i}].path ${String(h.path)} is not a changed file in the facts`);
  });
  if (j.tryIt !== undefined) warnings.push("tryIt is ignored: Learn does not run code");
  return { ok: errors.length === 0, errors, warnings };
}
