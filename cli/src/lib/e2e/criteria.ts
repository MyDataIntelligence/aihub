import { createHash } from "node:crypto";

/**
 * Acceptance criteria as the team and the agent read them: one numbered criterion with two lines under it, "how tested"
 * and "proof". Kept in the criteria field of the work item as readable text (no hidden markup):
 *
 *   1. Een export zonder orders levert een bestand met alleen de kopregel.
 *      Hoe getest: Unit-test: test_export_zonder_orders in repo-a
 *      Bewijs: Testnaam en een groen resultaat in de pipeline
 *
 * Plain bullets (`- [ ] ...`) without the two lines are read as criteria too (then without how/proof).
 */

export interface Criterion {
  n: number;
  text: string;
  how?: string;
  proof?: string;
}

export type Lang = "nl" | "en";

const LABELS = { nl: { how: "Hoe getest", proof: "Bewijs" }, en: { how: "How tested", proof: "Proof" } } as const;
const HOW_RE = /^(?:hoe getest|how tested|test(?:ed)?)\s*:\s*(.*)$/i;
const PROOF_RE = /^(?:bewijs|proof|evidence)\s*:\s*(.*)$/i;
const ITEM_RE = /^(?:\d+[.)]|[-*])\s+(?:\[[ xX]\]\s*)?(.+)$/;

/** Criteria from the markdown of the criteria field (or section). */
export function parseCriteria(md: string): Criterion[] {
  const out: Criterion[] = [];
  for (const raw of md.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim().replace(/^[-*]\s+(?=(?:hoe getest|how tested|bewijs|proof|evidence)\s*:)/i, "");
    if (!line) continue;
    const cur = out[out.length - 1];
    let m: RegExpExecArray | null;
    if (cur && (m = HOW_RE.exec(line))) cur.how = m[1].trim();
    else if (cur && (m = PROOF_RE.exec(line))) cur.proof = m[1].trim();
    else if ((m = ITEM_RE.exec(line))) out.push({ n: out.length + 1, text: m[1].trim() });
    else if (cur && !cur.how && !cur.proof && raw.startsWith(" ")) cur.text = `${cur.text} ${line}`; // a criterion over two lines
    else if (!cur || cur.how || cur.proof) out.push({ n: out.length + 1, text: line }); // a criterion written as a paragraph
    else cur.text = `${cur.text} ${line}`;
  }
  return out;
}

/** The readable text of the criteria field. */
export function renderCriteria(list: Pick<Criterion, "text" | "how" | "proof">[], lang: Lang = "nl"): string {
  const L = LABELS[lang];
  return list
    .map((c, i) => [`${i + 1}. ${c.text.trim()}`, c.how ? `   ${L.how}: ${c.how.trim()}` : "", c.proof ? `   ${L.proof}: ${c.proof.trim()}` : ""].filter(Boolean).join("\n"))
    .join("\n\n");
}

const VAGUE = /\b(snel|sneller|goed|beter|netjes|mooi|duidelijk|gebruiksvriendelijk|robuust|fast|faster|quick|good|better|nice|clean|user[- ]friendly|robust|properly|correctly|correct|works?)\b/i;

/** Why a criterion is not testable yet, or undefined. */
export function vagueness(c: Criterion, lang: Lang = "nl"): string | undefined {
  const w = VAGUE.exec(c.text)?.[1];
  if (w && !/\d/.test(c.text)) return lang === "nl" ? `wat is "${w}"?` : `what is "${w}"?`;
  if (!c.how) return lang === "nl" ? "Hoe getest ontbreekt" : "How tested is missing";
  if (!c.proof) return lang === "nl" ? "Bewijs ontbreekt" : "Proof is missing";
  return undefined;
}

/** The key of a criterion's text: a status belongs to this text, not to its number. */
export const criterionKey = (text: string) => createHash("sha1").update(text.toLowerCase().replace(/\s+/g, " ").trim()).digest("hex").slice(0, 12);

/** The kind of test of a "how tested" line: the words before the first colon (Data-check, Fabric-run, Unit-test, Handmatig). */
export const howKind = (how: string | undefined) => (how ? (/^([^:]{2,30}):/.exec(how)?.[1] ?? how).trim() : "");
