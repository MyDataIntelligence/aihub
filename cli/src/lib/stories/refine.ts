import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BrowseError } from "../browse/core.js";
import { configHome } from "../configHome.js";
import { isGap } from "../story.js";
import { DEFAULT_EMPTY, headingsMatch, parseSections } from "../templates.js";
import { bumpGeneration, F, me, type Stories } from "./core.js";
import { readItem } from "./read.js";
import { partOf } from "./template.js";
import { createChild, storyEdit, type Conflict } from "./write.js";

/**
 * Refine from the story browser, never automatic: the bar puts `prompt` in the chat, the agent writes a proposal file
 * (the existing refine flow: one `##` section per part it proposes, `## Tasks` as a list), the bar shows the proposal per
 * part next to the current text, and only the parts the user ticks are written.
 */

const safe = (x: string) => x.replace(/[^A-Za-z0-9._-]+/g, "-");

export const proposalFile = (s: Stories, id: number, kind = "refine") => join(configHome(s.b.env), "stories", "proposals", `${safe(s.b.org)}-${safe(s.project)}-${id}-${kind}.md`);

const emptyOf = (s: Stories) => s.teamCfg.workItems?.emptySection || s.teamCfg.pullRequest?.emptySection || DEFAULT_EMPTY;

export async function refineAsk(s: Stories, id: number): Promise<{ id: number; title: string; type: string; gaps: string[]; proposalFile: string; prompt: string }> {
  const item = await readItem(s, id, await me(s));
  const file = proposalFile(s, id);
  mkdirSync(join(configHome(s.b.env), "stories", "proposals"), { recursive: true });
  const gaps = item.sections.filter((x) => isGap(x.markdown, emptyOf(s))).map((x) => x.heading);
  const heads = item.sections.map((x) => x.heading);
  const prompt = [
    `Refine ${item.type} ${id} "${item.title}" for the story browser. Read it with: aihub story show --id ${id} --json`,
    gaps.length ? `Its gaps: ${gaps.join(", ")}.` : "It has no empty sections; sharpen what is vague.",
    `Write a proposal, do not change the work item: write the file ${file} as markdown with one "## <heading>" per part you propose (headings: ${heads.join(", ")}), and "## Tasks" with one "- <task title>" line per task to add.`,
    "Keep the facts of the current text; leave out parts you would not change.",
    'When the file is written, answer "Proposal ready" and stop: the user picks the parts to apply in the story browser.',
  ].join("\n");
  return { id, title: item.title, type: item.type, gaps, proposalFile: file, prompt };
}

export interface Part {
  part: string;
  heading: string;
  current: string;
  proposed: string;
  changed: boolean;
}

export interface Proposal {
  id: number;
  rev: number;
  proposalFile: string;
  parts: Part[];
  tasks: { current: string[]; proposed: string[]; new: string[] };
}

const taskLines = (body: string) =>
  body
    .split("\n")
    .map((l) => /^\s*(?:[-*]|\d+[.)])\s+(?:\[.\]\s*)?(.+?)\s*$/.exec(l)?.[1])
    .filter((x): x is string => !!x);

export async function refineRead(s: Stories, id: number, file = proposalFile(s, id)): Promise<Proposal> {
  if (!existsSync(file)) throw new BrowseError("notFound", `no proposal yet for ${id}: ask for one first (aihub stories refine-ask --id ${id})`);
  const item = await readItem(s, id, await me(s));
  const proposed = parseSections(readFileSync(file, "utf8")).sections;
  const parts: Part[] = [];
  let tasks: Proposal["tasks"] = { current: item.tasks.map((t) => t.title), proposed: [], new: [] };
  for (const p of proposed) {
    const part = partOf(p.heading);
    if (part === "tasks") {
      const list = taskLines(p.body);
      const have = new Set(item.tasks.map((t) => t.title.trim().toLowerCase()));
      tasks = { current: item.tasks.map((t) => t.title), proposed: list, new: list.filter((t) => !have.has(t.trim().toLowerCase())) };
      parts.push({ part, heading: p.heading, current: tasks.current.map((t) => `- ${t}`).join("\n"), proposed: list.map((t) => `- ${t}`).join("\n"), changed: tasks.new.length > 0 });
      continue;
    }
    const cur = item.sections.find((x) => headingsMatch(x.heading, p.heading));
    parts.push({ part, heading: cur?.heading ?? p.heading, current: cur?.markdown ?? "", proposed: p.body.trim(), changed: (cur?.markdown ?? "").trim() !== p.body.trim() });
  }
  return { id, rev: item.rev, proposalFile: file, parts, tasks };
}

export async function refineApply(s: Stories, o: { id: number; rev: number; parts: string[] }): Promise<{ status: "saved"; id: number; rev: number; applied: string[]; tasksCreated: number[] } | Conflict> {
  if (!o.parts.length) throw new BrowseError("badInput", "--parts names what to apply: description,criteria,tasks or a heading");
  const p = await refineRead(s, o.id);
  const want = (x: Part) => o.parts.some((w) => w.toLowerCase() === x.part.toLowerCase() || headingsMatch(w, x.heading));
  const chosen = p.parts.filter(want);
  if (!chosen.length) throw new BrowseError("badInput", `the proposal has none of: ${o.parts.join(", ")} (it has: ${p.parts.map((x) => x.part).join(", ")})`);
  const textParts = chosen.filter((x) => x.part !== "tasks");
  let rev = o.rev;
  if (textParts.length) {
    const r = await storyEdit(s, { id: o.id, rev: o.rev, sections: textParts.map((x) => `## ${x.heading}\n\n${x.proposed}`).join("\n\n") });
    if (r.status === "conflict") return r;
    rev = r.rev;
  } else if (p.rev !== o.rev) {
    const { conflictOf } = await import("./write.js");
    return conflictOf(s, o.id, o.rev);
  }
  const tasksCreated: number[] = [];
  if (chosen.some((x) => x.part === "tasks") && p.tasks.new.length) {
    const parent = await s.c.get<{ fields: Record<string, any> }>(`wit/workitems/${o.id}`, { fields: `${F.area},${F.iteration}` });
    for (const t of p.tasks.new) tasksCreated.push((await createChild(s, o.id, "Task", t, parent.fields)).id);
    rev = Number((await s.c.get<{ rev?: number }>(`wit/workitems/${o.id}`, { fields: F.rev })).rev ?? rev); // every child link is a revision of the parent
    bumpGeneration(s);
  }
  return { status: "saved", id: o.id, rev, applied: chosen.map((x) => x.part), tasksCreated };
}
