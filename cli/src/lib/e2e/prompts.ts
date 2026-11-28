import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BrowseError } from "../browse/core.js";
import { configHome } from "../configHome.js";
import type { Ctx } from "../context.js";
import { chooseWorkspace, fabricWorkspaces } from "../fabric.js";
import { originDefaultBranch } from "../git.js";
import { promptsRoot } from "../pack.js";
import { readSetFile, repoBranch } from "../setFile.js";
import { me, type Stories } from "../stories/core.js";
import { readItem } from "../stories/read.js";
import { fixBranchName } from "../stories/start.js";
import { defaultTargetFor } from "../team.js";
import { howKind, renderCriteria } from "./criteria.js";
import { langOf, readCriteria } from "./workitem.js";
import { setFolderOf, storySetFolder } from "./state.js";

/**
 * Team prompts: one goal prompt per agent action, the same for every story, filled in with the story, its set and
 * team.yaml. The team's own version lives in its repository (`.agents/skills/_shared/prompts/<action>.md`) and wins over
 * the default that ships with aihub (`prompts/<action>.md`). A prompt edited for one story (Edit Prompt in the bar) is
 * kept in the user's config folder until it is reset.
 */

export const ACTIONS = [
  "story-start",
  "story-run",
  "story-criteria",
  "story-refine",
  "story-test-fabric",
  "story-tests",
  "story-pr",
  "story-pr-review",
  "story-fix-pipeline",
  "story-explain",
  "bug-reproduce",
  "bug-run",
] as const;
export type Action = (typeof ACTIONS)[number];

export const TEAM_PROMPT_DIR = ".agents/skills/_shared/prompts";

export function checkAction(a: string | undefined): Action {
  const x = (a ?? "").trim().replace(/^\//, "");
  if (!(ACTIONS as readonly string[]).includes(x)) throw new BrowseError("badInput", `unknown action '${a ?? ""}'; one of: ${ACTIONS.join(", ")}`);
  return x as Action;
}

export interface PromptMeta {
  title: string;
  slash: string;
  goal: string;
  reads: string;
  produces: string;
}

export function splitFront(text: string): { meta: Partial<PromptMeta>; body: string } {
  const t = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(t);
  if (!m) return { meta: {}, body: t };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: t.slice(m[0].length) };
}

export type Source = "story" | "team" | "default";

const safe = (x: string) => x.replace(/[^A-Za-z0-9._-]+/g, "-");
export const storyPromptFile = (s: Stories, id: number, action: Action) => join(configHome(s.b.env), "stories", "prompts", `${safe(s.b.org)}-${safe(s.project)}-${id}-${action}.md`);

/** The repositories whose team prompts count: the repository this runs in, and the repositories of the set. */
function teamRoots(s: Stories, set?: string): string[] {
  const roots: string[] = [];
  if (s.root) roots.push(s.root);
  if (set) for (const r of readSetFile(set)?.top.repos ?? []) if (r.path) roots.push(r.path);
  return roots;
}

/** A prompt file with its text; a missing or empty one is a clear error, never an empty prompt. */
export function promptText(file: string): string {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new BrowseError("notFound", `prompt file not found: ${file}`);
  }
  if (!splitFront(text).body.trim()) throw new BrowseError("failed", `prompt file is empty: ${file}; fix it or remove it to use the default`);
  return text;
}

export function findPrompt(s: Stories, action: Action, o: { id?: number; set?: string } = {}): { source: Source; file: string; text: string } {
  if (o.id) {
    const f = storyPromptFile(s, o.id, action);
    if (existsSync(f)) return { source: "story", file: f, text: promptText(f) };
  }
  for (const r of teamRoots(s, o.set)) {
    const f = join(r, TEAM_PROMPT_DIR, `${action}.md`);
    if (existsSync(f)) return { source: "team", file: f, text: promptText(f) };
  }
  // the default in the team's language (team.yaml `language`; English when it says nothing): prompts/en/, or prompts/ (Dutch) for a Dutch team
  const root = promptsRoot();
  const en = join(root, "en", `${action}.md`);
  const f = langOf(s) === "en" && existsSync(en) ? en : join(root, `${action}.md`);
  return { source: "default", file: f, text: promptText(f) };
}

/** The fixed limits; the workspace is named only when team.yaml knows it (never a placeholder or a note in brackets). */
export function limitsText(lang: "nl" | "en", workspace?: string): string {
  const ws = workspace ? (lang === "nl" ? ` (${workspace})` : ` (${workspace})`) : "";
  return lang === "nl"
    ? `Nooit pushen naar of mergen in main of staging. Nooit ACC of PRD. Alleen de Fabric-workspace van de featurebranch${ws}. Nooit een pull request mergen of completen.`
    : `Never push to or merge into main or staging. Never ACC or PRD. Only the Fabric workspace of the feature branch${ws}. Never merge or complete a pull request.`;
}

export interface Rendered {
  action: Action;
  slash: string;
  title: string;
  source: Source;
  file: string;
  summary: { goal: string; reads: string; produces: string; limits: string };
  filled: { name: string; value: string }[];
  /** placeholders that had no value (left as they were) */
  unknown: string[];
  /** the Fabric workspace of the feature branch (for "Test on Fabric in the feature workspace · <ws>") */
  workspace: string;
  /** the options of the run (dialog of Run End to End, choice in Create Pull Request) the prompt was filled with */
  options: RunOptions;
  text: string;
}

/** The options of the dialog: plan first, test on Fabric, Active + assign me (Resolved when green); for story-pr the user's choice. */
export interface RunOptions {
  planFirst: boolean;
  fabric: boolean;
  setActive: boolean;
  draft: boolean;
  anyway: boolean;
}

export function runOptions(given: Partial<Record<keyof RunOptions, unknown>> | undefined, hasWorkspace: boolean): RunOptions {
  const b = (v: unknown, d: boolean) => (v === undefined || v === null || v === "" ? d : v === true || v === "true" || v === "yes" || v === "1");
  return { planFirst: b(given?.planFirst, true), fabric: b(given?.fabric, hasWorkspace), setActive: b(given?.setActive, false), draft: b(given?.draft, false), anyway: b(given?.anyway, false) };
}

/** `{{#if name}}...{{/if}}`: kept when the value is "true", left out otherwise (a block on its own lines leaves no empty line). */
export function conditionals(text: string, flags: Record<string, boolean>): string {
  // a block on its own lines first (no empty line is left behind), then a block inside a line
  const lines = text.replace(/^\{\{#if\s+(\w+)\s*\}\}\n([\s\S]*?)^\{\{\/if\}\}\n?/gm, (_a, name: string, body: string) => (flags[name] ? body : ""));
  return lines.replace(/\{\{#if\s+(\w+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g, (_a, name: string, body: string) => (flags[name] ? body : ""));
}

/** Fills `{{name}}` from the values; unknown names stay as they are and are reported. */
export function fill(text: string, values: Record<string, string>): { text: string; filled: { name: string; value: string }[]; unknown: string[] } {
  const filled = new Map<string, string>();
  const unknown = new Set<string>();
  const out = text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (all, name: string) => {
    if (name in values) {
      filled.set(name, values[name]);
      return values[name];
    }
    unknown.add(name);
    return all;
  });
  return { text: out, filled: [...filled].map(([name, value]) => ({ name, value })), unknown: [...unknown] };
}

/** The values of the placeholders for one story: the work item, its criteria and tasks, its set on this PC, team.yaml. */
export async function valuesFor(ctx: Ctx, s: Stories, id: number): Promise<Record<string, string>> {
  const item = await readItem(s, id, await me(s));
  const lang = langOf(s);
  const crit = await readCriteria(s, id).catch(() => undefined);
  const set = storySetFolder(ctx, id);
  const top = set ? readSetFile(set)?.top : undefined;
  const branch = top && top.story === id ? top.branch : (item.local.branches[0]?.branch ?? (/^bug$/i.test(item.type) ? fixBranchName(s, id, item.title) : `feature/${id}-...`));
  const repos = top && top.story === id ? top.repos.map((r) => `${r.name} (${repoBranch(top, r)})`).join(", ") : [...new Set(item.local.branches.map((b) => b.repo))].join(", ");
  const firstRepo = top?.repos[0]?.name ?? s.root?.split(/[\\/]/).pop() ?? "";
  const target = defaultTargetFor(s.teamCfg, firstRepo) ?? (s.root ? originDefaultBranch(s.root) : "") ?? "";
  const ws = chooseWorkspace(fabricWorkspaces(s.teamCfg).filter((w) => w.environment !== "acc" && w.environment !== "prd"), { branch });
  // without a workspace in team.yaml a plain phrase, so a sentence around it still reads well
  const workspace = ws?.name ?? (lang === "nl" ? "de workspace van de featurebranch (team.yaml noemt er geen)" : "the workspace of the feature branch (team.yaml names none)");
  const none = lang === "nl" ? "geen" : "none";
  const criteria = crit?.criteria.length
    ? renderCriteria(crit.criteria, lang)
        .split("\n")
        .map((l) => (l ? `  ${l}` : l))
        .join("\n")
    : lang === "nl"
      ? "  (nog geen acceptatiecriteria)"
      : "  (no acceptance criteria yet)";
  return {
    "story.id": String(id),
    "story.rev": String(item.rev),
    // the text of the story without its criteria (they come separately): enough for criteria and refine without a second read
    "story.description":
      item.sections
        .filter((x) => !/acceptatiecriteria|acceptance ?criteria|criteria/i.test(x.heading) && x.markdown.trim())
        .map((x) => `${x.heading}: ${x.markdown.trim().replace(/\s*\n\s*/g, " ")}`)
        .join("; ") || (lang === "nl" ? "(leeg)" : "(empty)"),
    "story.title": item.title,
    "story.type": item.type,
    "story.state": item.state,
    "story.iteration": item.iterationPath.split("\\").pop() ?? item.iterationPath,
    "story.assignedTo": item.assignedTo?.name || (lang === "nl" ? "niemand" : "nobody"),
    "story.url": item.url,
    "story.project": s.project,
    criteria,
    "criteria.count": String(crit?.criteria.length ?? 0),
    "criteria.kinds": [...new Set((crit?.criteria ?? []).map((c) => howKind(c.how)).filter(Boolean))].join(", ") || none,
    tasks: item.tasks.length ? item.tasks.map((t) => `#${t.id} ${t.title}${t.done ? (lang === "nl" ? " (klaar)" : " (done)") : ""}`).join(", ") : none,
    branch,
    target: target || (lang === "nl" ? "de standaardbranch" : "the default branch"),
    repos: repos || (lang === "nl" ? "de repo van dit venster" : "the repository of this window"),
    set: set ?? none,
    workspace,
    "team.fabric.featureWorkspace": workspace,
    language: lang === "nl" ? "Nederlands" : "English",
    limits: limitsText(lang, ws?.name),
    "workspace.known": ws ? "true" : "",
  };
}

export async function renderPrompt(ctx: Ctx, s: Stories, action: Action, id: number, given: Partial<Record<keyof RunOptions, unknown>> = {}): Promise<Rendered> {
  const set = storySetFolder(ctx, id) ?? setFolderOf(ctx.cwd);
  const found = findPrompt(s, action, { id, set });
  const { meta: own, body } = splitFront(found.text);
  // a prompt edited for one story has no front matter: the title and summary come from the team or default version
  const meta = found.source === "story" ? { ...splitFront(findPrompt(s, action, { set }).text).meta, ...own } : own;
  const values = await valuesFor(ctx, s, id);
  const hasWs = values["workspace.known"] === "true";
  const { readState, stateFile } = await import("./state.js");
  const run = readState<{ options?: Partial<RunOptions> }>(stateFile(ctx, id, "run"), {});
  const options = runOptions({ ...run.options, ...given }, hasWs);
  const flags = { ...options, noFabric: !options.fabric, askChoice: !options.draft && !options.anyway };
  const f = fill(conditionals(body, flags), values);
  return {
    action,
    slash: meta.slash ?? `/${action}`,
    title: meta.title ?? action,
    source: found.source,
    file: found.file,
    summary: { goal: fill(meta.goal ?? "", values).text, reads: meta.reads ?? "", produces: meta.produces ?? "", limits: values.limits },
    filled: f.filled,
    unknown: f.unknown,
    workspace: values.workspace,
    options,
    text: f.text.replace(/\n{3,}/g, "\n\n").trim() + "\n",
  };
}

/** Every action with its title, slash command, summary and where its prompt comes from (no story needed). */
export function listPrompts(ctx: Ctx, s: Stories): { prompts: { action: Action; title: string; slash: string; goal: string; reads: string; produces: string; source: Source; file: string; text: string }[] } {
  const set = setFolderOf(ctx.cwd);
  const repo = s.root?.split(/[\\/]/).pop() ?? "";
  // team.yaml's target branch, else the default branch of the repository this runs in, else a plain word
  const listTarget = defaultTargetFor(s.teamCfg, repo) || (s.root ? originDefaultBranch(s.root) : "") || (langOf(s) === "en" ? "the target branch" : "de doelbranch");
  return {
    prompts: ACTIONS.map((a) => {
      const p = findPrompt(s, a, { set });
      const { meta, body } = splitFront(p.text);
      // the full prompt with its placeholders, for the Prompts page (no story is needed)
      // the summary has no story: {{target}} becomes the team's target branch (or a plain word), never a raw placeholder
      const goal = fill(meta.goal ?? "", { target: listTarget }).text;
      return { action: a, title: meta.title ?? a, slash: meta.slash ?? `/${a}`, goal, reads: meta.reads ?? "", produces: meta.produces ?? "", source: p.source, file: p.file, text: body.trim() + "\n" };
    }),
  };
}

/** Edit Prompt: the text the user changed is kept for this story and action until Reset to Generated. */
export function savePrompt(s: Stories, id: number, action: Action, text: string): { file: string } {
  if (!text.trim()) throw new BrowseError("badInput", "the prompt is empty");
  const f = storyPromptFile(s, id, action);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, text.replace(/\r\n/g, "\n"), "utf8");
  return { file: f };
}

export function resetPrompt(s: Stories, id: number, action: Action): { reset: boolean } {
  const f = storyPromptFile(s, id, action);
  const had = existsSync(f);
  rmSync(f, { force: true });
  return { reset: had };
}
