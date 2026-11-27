import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrowseError } from "../browse/core.js";
import type { Ctx } from "../context.js";
import { readState, setFolderOf, stateFile, writeState, type RunState } from "./state.js";

/** The progress of a run, written by the agent (`aihub story progress`) and read by the bar for its badge. */
export function progress(ctx: Ctx, o: { id: number; step?: number; total?: number; label?: string; steps?: string[]; done?: boolean; action?: string }): RunState & { stateFile: string } {
  const file = stateFile(ctx, o.id, "run");
  const now = new Date((ctx.now ?? Date.now)()).toISOString();
  const cur = readState<RunState>(file, { schema: 1, id: o.id, running: false, step: 0, total: 0, label: "", steps: [], updatedAt: "" });
  const writing = o.step !== undefined || o.total !== undefined || o.label !== undefined || o.steps !== undefined || o.done || o.action !== undefined;
  if (!writing) return { ...cur, stateFile: file };
  const next: RunState = { ...cur, id: o.id, updatedAt: now };
  if (o.steps?.length) next.steps = o.steps;
  if (o.total !== undefined) next.total = o.total;
  if (o.step !== undefined) {
    if (o.step < 1) throw new BrowseError("badInput", "--step starts at 1");
    next.step = o.step;
    next.running = true;
  }
  if (o.label !== undefined) next.label = o.label;
  if (o.action !== undefined) next.action = o.action;
  if (!next.total) next.total = Math.max(next.steps.length, next.step);
  if (next.step && next.label && next.steps.length < next.step) {
    // a step that was not announced in --steps joins the list
    next.steps = [...next.steps, ...Array(next.step - next.steps.length - 1).fill(""), next.label];
  }
  if (o.done) {
    next.running = false;
    next.step = next.total;
  }
  writeState(file, next);
  return { ...next, stateFile: file };
}

/** The steps with their state for the bar's menu: done, running (the current one) and queued. */
export function stepsView(r: RunState): { label: string; state: "done" | "running" | "queued" }[] {
  const n = Math.max(r.total, r.steps.length);
  return Array.from({ length: n }, (_, i) => ({ label: r.steps[i] || `${i + 1}`, state: i + 1 < r.step || (!r.running && r.step >= i + 1) ? "done" : i + 1 === r.step && r.running ? "running" : "queued" }));
}

// ---- YOLO: the opencode permissions of a set folder, inside the fixed limits -----------------------------------------

/**
 * In YOLO mode opencode does not ask before an edit or a command, except for what crosses the limits: those stay
 * refused. The rules go into `opencode.json` in the set folder (opencode reads it from the folder it starts in). Without
 * YOLO the file is removed again (only when it is still ours). Patterns are opencode's bash wildcards.
 */
export const LIMIT_DENY = [
  "git push * main*",
  "git push * master*",
  "git push * staging*",
  "git push *:main*",
  "git push *:staging*",
  "git push --force*",
  "git push -f*",
  "git push * --force*",
  "git push * -f *",
  "git merge *",
  "git rebase * main",
  "aihub pr complete*",
  "aihub cherry-pick*--direct*",
  "aihub release run*",
  "aihub fabric deployment deploy*",
  "aihub fabric * --allow-env*",
  "az repos pr update*",
  "az pipelines release*",
];

export function yoloConfig(): Record<string, unknown> {
  return {
    $schema: "https://opencode.ai/config.json",
    permission: {
      edit: "allow",
      webfetch: "allow",
      bash: { "*": "allow", ...Object.fromEntries(LIMIT_DENY.map((p) => [p, "deny"])) },
    },
  };
}

const MARK = ".aihub-yolo.json";

export function yolo(ctx: Ctx, o: { on: boolean; folder?: string }): { yolo: boolean; folder: string; file: string; note?: string } {
  const folder = o.folder ?? setFolderOf(ctx.cwd);
  if (!folder) throw new BrowseError("badInput", "YOLO works in the folder of a story set; open the set first (or pass --folder)");
  const file = join(folder, "opencode.json");
  const mark = join(folder, MARK);
  const text = JSON.stringify(yoloConfig(), null, 2) + "\n";
  if (o.on) {
    if (existsSync(file) && !existsSync(mark) && readFileSync(file, "utf8") !== text) throw new BrowseError("badInput", `${file} exists and is not from aihub; YOLO leaves it alone`);
    writeFileSync(file, text, "utf8");
    writeFileSync(mark, JSON.stringify({ schema: 1, on: new Date((ctx.now ?? Date.now)()).toISOString() }) + "\n", "utf8");
    return { yolo: true, folder, file };
  }
  if (!existsSync(file)) {
    rmSync(mark, { force: true });
    return { yolo: false, folder, file };
  }
  if (readFileSync(file, "utf8") === text) {
    rmSync(file, { force: true });
    rmSync(mark, { force: true });
    return { yolo: false, folder, file };
  }
  return { yolo: existsSync(mark), folder, file, note: `${file} was changed by hand; remove it yourself to switch YOLO off` };
}
