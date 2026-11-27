import { BrowseError } from "../browse/core.js";
import { mdToHtml, sectionsToFields, fieldsToSections, currentText, fieldFor } from "../story.js";
import { headingsMatch, parseSections, type Section } from "../templates.js";
import { bumpGeneration, F, me, pointsField, resolveTypeName, statesOf, typeFieldsOf, type Stories } from "./core.js";
import { boardOf, COMMENTS_API, currentIteration, readItem, teamAreas, type Item } from "./read.js";
import { templateOf } from "./template.js";

/**
 * Writes of the story browser. Every change of an existing work item carries the revision the user saw (a JSON Patch
 * `test /rev`): when someone else saved in between, nothing is written and the answer is `status: conflict` with the
 * current version and who changed what, so the bar can show a diff. A write never overwrites a newer version.
 */

export interface Conflict {
  status: "conflict";
  id: number;
  yourRev: number;
  rev: number;
  current: Omit<Item, "readAt" | "cached">;
  theirChanges: { rev: number; by: string; date: string; fields: string[] }[];
}

export interface Saved {
  status: "saved";
  id: number;
  rev: number;
  changed: string[];
}

const revOf = async (s: Stories, id: number) => Number((await s.c.get<{ rev?: number }>(`wit/workitems/${id}`, { fields: F.rev })).rev ?? 0);

export async function conflictOf(s: Stories, id: number, yourRev: number): Promise<Conflict> {
  const current = await readItem(s, id, await me(s));
  let theirChanges: Conflict["theirChanges"] = [];
  try {
    const u = await s.c.get<{ value?: { rev: number; revisedBy?: { displayName?: string; name?: string }; revisedDate?: string; fields?: Record<string, unknown> }[] }>(`wit/workitems/${id}/updates`, { $top: 200 });
    theirChanges = (u.value ?? [])
      .filter((x) => x.rev > yourRev)
      .map((x) => ({ rev: x.rev, by: x.revisedBy?.displayName ?? x.revisedBy?.name ?? "", date: String(x.fields?.["System.ChangedDate"] ? (x.fields["System.ChangedDate"] as { newValue?: string }).newValue ?? "" : x.revisedDate ?? ""), fields: Object.keys(x.fields ?? {}).filter((f) => !/^System\.(Rev|ChangedDate|ChangedBy|AuthorizedDate|RevisedDate|AuthorizedAs|PersonId|Watermark)$/.test(f)) }));
  } catch {
    /* the list of changes is a help for the diff only */
  }
  return { status: "conflict", id, yourRev, rev: current.rev, current, theirChanges };
}

/** One JSON Patch with the revision test; a newer revision (or a failed test) is a conflict, not an error. */
export async function patchAt(s: Stories, id: number, rev: number, ops: unknown[], changed: string[]): Promise<Saved | Conflict> {
  if (!Number.isInteger(rev) || rev <= 0) throw new BrowseError("badInput", "--rev is the revision the user saw (rev of aihub stories show)");
  if (!ops.length) return { status: "saved", id, rev, changed: [] };
  try {
    const r = await s.c.jsonPatch<{ rev?: number }>("PATCH", `wit/workitems/${id}`, [{ op: "test", path: "/rev", value: rev }, ...ops]);
    bumpGeneration(s);
    return { status: "saved", id, rev: Number(r.rev ?? rev + 1), changed };
  } catch (e) {
    const now = await revOf(s, id).catch(() => rev);
    if (now !== rev) return conflictOf(s, id, rev);
    throw e;
  }
}

const add = (field: string, value: unknown) => ({ op: "add", path: `/fields/${field}`, value });

/** "me", an e-mail address or "none" (unassigned). */
async function assignValue(s: Stories, who: string): Promise<string> {
  const w = who.trim();
  if (/^none$/i.test(w)) return "";
  if (/^me$/i.test(w)) {
    const m = await me(s);
    if (!m.email) throw new BrowseError("signedOut", "who is signed in could not be read; pass an e-mail address instead of me");
    return m.email;
  }
  return w;
}

// ---- move on the board / state ---------------------------------------------------------------------------------------

/** A state, or a board column: the column's state for the item's type, and the board's column field (columns can share a state). */
export async function storyMove(s: Stories, o: { id: number; to?: string; column?: string; board?: string; rev: number }): Promise<(Saved & { state: string; column?: string }) | Conflict> {
  if (!o.to?.trim() && !o.column?.trim()) throw new BrowseError("badInput", "--to <state> or --column <board column> is needed");
  const ops: unknown[] = [];
  let state = o.to?.trim() ?? "";
  if (o.column?.trim()) {
    const def = await boardOf(s, o.board);
    const col = def.columns.find((c) => c.name.toLowerCase() === o.column!.trim().toLowerCase());
    if (!col) throw new BrowseError("badInput", `board ${def.name} has no column '${o.column}' (${def.columns.map((c) => c.name).join(", ")})`);
    const w = await s.c.get<{ fields: Record<string, any> }>(`wit/workitems/${o.id}`, { fields: F.type });
    const type = String(w.fields?.[F.type] ?? "");
    const mapped = Object.entries(col.stateMappings ?? {}).find(([t]) => t.toLowerCase() === type.toLowerCase())?.[1];
    if (!mapped) throw new BrowseError("badInput", `column '${col.name}' of board ${def.name} has no state for ${type}`);
    state = mapped;
    if (def.columnField) ops.push(add(def.columnField, col.name));
  }
  ops.unshift(add(F.state, state));
  const r = await patchAt(s, o.id, o.rev, ops, [F.state, ...(ops.length > 1 ? ["column"] : [])]);
  return r.status === "saved" ? { ...r, state, ...(o.column ? { column: o.column.trim() } : {}) } : r;
}

// ---- edit ------------------------------------------------------------------------------------------------------------

export interface EditOpts {
  id: number;
  rev: number;
  title?: string;
  state?: string;
  assign?: string;
  priority?: number;
  severity?: string;
  points?: number;
  tags?: string[];
  iterationPath?: string;
  areaPath?: string;
  /** markdown with `## ` sections: each replaces the section of that heading */
  sections?: string;
  systemInfo?: string;
}

export async function editOps(s: Stories, cur: Record<string, any>, o: Omit<EditOpts, "id" | "rev">): Promise<{ ops: unknown[]; changed: string[] }> {
  const ops: unknown[] = [];
  const changed: string[] = [];
  const set = (field: string, value: unknown) => {
    if (String(cur[field] ?? "") === String(value ?? "")) return;
    ops.push(add(field, value));
    changed.push(field);
  };
  if (o.title !== undefined) {
    if (!o.title.trim()) throw new BrowseError("badInput", "a title cannot be empty");
    set(F.title, o.title.trim());
  }
  if (o.state) set(F.state, o.state);
  if (o.assign !== undefined) {
    const v = await assignValue(s, o.assign);
    const now = cur[F.assignedTo] as { uniqueName?: string } | string | undefined;
    const nowMail = typeof now === "string" ? now : now?.uniqueName ?? "";
    if (nowMail.toLowerCase() !== v.toLowerCase()) {
      ops.push(add(F.assignedTo, v));
      changed.push(F.assignedTo);
    }
  }
  if (o.priority !== undefined) set(F.priority, o.priority);
  if (o.severity !== undefined) set(F.severity, o.severity);
  if (o.points !== undefined) set(await pointsField(s), o.points);
  if (o.tags) set(F.tags, o.tags.join("; "));
  if (o.iterationPath) set(F.iteration, o.iterationPath);
  if (o.areaPath) set(F.area, o.areaPath);
  if (o.systemInfo !== undefined) set(F.systemInfo, mdToHtml(o.systemInfo));
  if (o.sections !== undefined) {
    const patch = parseSections(o.sections).sections;
    if (!patch.length) throw new BrowseError("badInput", "the sections file has no '## ' headings");
    const type = String(cur[F.type] ?? "");
    const tpl = await templateOf(s, type);
    const merged: Section[] = fieldsToSections(s.teamCfg, cur, tpl.headings, tpl.layout).map((x) => ({ ...x }));
    const kept = currentText(s.teamCfg, cur, tpl.headings, tpl.layout);
    if (kept && fieldFor(s.teamCfg, "Description", tpl.layout) === tpl.layout.primary) merged.unshift({ heading: "Description", body: kept });
    for (const p of patch) {
      const hit = merged.find((m) => headingsMatch(m.heading, p.heading));
      if (hit) hit.body = p.body;
      else merged.push({ heading: p.heading, body: p.body });
    }
    // an empty template section that was not edited is not written as an empty heading
    const keep = merged.filter((m) => m.body.trim() || patch.some((p) => headingsMatch(p.heading, m.heading)));
    const fields = sectionsToFields(s.teamCfg, keep, tpl.layout);
    // only the fields a changed section lives in are written
    const touched = new Set(patch.map((p) => fieldFor(s.teamCfg, merged.find((m) => headingsMatch(m.heading, p.heading))?.heading ?? p.heading, tpl.layout)));
    for (const [f, v] of Object.entries(fields)) if (touched.has(f)) set(f, v);
  }
  return { ops, changed };
}

export async function storyEdit(s: Stories, o: EditOpts): Promise<Saved | Conflict> {
  const w = await s.c.get<{ rev: number; fields: Record<string, any> }>(`wit/workitems/${o.id}`);
  if (Number(w.rev) !== o.rev) return conflictOf(s, o.id, o.rev);
  const { ops, changed } = await editOps(s, w.fields, o);
  return patchAt(s, o.id, o.rev, ops, changed);
}

// ---- tasks -----------------------------------------------------------------------------------------------------------

/** Tick a task: its state goes to the Completed state of its type; untick: back to the first Proposed one. */
export async function storyTask(s: Stories, o: { id: number; done: boolean; rev?: number }): Promise<(Saved & { state: string }) | Conflict> {
  const w = await s.c.get<{ rev: number; fields: Record<string, any> }>(`wit/workitems/${o.id}`, { fields: `${F.type},${F.state},${F.rev}` });
  const rev = o.rev ?? Number(w.rev);
  const type = String(w.fields[F.type] ?? "Task");
  const states = await statesOf(s, type);
  const want = o.done ? states.find((x) => x.category === "Completed") : states.find((x) => x.category === "Proposed") ?? states.find((x) => x.category === "InProgress");
  if (!want) throw new BrowseError("failed", `${type} has no ${o.done ? "Completed" : "Proposed"} state`);
  if (String(w.fields[F.state]).toLowerCase() === want.name.toLowerCase()) return { status: "saved", id: o.id, rev, changed: [], state: want.name };
  const r = await patchAt(s, o.id, rev, [add(F.state, want.name)], [F.state]);
  return r.status === "saved" ? { ...r, state: want.name } : r;
}

/** A new task under a work item, in its area and iteration. */
export async function storyAddTask(s: Stories, o: { parent: number; title: string }): Promise<{ id: number; rev: number; title: string; state: string; url: string }> {
  if (!o.title?.trim()) throw new BrowseError("badInput", "--title is needed");
  const p = await s.c.get<{ fields: Record<string, any> }>(`wit/workitems/${o.parent}`, { fields: `${F.area},${F.iteration}` });
  const r = await createChild(s, o.parent, "Task", o.title.trim(), p.fields);
  bumpGeneration(s);
  return r;
}

export async function createChild(s: Stories, parent: number, type: string, title: string, parentFields: Record<string, any>): Promise<{ id: number; rev: number; title: string; state: string; url: string }> {
  const ops: unknown[] = [add(F.title, title)];
  if (parentFields[F.area]) ops.push(add(F.area, parentFields[F.area]));
  if (parentFields[F.iteration]) ops.push(add(F.iteration, parentFields[F.iteration]));
  ops.push({ op: "add", path: "/relations/-", value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: `${s.c.remote.orgUrl}/_apis/wit/workItems/${parent}` } });
  const w = await s.c.jsonPatch<{ id: number; rev?: number; fields?: Record<string, any> }>("POST", `wit/workitems/$${encodeURIComponent(type)}`, ops);
  return { id: w.id, rev: Number(w.rev ?? 1), title, state: String(w.fields?.[F.state] ?? ""), url: s.c.workItemUrl(w.id) };
}

// ---- comment ---------------------------------------------------------------------------------------------------------

export async function storyComment(s: Stories, o: { id: number; markdown: string }): Promise<{ id: number; comment: { id: number; date: string; markdown: string; html: string } }> {
  const text = (o.markdown ?? "").trim();
  if (!text) throw new BrowseError("badInput", "the comment is empty");
  const html = mdToHtml(text);
  const r = await s.c.request<{ id: number; createdDate?: string; text?: string }>("POST", `wit/workItems/${o.id}/comments`, { body: { text: html }, query: { "api-version": COMMENTS_API } });
  bumpGeneration(s);
  return { id: o.id, comment: { id: r.data.id, date: r.data.createdDate ?? "", markdown: text, html: r.data.text ?? html } };
}

// ---- new Story or Bug ------------------------------------------------------------------------------------------------

export async function storyForm(s: Stories, o: { type?: string }): Promise<{ type: string; template: string; sections: { heading: string; field: string; hint: string }[]; systemInfo: boolean; severityValues?: string[]; priorityValues?: string[]; defaults: { areaPath: string; iterationPath?: string } }> {
  const type = await resolveTypeName(s, o.type);
  const tf = await typeFieldsOf(s, type).catch(() => ({ fields: undefined as string[] | undefined, allowed: {} as Record<string, string[]> }));
  const tpl = await templateOf(s, type, tf.fields);
  const sections = parseSections(tpl.text).sections.map((x) => ({ heading: x.heading, field: fieldFor(s.teamCfg, x.heading, tpl.layout), hint: x.body.trim() }));
  const areaPath = s.settings.areaPath ?? (await teamAreas(s).catch(() => ({ defaultArea: s.project }))).defaultArea;
  const iterationPath = await currentIteration(s);
  return {
    type,
    template: tpl.source,
    sections,
    systemInfo: !!tf.fields?.some((f) => f.toLowerCase() === F.systemInfo.toLowerCase()),
    ...(tf.allowed[F.severity] ? { severityValues: tf.allowed[F.severity] } : {}),
    ...(tf.allowed[F.priority] ? { priorityValues: tf.allowed[F.priority] } : {}),
    defaults: { areaPath, ...(iterationPath ? { iterationPath } : {}) },
  };
}

export interface NewOpts {
  type?: string;
  title: string;
  /** markdown with `## ` sections in the template's headings */
  sections?: string;
  systemInfo?: string;
  severity?: string;
  priority?: number;
  parent?: number;
  /** "current" = the team's current sprint; empty = the team's backlog iteration (Azure DevOps default) */
  iterationPath?: string;
  areaPath?: string;
  assign?: string;
  tags?: string[];
}

export async function storyNew(s: Stories, o: NewOpts): Promise<{ id: number; rev: number; type: string; title: string; url: string; template: string }> {
  if (!o.title?.trim()) throw new BrowseError("badInput", "--title is needed");
  const type = await resolveTypeName(s, o.type);
  const tpl = await templateOf(s, type);
  // sections that are not given stay as the template wrote them (the hints), so the text is in template form
  const given = parseSections(o.sections ?? "").sections;
  const secs: Section[] = parseSections(tpl.text).sections.map((t) => ({ heading: t.heading, body: given.find((g) => headingsMatch(g.heading, t.heading))?.body ?? "" }));
  for (const g of given) if (!secs.some((x) => headingsMatch(x.heading, g.heading))) secs.push(g);
  const fields = sectionsToFields(s.teamCfg, secs.filter((x) => x.body.trim()), tpl.layout);
  const ops: unknown[] = [add(F.title, o.title.trim())];
  for (const [f, v] of Object.entries(fields)) if (v) ops.push(add(f, v));
  if (o.systemInfo?.trim()) ops.push(add(F.systemInfo, mdToHtml(o.systemInfo)));
  if (o.severity) ops.push(add(F.severity, o.severity));
  if (o.priority) ops.push(add(F.priority, o.priority));
  const area = o.areaPath || s.settings.areaPath || s.teamCfg.workItems?.areaPath || (await teamAreas(s).catch(() => undefined))?.defaultArea;
  if (area) ops.push(add(F.area, area));
  const iteration = o.iterationPath === "current" ? await currentIteration(s) : o.iterationPath || s.teamCfg.workItems?.iterationPath;
  if (o.iterationPath === "current" && !iteration) throw new BrowseError("needsSetting", `team ${s.team} has no current sprint; choose an iteration`);
  if (iteration) ops.push(add(F.iteration, iteration));
  const tags = o.tags ?? s.teamCfg.workItems?.tags;
  if (tags?.length) ops.push(add(F.tags, tags.join("; ")));
  if (o.assign) ops.push(add(F.assignedTo, await assignValue(s, o.assign)));
  if (o.parent) ops.push({ op: "add", path: "/relations/-", value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: `${s.c.remote.orgUrl}/_apis/wit/workItems/${o.parent}` } });
  const w = await s.c.jsonPatch<{ id: number; rev?: number }>("POST", `wit/workitems/$${encodeURIComponent(type)}`, ops);
  bumpGeneration(s);
  return { id: w.id, rev: Number(w.rev ?? 1), type, title: o.title.trim(), url: s.c.workItemUrl(w.id), template: tpl.source };
}
