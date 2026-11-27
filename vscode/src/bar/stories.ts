import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The story browser: the aihub.bar.story* commands. Each one is one `aihub stories ...` process and answers with the
 * CLI's JSON, or with `{ error: { kind, message } }` (never a popup: the caller shows it). A changed item that someone
 * else saved in between is not an error: `{ status: "conflict", current, theirChanges }`. Text (sections, comments,
 * notes) goes to the CLI in private temporary files, removed right after. Nothing runs at activation, nothing polls.
 * The JSON shapes are in docs/cli-json.md ("Story browser").
 */

export type StoryCommand =
  | "settings"
  | "saveSettings"
  | "projects"
  | "teams"
  | "areas"
  | "iterations"
  | "list"
  | "board"
  | "show"
  | "move"
  | "edit"
  | "task"
  | "addTask"
  | "comment"
  | "refineAsk"
  | "refine"
  | "refineApply"
  | "start"
  | "form"
  | "new"
  | "draftAsk"
  | "draft"
  | "link"
  | "fixBranch";

/** the CLI sub of each command */
export const STORY_SUBS: Record<StoryCommand, string> = {
  settings: "settings",
  saveSettings: "settings",
  projects: "projects",
  teams: "teams",
  areas: "areas",
  iterations: "iterations",
  list: "list",
  board: "board",
  show: "show",
  move: "move",
  edit: "edit",
  task: "task",
  addTask: "add-task",
  comment: "comment",
  refineAsk: "refine-ask",
  refine: "refine",
  refineApply: "refine-apply",
  start: "start",
  form: "form",
  new: "new",
  draftAsk: "draft-ask",
  draft: "draft",
  link: "link",
  fixBranch: "fix-branch",
};

/** reads: shared while running and lasting failures remembered; the rest are writes */
export const STORY_READS: StoryCommand[] = ["settings", "projects", "teams", "areas", "iterations", "list", "board", "show", "refine", "form", "draft"];

/** what each command needs (the caller gets badInput without it) */
const REQUIRED: Partial<Record<StoryCommand, string[]>> = {
  saveSettings: ["project"],
  list: ["view"],
  show: ["id"],
  move: ["id", "rev"],
  edit: ["id", "rev"],
  task: ["id", "done"],
  addTask: ["parent", "title"],
  comment: ["id", "markdown"],
  refineAsk: ["id"],
  refine: ["id"],
  refineApply: ["id", "rev", "parts"],
  start: ["id"],
  new: ["type", "title"],
  draftAsk: ["type", "title"],
  draft: ["draftFile"],
  link: ["id"],
  fixBranch: ["id"],
};

/** object key -> CLI flag where the name differs */
const FLAG: Record<string, string> = { areaPath: "area", iterationPath: "iteration", draftFile: "draft-file" };
/** list values joined with ";" (tags); other lists with "," */
const SEMI = new Set(["tags"]);
/** text that goes in a private file: key -> flag */
const FILES: Record<string, string> = { sections: "sections-file", systemInfo: "system-info-file", markdown: "text-file", notes: "notes-file" };
const SKIP = new Set(["done", "assignToMe", "save"]);

const kebab = (k: string) => FLAG[k] ?? k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const given = (v: unknown) => v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "") && !(Array.isArray(v) && !v.length);

/** `[{heading, markdown}]` or a markdown text -> the `## heading` markdown the CLI reads */
export function sectionsText(v: unknown): string {
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) throw new Error("sections is a list of { heading, markdown }");
  return v.map((x: { heading?: string; markdown?: string }) => `## ${String(x?.heading ?? "").trim()}\n\n${String(x?.markdown ?? "").trim()}\n`).join("\n");
}

export interface StoryCall {
  args: string[];
  /** the temporary folder of the text files; remove with removeStoryFiles */
  dir?: string;
}

/** The `aihub stories ...` arguments of a command; throws on a missing required argument (the caller turns it into badInput). */
export function storyArgs(cmd: StoryCommand, a: Record<string, unknown> = {}): StoryCall {
  const arg = a ?? {};
  for (const k of REQUIRED[cmd] ?? []) if (!given(arg[k])) throw new Error(`${cmd} needs ${k}`);
  // a move goes to a state or to a board column (columns can share a state)
  if (cmd === "move" && !given(arg.to) && !given(arg.column)) throw new Error("move needs to or column");
  const args = ["stories", STORY_SUBS[cmd]];
  if (cmd === "saveSettings") args.push("--save");
  if (cmd === "task") args.push(arg.done ? "--done" : "--undone");
  if (cmd === "start" && arg.assignToMe === false) args.push("--no-assign");
  let dir: string | undefined;
  for (const [k, v] of Object.entries(arg)) {
    if (SKIP.has(k) || !given(v)) continue;
    if (FILES[k]) {
      dir ??= mkdtempSync(join(tmpdir(), "aihub-story-"));
      const f = join(dir, `${k}.md`);
      writeFileSync(f, k === "sections" ? sectionsText(v) : String(v), { encoding: "utf8", mode: 0o600 });
      args.push(`--${FILES[k]}`, f);
    } else if (typeof v === "boolean") {
      if (v) args.push(`--${kebab(k)}`);
    } else if (Array.isArray(v)) args.push(`--${kebab(k)}`, v.map(String).join(SEMI.has(k) ? ";" : ","));
    else args.push(`--${kebab(k)}`, String(v));
  }
  return { args, dir };
}

export function removeStoryFiles(dir: string | undefined): void {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the temp folder is cleaned by the OS */
  }
}

/** the failure-memory scope: per organisation and project */
export const storyScope = (a: { org?: string; project?: string } | undefined) => ["stories", a?.org ?? "", a?.project ?? ""].join("|").toLowerCase();

/** the command id of each story command: aihub.bar.story<Name> */
export const storyCommandId = (cmd: StoryCommand) => `aihub.bar.story${cmd[0].toUpperCase()}${cmd.slice(1)}`;
