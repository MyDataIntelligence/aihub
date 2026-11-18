import type { Ctx } from "./context.js";
import { repoClient } from "./context.js";
import { AihubError } from "./errors.js";
import { git } from "./git.js";
import { parseRunRef, pipelineLogs } from "./pipeline.js";
import { currentTeamFile, proposeTeamChange, type ProposalResult } from "./teamPropose.js";
import { loadTeam } from "./team.js";

/**
 * Fix memory: errors the team has fixed before, with the fix, in the team pack (`known-fixes.md`). `fix known` reads it
 * (the pipeline-fix skill asks it first), `fix remember` proposes a new entry as a pull request, never silently.
 */
export const KNOWN_FIXES = ".agents/skills/_shared/references/known-fixes.md";

const HEADER = (nl: boolean) =>
  nl
    ? "# Bekende fixes\n\nFouten die het team eerder oploste. Elke sectie: de foutregel (kop) en de oplossing. Voorgesteld met `aihub fix remember` via een pull request; `aihub fix known` zoekt hierin.\n"
    : "# Known fixes\n\nErrors the team has fixed before. Each section: the error line (heading) and the fix. Proposed with `aihub fix remember` through a pull request; `aihub fix known` searches here.\n";

export interface KnownFix {
  /** The error line as it was remembered. */
  error: string;
  fix: string;
  added?: string;
}

export function parseKnownFixes(text: string | undefined): KnownFix[] {
  if (!text) return [];
  const out: KnownFix[] = [];
  for (const block of text.replace(/\r\n/g, "\n").split(/^## /m).slice(1)) {
    const [head, ...rest] = block.split("\n");
    const lines = rest.map((l) => l.trimEnd());
    const added = lines.find((l) => /^Added:/i.test(l))?.replace(/^Added:\s*/i, "");
    const fix = lines.filter((l) => !/^Added:/i.test(l)).join("\n").replace(/^\s*(Fix|Oplossing):\s*/i, "").trim();
    if (head.trim() && fix) out.push({ error: head.trim().replace(/^`|`$/g, ""), fix, added });
  }
  return out;
}

/** What an error line looks like without what changes per run: numbers, ids, paths, quotes. */
export function normalizeError(s: string): string {
  return s
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(\.\d+)?z?/g, " ")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, " ")
    .replace(/\b[0-9a-f]{7,40}\b/g, " ")
    .replace(/(?:[a-z]:)?[\\/][^\s:'"]+/g, " ")
    .replace(/\d+/g, "#")
    .replace(/[^a-z#_ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface Match {
  fix: KnownFix;
  score: number;
}

/** An entry matches when its normalised error line is inside the text, or at least 80% of its words are. */
export function matchFixes(fixes: KnownFix[], text: string): Match[] {
  const hay = normalizeError(text);
  const words = new Set(hay.split(" "));
  const out: Match[] = [];
  for (const f of fixes) {
    const sig = normalizeError(f.error);
    if (!sig) continue;
    if (hay.includes(sig)) {
      out.push({ fix: f, score: 1 });
      continue;
    }
    const w = sig.split(" ").filter((x) => x.length > 1);
    if (w.length < 3) continue;
    const share = w.filter((x) => words.has(x)).length / w.length;
    if (share >= 0.8) out.push({ fix: f, score: Math.round(share * 100) / 100 });
  }
  return out.sort((a, b) => b.score - a.score);
}

export const renderEntry = (error: string, fix: string, who: string, date: string): string => `## ${error}\n\n${fix.trim()}\n\nAdded: ${date} by ${who}\n`;

export function withEntry(current: string | undefined, entry: { error: string; fix: string; who: string; date: string }, nl: boolean): string {
  const base = current && current.trim() ? current.replace(/\r\n/g, "\n").replace(/\n*$/, "\n") : HEADER(nl);
  const sig = normalizeError(entry.error);
  const exists = parseKnownFixes(base).find((f) => normalizeError(f.error) === sig);
  if (exists) {
    if (exists.fix.trim() === entry.fix.trim()) return base;
    // the same error with a better fix: replace that section
    const sections = base.split(/^(?=## )/m);
    return sections.map((s) => (s.startsWith("## ") && normalizeError(s.split("\n")[0].replace(/^## /, "")) === sig ? renderEntry(entry.error, entry.fix, entry.who, entry.date) + "\n" : s)).join("").replace(/\n{3,}/g, "\n\n");
  }
  return `${base}\n${renderEntry(entry.error, entry.fix, entry.who, entry.date)}`;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export async function fixKnown(ctx: Ctx, o: { run?: string; error?: string; json?: boolean }): Promise<string> {
  const { root } = repoClient(ctx);
  if (!o.run && !o.error) throw new AihubError("aihub fix known needs --run <id|link> or --error \"<text>\"");
  const text = o.error ?? (await pipelineLogs(ctx, { run: parseRunRef(o.run!), tail: 80 }));
  const fixes = parseKnownFixes(currentTeamFile(root, KNOWN_FIXES));
  const hits = matchFixes(fixes, text);
  if (o.json) return JSON.stringify({ file: KNOWN_FIXES, entries: fixes.length, matches: hits.map((h) => ({ error: h.fix.error, fix: h.fix.fix, score: h.score, added: h.fix.added })) });
  if (!fixes.length) return `no known fixes yet (${KNOWN_FIXES} does not exist or is empty)`;
  if (!hits.length) return `no known fix matches (${fixes.length} entries checked)`;
  return hits.slice(0, 3).map((h) => `known fix (${h.score === 1 ? "exact" : `${Math.round(h.score * 100)}% match`}): ${oneLine(h.fix.error)}\n${h.fix.fix}${h.fix.added ? `\n(added ${h.fix.added})` : ""}`).join("\n\n");
}

export async function fixRemember(ctx: Ctx, o: { error?: string; fix?: string; who?: string; json?: boolean }): Promise<string> {
  const { root } = repoClient(ctx);
  const error = oneLine(o.error ?? "");
  const fix = (o.fix ?? "").trim();
  if (!error || !fix) throw new AihubError('aihub fix remember needs --error "<the error line>" --fix "<what fixed it, 1-3 lines>"');
  if (fix.split("\n").length > 3) throw new AihubError("--fix is 1 to 3 lines: say what to do, not the whole story");
  const nl = loadTeam(root).language === "nl";
  const who = o.who || git(root, ["config", "user.name"], { allowFail: true }).trim() || "aihub";
  const date = new Date((ctx.now ?? Date.now)()).toISOString().slice(0, 10);
  const sig = normalizeError(error).replace(/ /g, "-").slice(0, 40) || "fix";
  const r: ProposalResult = await proposeTeamChange(ctx, {
    file: KNOWN_FIXES,
    change: (cur) => withEntry(cur, { error, fix, who, date }, nl),
    branch: `aihub/known-fix-${sig}`,
    title: nl ? `Bekende fix: ${error.slice(0, 60)}` : `Known fix: ${error.slice(0, 60)}`,
    commitMessage: `docs: known fix for "${error.slice(0, 60)}"`,
    summary: nl ? `Voorstel van \`aihub fix remember\`: de fout \`${error}\` en hoe hij is opgelost. Controleer of de oplossing algemeen genoeg is voor het team.` : `Proposal from \`aihub fix remember\`: the error \`${error}\` and how it was fixed. Check that the fix is general enough for the team.`,
  });
  if (o.json) return JSON.stringify(r);
  return r.changed ? `known fix proposed: ${r.pr}\n(nothing is stored until the pull request is merged)` : "this known fix is already in the team pack; nothing to propose";
}
