import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { aihubDir, ensureDir } from "./aihubDir.js";
import { currentBranch, repoRoot } from "./git.js";
import { headingsMatch, parseSections, renderSections } from "./templates.js";
import { readUtf8 } from "./team.js";

const MARK = /^<!-- aihub-note (\S+) -->$/;

export function notesFile(root: string, branch: string): string {
  if (branch.split("/").some((p) => p === ".." || p === "")) throw new AihubError(`branch '${branch}' cannot hold notes`);
  return aihubDir(root, "notes", `${branch}.md`);
}

export interface Note {
  at: string;
  text: string;
}

export function readNotes(root: string, branch: string): Note[] {
  const f = notesFile(root, branch);
  if (!existsSync(f)) return [];
  const notes: Note[] = [];
  let cur: { at: string; lines: string[] } | undefined;
  const flush = () => {
    if (cur && cur.lines.join("\n").trim()) notes.push({ at: cur.at, text: cur.lines.join("\n").trim() });
  };
  for (const l of readFileSync(f, "utf8").replace(/\r\n/g, "\n").split("\n")) {
    const m = MARK.exec(l);
    if (m) {
      flush();
      cur = { at: m[1], lines: [] };
    } else cur?.lines.push(l);
  }
  flush();
  return notes;
}

export function addNote(ctx: Ctx, o: { text?: string; file?: string; json?: boolean }): string {
  const root = repoRoot(ctx.cwd);
  const branch = currentBranch(root);
  const text = (o.file ? readUtf8(o.file) : (o.text ?? "")).trim();
  if (!text) throw new AihubError('aihub note add needs text: aihub note add "text" or --file <file>');
  const f = notesFile(root, branch);
  ensureDir(dirname(f));
  const at = new Date((ctx.now ?? Date.now)()).toISOString();
  appendFileSync(f, `<!-- aihub-note ${at} -->\n${text}\n\n`, "utf8");
  const n = readNotes(root, branch).length;
  return o.json ? JSON.stringify({ branch, notes: n }) : `note saved for ${branch} (${n} in total, never committed)`;
}

export function listNotes(ctx: Ctx, o: { json?: boolean }): string {
  const root = repoRoot(ctx.cwd);
  const branch = currentBranch(root);
  const notes = readNotes(root, branch);
  if (o.json) return JSON.stringify({ branch, notes });
  if (!notes.length) return `${branch}: no notes`;
  return [`${branch}: ${notes.length} note(s)`, ...notes.map((n, i) => `${i + 1}. ${n.text.replace(/\n+/g, " / ")}`)].join("\n");
}

/** Headings that carry the why of a change; notes are woven into the first one that exists. */
export const CONTEXT_RE = /context|waarom|\bwhy\b|aanleiding|achtergrond|background|reden|motivat|probleem|problem/i;

export const notesText = (notes: Note[]): string => notes.map((n) => n.text).join("\n\n");

/**
 * Weaves private notes into a PR body as plain prose of the context section (never labelled as notes).
 * `headings`: the section headings of the template or of the current description.
 */
export function weaveNotes(body: string, headings: string[], notes: Note[]): string {
  const text = notesText(notes);
  if (!text) return body;
  const target = headings.find((h) => CONTEXT_RE.test(h));
  if (!target) return body.trim() ? `${text}\n\n${body.trim()}\n` : `${text}\n`;
  const parsed = parseSections(body);
  if (!parsed.sections.length) return `## ${target}\n\n${[body.trim(), text].filter(Boolean).join("\n\n")}\n`;
  const hit = parsed.sections.find((s) => headingsMatch(s.heading, target));
  if (hit) hit.body = [hit.body.trim(), text].filter(Boolean).join("\n\n");
  else parsed.sections.push({ heading: target, body: text });
  return (parsed.preamble ? `${parsed.preamble}\n\n` : "") + renderSections(parsed.sections);
}

/** Notes already present in a description are not added twice (idempotent update). */
export const unwovenNotes = (description: string, notes: Note[]): Note[] => notes.filter((n) => !description.includes(n.text));
