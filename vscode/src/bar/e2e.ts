import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Run End to End and the agent actions per story: the aihub.bar.storyAction / storyPrompt* / storyRunState /
 * criteria* commands. Pure helpers here (arguments, the pending action of a set that opens in another window); the
 * VS Code side is e2eUi.ts. The JSON shapes are in docs/cli-json.md ("Run End to End").
 */

export const STORY_ACTIONS = [
  "story-start",
  "story-run",
  "story-criteria",
  "story-refine",
  "story-test-fabric",
  "story-tests",
  "story-pr",
  "story-review",
  "story-fix-pipeline",
  "story-explain",
  "bug-reproduce",
  "bug-fix-e2e",
] as const;
export type StoryAction = (typeof STORY_ACTIONS)[number];

export function checkStoryAction(a: unknown): StoryAction {
  const x = String(a ?? "").trim().replace(/^\//, "");
  if (!(STORY_ACTIONS as readonly string[]).includes(x)) throw new Error(`unknown action '${String(a ?? "")}'; one of: ${STORY_ACTIONS.join(", ")}`);
  return x as StoryAction;
}

const posInt = (n: unknown): number | undefined => (typeof n === "number" && Number.isInteger(n) && n > 0 ? n : typeof n === "string" && /^\d+$/.test(n) && Number(n) > 0 ? Number(n) : undefined);

export function idOf(a: { id?: unknown } | undefined): number {
  const id = posInt(a?.id);
  if (!id) throw new Error("a work item id is needed ({ id })");
  return id;
}

/** The slash command the agent gets: `/story-run 4711`. */
export const slashCommand = (action: StoryAction, id: number) => `/${action} ${id}`;

const scope = (a: { org?: string; project?: string; team?: string } | undefined, out: string[]) => {
  if (a?.org) out.push("--org", a.org);
  if (a?.project) out.push("--project", a.project);
  if (a?.team) out.push("--team", a.team);
  return out;
};

/** The `aihub ...` arguments of each read or write; throws on a missing argument (the caller answers badInput). */
export const e2eArgs = {
  prompt: (a: { id?: unknown; action?: unknown; org?: string; project?: string }) => scope(a, ["prompt", "render", checkStoryAction(a?.action), "--id", String(idOf(a)), "--json"]),
  prompts: (a: { org?: string; project?: string } = {}) => scope(a, ["prompt", "list", "--json"]),
  promptReset: (a: { id?: unknown; action?: unknown; org?: string; project?: string }) => scope(a, ["prompt", "reset", checkStoryAction(a?.action), "--id", String(idOf(a)), "--json"]),
  runState: (a: { id?: unknown; org?: string; project?: string }) => scope(a, ["story", "progress", "--id", String(idOf(a)), "--json"]),
  criteriaStatus: (a: { id?: unknown; org?: string; project?: string }) => scope(a, ["criteria", "status", "--id", String(idOf(a)), "--json"]),
  criteriaProposal: (a: { id?: unknown; org?: string; project?: string }) => scope(a, ["criteria", "proposal", "--id", String(idOf(a)), "--json"]),
  criteriaApply: (a: { id?: unknown; rev?: unknown; take?: unknown; org?: string; project?: string }) => {
    const rev = posInt(a?.rev);
    if (!rev) throw new Error("criteriaApply needs rev");
    const take = Array.isArray(a?.take) ? a!.take.map(posInt).filter((x): x is number => !!x) : [];
    if (!take.length) throw new Error("criteriaApply needs take: the numbers of the proposed criteria to apply");
    return scope(a, ["criteria", "apply", "--id", String(idOf(a)), "--rev", String(rev), "--take", take.join(","), "--json"]);
  },
  open: (a: { id?: unknown }) => ["story", "open", "--id", String(idOf(a)), "--window", "none", "--existing", "reuse", "--json"],
  start: (a: { id?: unknown; repos?: unknown; org?: string; project?: string }) => {
    const out = scope(a, ["stories", "start", "--id", String(idOf(a)), "--open", "none"]);
    if (Array.isArray(a?.repos) && a!.repos.length) out.push("--repos", a!.repos.map(String).join(","));
    return out;
  },
  yolo: (folder: string, on: boolean) => ["story", "yolo", on ? "--on" : "--off", "--folder", folder, "--json"],
};

/** Edit Prompt: the text goes to the CLI in a private file, removed right after. */
export function promptSaveCall(a: { id?: unknown; action?: unknown; text?: unknown; org?: string; project?: string }): { args: string[]; dir: string } {
  const action = checkStoryAction(a?.action);
  const id = idOf(a);
  if (typeof a?.text !== "string" || !a.text.trim()) throw new Error("storyPromptSave needs text");
  const dir = mkdtempSync(join(tmpdir(), "aihub-prompt-"));
  const f = join(dir, "prompt.md");
  writeFileSync(f, a.text, { encoding: "utf8", mode: 0o600 });
  return { args: scope(a, ["prompt", "save", action, "--id", String(id), "--text-file", f, "--json"]), dir };
}

export function removeDir(dir: string | undefined): void {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the temp folder is cleaned by the OS */
  }
}

/** The answer of `story open` / `stories start`: the set's folder and its workspace file. */
export function setOf(answer: unknown): { folder: string; workspace?: string } | undefined {
  const j = answer as { folder?: string; workspace?: string; set?: { folder?: string; workspace?: string } };
  const folder = j?.set?.folder ?? j?.folder;
  if (!folder) return undefined;
  const workspace = j?.set?.workspace ?? j?.workspace;
  return { folder, ...(workspace ? { workspace } : {}) };
}

/** The story has no branches yet: Run starts it first (branches, set). */
export const needsStart = (message: string) => /has no branches yet/i.test(message);

// ---- the action for a set that opens in another window ---------------------------------------------------------------

export const PENDING_FILE = ".aihub-pending-action.json";
export const PENDING_MAX_AGE_MS = 2 * 60_000;

export interface PendingAction {
  id: number;
  action: StoryAction;
  command: string;
  at: number;
}

export function writePending(folder: string, p: PendingAction): void {
  writeFileSync(join(folder, PENDING_FILE), JSON.stringify(p) + "\n", "utf8");
}

/** The pending action of a set folder, taken away when read (once); an old one is dropped. One file read, no process. */
export function takePending(folder: string | undefined, now: number): PendingAction | undefined {
  if (!folder) return undefined;
  const f = join(folder, PENDING_FILE);
  if (!existsSync(f)) return undefined;
  let p: PendingAction | undefined;
  try {
    p = JSON.parse(readFileSync(f, "utf8")) as PendingAction;
  } catch {
    p = undefined;
  }
  try {
    rmSync(f, { force: true });
  } catch {
    /* a second window may have taken it */
  }
  if (!p || typeof p.command !== "string" || !/^\/[a-z-]+ \d+$/.test(p.command)) return undefined;
  return now - Number(p.at) <= PENDING_MAX_AGE_MS ? p : undefined;
}

/** The run state for the badge: the CLI's answer with its steps view under `steps`. */
export function runStateOf(answer: unknown): { id: number; running: boolean; step: number; total: number; label: string; steps: { label: string; state: string }[]; updatedAt: string; stateFile?: string } {
  const j = answer as { id: number; running?: boolean; step?: number; total?: number; label?: string; stepsView?: { label: string; state: string }[]; updatedAt?: string; stateFile?: string };
  return { id: j.id, running: !!j.running, step: j.step ?? 0, total: j.total ?? 0, label: j.label ?? "", steps: j.stepsView ?? [], updatedAt: j.updatedAt ?? "", ...(j.stateFile ? { stateFile: j.stateFile } : {}) };
}
