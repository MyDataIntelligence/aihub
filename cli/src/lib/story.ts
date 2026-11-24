import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AdoClient } from "./ado.js";
import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { compose, DEFAULT_EMPTY, headingsMatch, normHeading, parseSections, renderSections, type Section } from "./templates.js";
import { loadTeam, readUtf8, type TeamConfig } from "./team.js";

export const DEFAULT_STORY_TEMPLATE = `## Description
As a <role>, I want <goal>, so that <benefit>.

## Acceptance criteria
- [ ] <observable result 1>

## Technical notes
<constraints, affected components, open questions>

## Out of scope
<what this story deliberately does not do>
`;

const DESCRIPTION = "System.Description";
const DEFAULT_MAP: Record<string, string> = {
  description: DESCRIPTION,
  acceptancecriteria: "Microsoft.VSTS.Common.AcceptanceCriteria",
};

/** heading -> field. Unmapped headings live inside the Description field under their own `##` heading. */
export function fieldFor(team: TeamConfig, heading: string): string {
  for (const [h, f] of Object.entries(team.workItems?.sectionFields ?? {})) if (headingsMatch(h, heading)) return f;
  return DEFAULT_MAP[normHeading(heading)] ?? DESCRIPTION;
}

export function isPrimaryDescription(heading: string) {
  return normHeading(heading) === "description";
}

// ---- html <-> markdown ----------------------------------------------------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function mdToHtml(md: string): string {
  const out: string[] = [];
  let list = false;
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(esc).join("<br>")}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) out.push("</ul>");
    list = false;
  };
  for (const raw of md.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    let m: RegExpExecArray | null;
    if ((m = /^#{2,6}\s+(.*)$/.exec(line))) {
      flush();
      closeList();
      out.push(`<h2>${esc(m[1])}</h2>`);
    } else if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) {
      flush();
      if (!list) out.push("<ul>");
      list = true;
      out.push(`<li>${esc(m[1])}</li>`);
    } else if (line.trim() === "") {
      flush();
      closeList();
    } else {
      closeList();
      para.push(line);
    }
  }
  flush();
  closeList();
  return out.join("");
}

export function htmlToMd(html: string): string {
  return html
    .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, "\n\n## $1\n\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|ul|ol)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---- sections <-> fields --------------------------------------------------

export function sectionsToFields(team: TeamConfig, sections: Section[]): Record<string, string> {
  const out: Record<string, string> = {};
  let desc = "";
  for (const s of sections) {
    const f = fieldFor(team, s.heading);
    if (f !== DESCRIPTION) {
      out[f] = mdToHtml(s.body);
      continue;
    }
    desc += isPrimaryDescription(s.heading) ? `${s.body}\n\n` : `## ${s.heading}\n\n${s.body}\n\n`;
  }
  if (desc.trim() || sections.some((s) => fieldFor(team, s.heading) === DESCRIPTION)) out[DESCRIPTION] = mdToHtml(desc.trim());
  return out;
}

export function fieldsToSections(team: TeamConfig, fields: Record<string, any>, templateHeadings: string[]): Section[] {
  const descMd = htmlToMd(String(fields[DESCRIPTION] ?? ""));
  const parsed = parseSections(descMd);
  const sections: Section[] = [];
  const used = new Set<string>();
  const pushed = (h: string) => sections.some((s) => normHeading(s.heading) === normHeading(h));
  const take = (heading: string): string => {
    const f = fieldFor(team, heading);
    if (f !== DESCRIPTION) return htmlToMd(String(fields[f] ?? ""));
    if (isPrimaryDescription(heading)) return parsed.preamble;
    const hit = parsed.sections.find((s) => headingsMatch(s.heading, heading));
    if (hit) used.add(hit.heading);
    return hit?.body ?? "";
  };
  for (const h of templateHeadings) sections.push({ heading: h, body: take(h) });
  for (const s of parsed.sections) if (!used.has(s.heading) && !pushed(s.heading)) sections.push(s);
  return sections;
}

/** Description text before the first `##` heading when no template heading holds it (a story written by hand). */
export function currentText(team: TeamConfig, fields: Record<string, any>, templateHeadings: string[]): string {
  if (templateHeadings.some((h) => isPrimaryDescription(h) && fieldFor(team, h) === DESCRIPTION)) return "";
  return parseSections(htmlToMd(String(fields[DESCRIPTION] ?? ""))).preamble.trim();
}

export function loadStoryTemplate(root: string, team: TeamConfig): string {
  const candidates = [team.workItems?.storyTemplate, "skills/_shared/assets/story-template.md"].filter(Boolean) as string[];
  for (const c of candidates) {
    const p = join(root, c);
    if (existsSync(p)) return readUtf8(p);
  }
  return DEFAULT_STORY_TEMPLATE;
}

const emptyOf = (team: TeamConfig) => team.workItems?.emptySection || team.pullRequest?.emptySection || DEFAULT_EMPTY;

export function isGap(body: string, empty: string): boolean {
  const t = body.replace(/<!--[\s\S]*?-->/g, "").trim();
  if (!t || normHeading(t) === normHeading(empty)) return true;
  return t.split("\n").every((l) => /^(?:[-*]\s*(?:\[.\]\s*)?)?<[^>]+>\s*$/.test(l.trim()) || l.trim() === "");
}

// ---- ADO ------------------------------------------------------------------

export interface Story {
  id: number;
  type: string;
  state: string;
  title: string;
  parent?: number;
  url: string;
  fields: Record<string, any>;
}

export async function getStory(client: AdoClient, id: number): Promise<Story> {
  const r = await client.get<{ id: number; fields: Record<string, any>; relations?: { rel: string; url: string }[] }>(`wit/workitems/${id}`, { $expand: "relations" });
  const parentRel = (r.relations ?? []).find((x) => x.rel === "System.LinkTypes.Hierarchy-Reverse");
  const parent = parentRel ? Number(/(\d+)$/.exec(parentRel.url)?.[1]) : undefined;
  return {
    id: r.id ?? id,
    type: r.fields["System.WorkItemType"] ?? "",
    state: r.fields["System.State"] ?? "",
    title: r.fields["System.Title"] ?? "",
    parent,
    url: client.workItemUrl(id),
    fields: r.fields,
  };
}

function templateHeadings(tpl: string): string[] {
  return parseSections(tpl).sections.map((s) => s.heading);
}

export async function storyShow(ctx: Ctx, o: { id: number; json?: boolean }): Promise<string> {
  const { root, client } = repoClient(ctx);
  const team = loadTeam(root);
  const s = await getStory(client, o.id);
  const heads = templateHeadings(loadStoryTemplate(root, team));
  const sections = fieldsToSections(team, s.fields, heads);
  const current = currentText(team, s.fields, heads);
  if (o.json) return JSON.stringify({ id: s.id, type: s.type, state: s.state, title: s.title, parent: s.parent, url: s.url, sections, ...(current ? { currentText: current } : {}) });
  const head = `Story ${s.id} [${s.type}, ${s.state}] ${s.title}\n${s.url}${s.parent ? `\nparent: ${s.parent}` : ""}`;
  // text outside the template headings would hide behind "(empty)" sections, yet it holds the only facts there are
  const text = current ? `\n\nCurrent text (not in template form; use it as the facts for the sections):\n${current}` : "";
  return `${head}${text}\n\n${renderSections(sections.map((x) => ({ heading: x.heading, body: x.body || "(empty)" })))}`.trimEnd();
}

export async function storyCreate(ctx: Ctx, o: { title?: string; bodyFile?: string; parent?: number; type?: string; json?: boolean }): Promise<string> {
  if (!o.title) throw new AihubError("aihub story create needs --title");
  if (!o.bodyFile) throw new AihubError("aihub story create needs --body-file <file.md>");
  const { root, client } = repoClient(ctx);
  const team = loadTeam(root);
  const tpl = loadStoryTemplate(root, team);
  const composed = compose({ template: tpl, body: readUtf8(o.bodyFile), code: {}, emptyText: emptyOf(team) });
  const fields = sectionsToFields(team, parseSections(composed.text).sections);
  const type = o.type ?? team.workItems?.storyType ?? "User Story";
  const wi = team.workItems ?? {};
  const ops: unknown[] = [{ op: "add", path: "/fields/System.Title", value: o.title }];
  for (const [f, v] of Object.entries(fields)) ops.push({ op: "add", path: `/fields/${f}`, value: v });
  if (wi.areaPath) ops.push({ op: "add", path: "/fields/System.AreaPath", value: wi.areaPath });
  if (wi.iterationPath) ops.push({ op: "add", path: "/fields/System.IterationPath", value: wi.iterationPath });
  if (wi.tags?.length) ops.push({ op: "add", path: "/fields/System.Tags", value: wi.tags.join("; ") });
  if (o.parent) {
    ops.push({
      op: "add",
      path: "/relations/-",
      value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: `${client.remote.orgUrl}/_apis/wit/workItems/${o.parent}` },
    });
  }
  const created = await client.jsonPatch<{ id: number }>("POST", `wit/workitems/$${encodeURIComponent(type)}`, ops);
  const url = client.workItemUrl(created.id);
  const by = (k: string) => composed.filled.filter((f) => f.by === k).map((f) => f.heading);
  const empties = by("empty");
  return o.json
    ? JSON.stringify({ id: created.id, url, type, emptySections: empties })
    : `Story ${created.id} created: ${url}${empties.length ? ` (${emptyOf(team)}: ${empties.join(", ")})` : ""}`;
}

export async function storyRefine(ctx: Ctx, o: { id: number; bodyFile?: string; json?: boolean }): Promise<string> {
  const { root, client } = repoClient(ctx);
  const team = loadTeam(root);
  const empty = emptyOf(team);
  const heads = templateHeadings(loadStoryTemplate(root, team));
  const s = await getStory(client, o.id);
  const current = fieldsToSections(team, s.fields, heads);

  if (!o.bodyFile) {
    const gaps = current.filter((x) => isGap(x.body, empty)).map((x) => x.heading);
    if (o.json) return JSON.stringify({ id: s.id, title: s.title, gaps });
    return gaps.length
      ? `Story ${s.id} '${s.title}': ${gaps.length} gap(s): ${gaps.join(", ")}\n(no changes written; pass --body-file with the missing sections to update)`
      : `Story ${s.id} '${s.title}': no gaps; all template sections are filled`;
  }

  const patch = parseSections(readUtf8(o.bodyFile));
  if (!patch.sections.length) throw new AihubError("the body file has no '## ' sections; write one section per template heading");
  const merged = current.map((x) => ({ ...x }));
  const changed: string[] = [];
  for (const p of patch.sections) {
    const hit = merged.find((m) => headingsMatch(m.heading, p.heading));
    if (hit) hit.body = p.body;
    else merged.push({ heading: p.heading, body: p.body });
    changed.push(hit?.heading ?? p.heading);
  }
  const fields = sectionsToFields(team, merged.map((m) => ({ heading: m.heading, body: m.body.trim() ? m.body : empty })));
  const ops: unknown[] = Object.entries(fields)
    .filter(([f, v]) => v !== (s.fields[f] ?? "") && v !== "")
    .map(([f, v]) => ({ op: "add", path: `/fields/${f}`, value: v }));
  ops.push({ op: "add", path: "/fields/System.History", value: `Refined with aihub: ${changed.join(", ")}` });
  await client.jsonPatch("PATCH", `wit/workitems/${o.id}`, ops);
  return o.json ? JSON.stringify({ id: o.id, url: s.url, changed }) : `Story ${o.id} refined: ${s.url} (${changed.join(", ")})`;
}
