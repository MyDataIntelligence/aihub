import { existsSync } from "node:fs";
import { join } from "node:path";
import { readUtf8 } from "./team.js";

export const TEMPLATE_DIRS = [".azuredevops", ".vsts", "docs", ""];
export const DEFAULT_EMPTY = "n.v.t.";
export const MAX_DESCRIPTION = 4000;

export interface TemplateSource {
  /** Content of a file at origin/<target> (preferred), or undefined. */
  readRef?: (branch: string, path: string) => string | undefined;
  /** Working-tree root for the local fallback. */
  localRoot?: string;
}

export interface ResolvedTemplate {
  path: string;
  content: string;
  from: "ref" | "local";
}

/** Candidate paths in Azure DevOps order: branch-specific first, then the default template. */
export function templateCandidates(target: string): string[] {
  const join2 = (d: string, f: string) => (d ? `${d}/${f}` : f);
  const out: string[] = [];
  for (const d of TEMPLATE_DIRS) out.push(join2(d, `pull_request_template/branches/${target}.md`));
  for (const d of TEMPLATE_DIRS) out.push(join2(d, "pull_request_template.md"));
  return out;
}

export function resolveTemplate(target: string, src: TemplateSource): ResolvedTemplate | undefined {
  const cands = templateCandidates(target);
  if (src.readRef) {
    for (const p of cands) {
      const c = src.readRef(target, p);
      if (c !== undefined) return { path: p, content: c.replace(/\r\n/g, "\n"), from: "ref" };
    }
  }
  if (src.localRoot) {
    for (const p of cands) {
      const full = join(src.localRoot, p);
      if (existsSync(full)) return { path: p, content: readUtf8(full), from: "local" };
    }
  }
  return undefined;
}

// ---- sections --------------------------------------------------------------

export interface Section {
  heading: string;
  body: string;
}
export interface ParsedMarkdown {
  preamble: string;
  sections: Section[];
}

/** Split markdown at `## ` headings (outside code fences). */
export function parseSections(md: string): ParsedMarkdown {
  const lines = md.replace(/^﻿/, "").replace(/\r\n/g, "\n").split("\n");
  const sections: { heading: string; lines: string[] }[] = [];
  const pre: string[] = [];
  let fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = !fence ? /^##\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (m && !line.startsWith("###")) sections.push({ heading: m[1].trim(), lines: [] });
    else if (sections.length) sections[sections.length - 1].lines.push(line);
    else pre.push(line);
  }
  return {
    preamble: pre.join("\n").trim(),
    sections: sections.map((s) => ({ heading: s.heading, body: s.lines.join("\n").trim() })),
  };
}

export function renderSections(sections: Section[]): string {
  return sections.map((s) => `## ${s.heading}\n\n${s.body}`.trimEnd()).join("\n\n") + "\n";
}

const stripComments = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "").trim();

export function normHeading(h: string): string {
  return h
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

export function headingsMatch(a: string, b: string): boolean {
  const x = normHeading(a);
  const y = normHeading(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x));
}

export type CodeKind = "story" | "commits" | "linked";

export function codeKindOf(heading: string): CodeKind | undefined {
  const words = heading.trim().split(/\s+/).length;
  if (/(gerelateerde|gekoppelde|linked|related)\W+(pr|prs|pull)|(pr|prs|pull requests?)\W+(link|gerelateerd)/i.test(heading)) return "linked";
  if (/commit/i.test(heading)) return "commits";
  if (words <= 4 && /(story|work ?item|werk ?item|ticket|ab#)/i.test(heading)) return "story";
  // The bundled templates end with a bare "Related" / "Gerelateerd" section holding the story link.
  if (/^(related|gerelateerd|gekoppeld)$/i.test(heading.trim())) return "story";
  return undefined;
}

export interface CodeValues {
  story?: string;
  commits?: string;
  linked?: string;
}

export interface ComposeInput {
  template: string;
  /** Markdown with `##` sections written by the agent. */
  body: string;
  code: CodeValues;
  emptyText?: string;
  optionalSections?: string[];
}

export interface Composed {
  text: string;
  /** heading -> how it was filled */
  filled: { heading: string; by: "body" | "code" | "empty" | "extra" }[];
}

export function compose(input: ComposeInput): Composed {
  const empty = input.emptyText || DEFAULT_EMPTY;
  const tpl = parseSections(input.template).sections;
  const body = parseSections(input.body);
  const pool = body.sections.map((s) => ({ ...s, used: false }));
  const filled: Composed["filled"] = [];
  const out: Section[] = [];

  // A body without any `##` heading is free text: it goes to the first non-code section.
  const freeText = body.sections.length === 0 ? stripComments(input.body) : "";
  let freeUsed = false;

  const take = (heading: string): string | undefined => {
    const exact = pool.find((p) => !p.used && normHeading(p.heading) === normHeading(heading));
    const hit = exact ?? pool.find((p) => !p.used && headingsMatch(p.heading, heading));
    if (!hit) return undefined;
    hit.used = true;
    const t = stripComments(hit.body);
    return t || undefined;
  };

  for (const s of tpl) {
    const kind = codeKindOf(s.heading);
    const fromBody = take(s.heading);
    let text: string | undefined;
    let by: Composed["filled"][number]["by"] = "empty";
    const codeVal = kind ? input.code[kind] : undefined;
    if (codeVal) {
      text = codeVal;
      by = "code";
    } else if (fromBody) {
      text = fromBody;
      by = "body";
    } else if (freeText && !freeUsed && !kind) {
      text = freeText;
      freeUsed = true;
      by = "body";
    }
    out.push({ heading: s.heading, body: text ?? empty });
    filled.push({ heading: s.heading, by: text ? by : "empty" });
  }

  // Never lose prose: sections the template does not know are appended in order.
  for (const p of pool) {
    const t = stripComments(p.body);
    if (!p.used && t) {
      out.push({ heading: p.heading, body: t });
      filled.push({ heading: p.heading, by: "extra" });
    }
  }
  return { text: capLength(renderSections(out), input.code.commits), filled };
}

/** Azure DevOps caps descriptions at 4000 characters; shrink the commit list first. */
function capLength(text: string, commits?: string): string {
  if (text.length <= MAX_DESCRIPTION) return text;
  let t = text;
  if (commits) {
    const lines = commits.split("\n");
    while (t.length > MAX_DESCRIPTION && lines.length > 1) {
      const before = lines.join("\n");
      lines.pop();
      t = t.replace(before, lines.join("\n") + "\n- ...");
    }
  }
  return t.length > MAX_DESCRIPTION ? t.slice(0, MAX_DESCRIPTION - 4).trimEnd() + "\n..." : t;
}

/** Replace/append content of one section in an existing description; other sections stay intact. */
export function editSection(
  description: string,
  heading: string,
  change: { append?: string; replace?: string },
): string {
  const parsed = parseSections(description);
  const idx = parsed.sections.findIndex((s) => headingsMatch(s.heading, heading));
  if (idx < 0) {
    parsed.sections.push({ heading, body: (change.replace ?? change.append ?? "").trim() });
  } else {
    const cur = parsed.sections[idx];
    const curText = stripComments(cur.body);
    const placeholder = curText === "" || normHeading(curText) === normHeading(DEFAULT_EMPTY);
    cur.body =
      change.replace !== undefined
        ? change.replace.trim()
        : placeholder
          ? (change.append ?? "").trim()
          : `${cur.body}\n\n${(change.append ?? "").trim()}`;
  }
  const head = parsed.preamble ? `${parsed.preamble}\n\n` : "";
  return head + renderSections(parsed.sections);
}

/** Merge sections of `patch` into `description` (matching headings replace, new ones append). */
export function mergeSections(description: string, patch: string): string {
  const p = parseSections(patch);
  if (p.sections.length === 0) return patch.trim() + "\n";
  let out = description;
  const have = parseSections(description).sections;
  for (const s of p.sections) {
    // story link, commit list and related PRs belong to the CLI: a body written from the bare template must not wipe them
    if (codeKindOf(s.heading) && have.some((h) => headingsMatch(h.heading, s.heading))) continue;
    out = editSection(out, s.heading, { replace: s.body });
  }
  return out;
}
