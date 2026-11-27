import { DEFAULT_LAYOUT, layoutFor, type FieldLayout } from "../fieldLayout.js";
import { currentText, DEFAULT_STORY_TEMPLATE, fieldFor, fieldsToSections, findStoryTemplate, mdToHtml } from "../story.js";
import { parseSections, type Section } from "../templates.js";
import { DEFAULT_TEMPLATES, findTypeTemplate, knownType } from "../workItemType.js";
import { storyTypeOf, typeFieldsOf, type Stories } from "./core.js";

/**
 * The text of a work item as the team template writes it: one section per template heading, each with the field it
 * lives in (the main text field, or Acceptance Criteria; a Bug keeps its text in ReproSteps). The template comes from the
 * repository this runs in (team.yaml, template files), else the team's Azure DevOps template, else the built-in one.
 */

export interface ItemSection {
  heading: string;
  field: string;
  markdown: string;
  html: string;
}

export interface TemplateOf {
  text: string;
  source: string;
  headings: string[];
  layout: FieldLayout;
}

export async function templateOf(s: Stories, type: string, typeFields?: string[]): Promise<TemplateOf> {
  const story = await storyTypeOf(s);
  const own = type && type.toLowerCase() !== story.toLowerCase() ? knownType(s.teamCfg, type) : undefined;
  let fields = typeFields;
  if (!fields) {
    try {
      fields = (await typeFieldsOf(s, type || story)).fields;
    } catch {
      fields = undefined;
    }
  }
  const layout = type ? layoutFor(type, fields) : DEFAULT_LAYOUT;
  let text: string;
  let source: string;
  if (s.root) {
    const found = own ? await findTypeTemplate(s.root, s.c, s.teamCfg, own, s.b.refresh) : await findStoryTemplate(s.root, s.c, s.teamCfg, s.b.refresh);
    text = found.text;
    source = found.source;
  } else {
    text = own ? DEFAULT_TEMPLATES[own] ?? "## Description\n" : DEFAULT_STORY_TEMPLATE;
    source = "built-in (no repository open: the team template is read from a clone)";
  }
  return { text, source, headings: parseSections(text).sections.map((x) => x.heading), layout };
}

/** The sections of a work item: the template headings first, then the other `##` headings of its text. */
export async function sectionsOf(s: Stories, type: string, fields: Record<string, any>, typeFields?: string[]): Promise<{ sections: ItemSection[]; template: string; tpl: TemplateOf }> {
  const tpl = await templateOf(s, type, typeFields);
  const secs = fieldsToSections(s.teamCfg, fields, tpl.headings, tpl.layout);
  // text written outside the template headings (a hand-written description) is shown first, never hidden
  const kept = currentText(s.teamCfg, fields, tpl.headings, tpl.layout);
  if (kept) secs.unshift({ heading: "Description", body: kept });
  return { sections: secs.map((x) => itemSection(s, x, tpl.layout)), template: tpl.source, tpl };
}

export const itemSection = (s: Stories, x: Section, layout: FieldLayout): ItemSection => ({ heading: x.heading, field: fieldFor(s.teamCfg, x.heading, layout), markdown: x.body, html: mdToHtml(x.body) });

/** The kind of a part for refine: description, criteria, tasks or the heading itself. */
export function partOf(heading: string): string {
  const h = heading.toLowerCase().replace(/[^a-z]/g, "");
  if (/^(description|omschrijving|beschrijving|reprosteps|stepstoreproduce)$/.test(h)) return "description";
  if (/^(acceptancecriteria|acceptatiecriteria|criteria)$/.test(h)) return "criteria";
  if (/^(tasks|taken|subtasks)$/.test(h)) return "tasks";
  return heading;
}
