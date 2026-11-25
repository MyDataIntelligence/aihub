import { existsSync, readFileSync } from "node:fs";
import * as vscode from "vscode";
import { forgetScan, headBranchOf } from "../../../cli/src/lib/machineScan";
import { gitRun } from "./ownWindow";
import { newBackups, planUndo, runUndo, takeSnapshot, type Snapshot } from "./undo";
import type { StoryHooks } from "./storyUi";

/** The one thing that can be undone: the last action that changed a set. The next action replaces it. */
let last: { label: string; snap: Snapshot } | undefined;
export const undoLabel = (): string | undefined => last?.label;

/** Did the action change what a snapshot holds (set files, branches, worktree folders)? Files only. */
function differs(s: Snapshot): boolean {
  const filesChanged = s.files.some((f) => (existsSync(f.path) ? !f.bytes || !readFileSync(f.path).equals(f.bytes) : !!f.bytes));
  return filesChanged || s.repos.some((r) => !existsSync(r.path) || (headBranchOf(r.path) || undefined) !== r.branch);
}

/**
 * Runs `run` (an action that changes the set) with a snapshot before it. When something changed, one message with Undo
 * (and, after a removal, Show Backup) follows, and the state offers "Undo: <label>" until the next action.
 */
export async function withUndo<T>(h: StoryHooks, label: string, setFolder: string | undefined, run: () => Promise<T>, o: { backup?: boolean } = {}): Promise<T> {
  const snap = setFolder ? await takeSnapshot(gitRun, setFolder, label).catch(() => undefined) : undefined;
  const result = await run();
  if (!snap || !differs(snap)) return result;
  last = { label, snap };
  h.changed();
  const undo = "Undo";
  const show = "Show Backup";
  const backups = o.backup ? newBackups(snap) : [];
  void vscode.window.showInformationMessage(`AI Context Hub: ${label}.`, undo, ...(backups.length ? [show] : [])).then((pick) => {
    if (pick === undo) void undoLast(h);
    if (pick === show) void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(backups[0].dir));
  });
  return result;
}

/** Puts the set back as it was before the last action, or says in one sentence why it cannot and does nothing. */
export async function undoLast(h: StoryHooks): Promise<boolean> {
  if (!last) {
    void vscode.window.showInformationMessage("AI Context Hub: nothing to undo.");
    return false;
  }
  const { label, snap } = last;
  const plan = await planUndo(gitRun, snap);
  if (plan.problem) {
    void vscode.window.showWarningMessage(`AI Context Hub: cannot undo "${label}": ${plan.problem}. Nothing was changed.`);
    return false;
  }
  const res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Undoing ${label}...` }, () => runUndo(plan));
  h.log(`undo ${label}: ${res.lines.join(" | ")}`);
  forgetScan(process.env);
  if (res.ok) last = undefined;
  h.afterGit?.();
  h.changed();
  void (res.ok ? vscode.window.showInformationMessage(`AI Context Hub: undone: ${label}.`) : vscode.window.showWarningMessage(`AI Context Hub: ${res.lines[res.lines.length - 1]}`));
  return res.ok;
}

export function registerUndoCommand(h: StoryHooks): void {
  h.reg("aihub.bar.undoLast", () => undoLast(h));
}
