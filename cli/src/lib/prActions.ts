import { AihubError } from "./errors.js";
import { headingsMatch, parseSections } from "./templates.js";

/** Exit code of a refused description: a section for the reader's actions is vague. Fix the text, or pass --as-is. */
export const VAGUE_ACTIONS_EXIT = 4;

export class VagueActionsError extends AihubError {
  readonly exitCode = VAGUE_ACTIONS_EXIT;
  constructor(
    message: string,
    readonly headings: string[],
  ) {
    super(message);
    this.name = "VagueActionsError";
  }
}

/** Headings (nl and en) of sections that tell the reader what to do themselves after the merge. Deliberately small: "Risks" or "Changes" never match. */
const ACTION_HEADING = [
  /\b(required|user|manual|post[- ]?merge|post[- ]?deploy|follow[- ]?up)\s+(user\s+)?(actions?|steps?)\b/i,
  /\bactions?\s+(required|needed)\b/i,
  /\b(after|post)[- ](the\s+)?(merge|deploy(ment)?|release)\b/i,
  /\bmigrations?\b/i,
  /\bbreaking\s+changes?\b/i,
  /^acties?$/i,
  /\b(vereiste|verplichte|handmatige|gebruikers?)\s*(acties?|stappen)\b/i,
  /\bacties?\s+(voor|van|nodig|vereist)\b/i,
  /\b(na|te doen na)\s+(de\s+)?(merge|release|deploy)\b/i,
  /\bmigratie\b/i,
  /\b(brekende|breaking)\s+wijzigingen\b/i,
];

export function isActionHeading(heading: string, configured: string[] = []): boolean {
  const h = heading.replace(/\(.*?\)/g, " ").trim();
  return configured.some((c) => headingsMatch(c, heading)) || ACTION_HEADING.some((re) => re.test(h));
}

/** Words that tell the reader to work it out themselves. */
const VAGUE_VERB =
  /\b(compare|review|migrate|ensure|make sure|verify that|check (whether|if|that)|update accordingly|adjust as needed|as needed|where needed|vergelijk|controleer of|migreer|zorg (er )?dat|pas (dit )?aan waar nodig|waar nodig)\b/i;

/** A file path or pattern, a file name with an extension, a `field`, an old -> new pair, or a code block. */
const CONCRETE = [
  /`[^`\n]+`/,
  /(^|[\s(])[\w.-]+\/[\w.*/-]+/,
  /\b[\w-]+\.(ya?ml|json|sql|py|ts|js|md|csv|toml|ps1|sh|cfg|ini|env|xml|tf|ipynb)\b/i,
  /(->|=>|→)/,
  /```/,
];

/** The "nothing to do" answers: the team's empty text, or the usual ones. */
export function isNothing(text: string, emptyText?: string): boolean {
  const t = text.trim().replace(/[.!\s]+$/, "").toLowerCase();
  if (!t) return true;
  const known = ["n.v.t", "n/a", "na", "none", "nothing", "-", "geen", "niet van toepassing", "not applicable", "nothing to do", "niets"];
  return known.includes(t) || (!!emptyText && t === emptyText.trim().replace(/[.!\s]+$/, "").toLowerCase());
}

const stripComments = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "").trim();

/** True when the section text leaves the reader to find out what to do. */
export function isVagueActions(body: string, emptyText?: string): boolean {
  const text = stripComments(body);
  if (isNothing(text, emptyText)) return false;
  if (CONCRETE.some((re) => re.test(text))) return false;
  const isList = /^\s*([-*+]|\d+[.)]|\|)\s+\S/m.test(text);
  return VAGUE_VERB.test(text) || (!isList && text.length >= 60);
}

export interface ActionCheckInput {
  description: string;
  /** Only these sections are checked (an update checks what it touched); default: all. */
  only?: string[];
  configured?: string[];
  emptyText?: string;
  /** Template text: the comment under an action heading is repeated in the refusal. */
  template?: string;
  verb: "created" | "updated";
}

/** Throws a VagueActionsError (short, around 400 bytes) when an action section is vague. */
export function checkActionSections(i: ActionCheckInput): void {
  const bad = parseSections(i.description)
    .sections.filter((s) => isActionHeading(s.heading, i.configured) && (!i.only || i.only.some((o) => headingsMatch(o, s.heading))))
    .filter((s) => isVagueActions(s.body, i.emptyText))
    .map((s) => s.heading);
  if (!bad.length) return;
  const names = bad.map((h) => `"${h}"`).join(", ");
  const comment = i.template ? templateHint(i.template, bad[0]) : "";
  throw new VagueActionsError(
    `PR not ${i.verb}: ${names} is vague (no file, field or old -> new). List per action: the files (names or pattern), the field old -> new or the new required field with an example, and how to check it; or write the empty text.${comment} Only when the user says so: --as-is`,
    bad,
  );
}

function templateHint(template: string, heading: string): string {
  const sec = parseSections(template).sections.find((s) => headingsMatch(s.heading, heading));
  const m = sec && /<!--([\s\S]*?)-->/.exec(sec.body);
  const t = m?.[1].replace(/\s+/g, " ").trim();
  return t ? ` Template says: ${t.length > 90 ? t.slice(0, 87) + "..." : t}` : "";
}
