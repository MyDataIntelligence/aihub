import { existsSync, readFileSync } from "node:fs";
import * as vscode from "vscode";
import { forgetScan, headBranchOf } from "../../../cli/src/lib/machineScan";
import { gitRun } from "./ownWindow";
import { holdNotices } from "./notice";
import { plainPathsIn } from "./paths";
import { finishSnapshot, newBackups, planUndo, runUndo, takeSnapshot, type Snapshot } from "./undo";
import { clearUndo, loadUndo, saveUndo, undoLabelOf } from "./undoStore";
import { openFacts } from "./engine";
import type { StoryHooks } from "./storyUi";

/** The one thing that can be undone: the last action that changed a set. The next action replaces it. */
let last: { label: string; at: number; snap?: Snapshot; custom?: () => Promise<{ problem?: string }> } | undefined;

/** An undo that is not a snapshot of a set (an update from the target branch): `run` puts it back or says why not. */
export function setCustomUndo(h: StoryHooks, label: string, run: () => Promise<{ problem?: string }>): void {
  last = { label, at: Date.now(), custom: run };
  h.changed();
}

/** What the buttons show: the undo of the set this window shows, from the file every window reads (else what this window did to another set). */
export const undoLabel = (setFolder?: string): string | undefined => {
  const kept = setFolder ? loadUndo(process.env, setFolder) : undefined;
  return kept && (!last || kept.savedAt >= last.at) ? kept.label : last?.label;
};

/** Did the action change what a snapshot holds (set files, branches, worktree folders)? Files only. */
function differs(s: Snapshot): boolean {
  const filesChanged = s.files.some((f) => (existsSync(f.path) ? !f.bytes || !readFileSync(f.path).equals(f.bytes) : !!f.bytes));
  return filesChanged || s.repos.some((r) => !existsSync(r.path) || (headBranchOf(r.path) || undefined) !== r.branch);
}

/**
 * Runs `run` (an action that changes the set) with a snapshot before it. When something changed, one message with Undo
 * (and, after a removal, Show Backup) follows, and the state offers "Undo: <label>" until the next action.
 */
export async function withUndo<T>(h: Pick<StoryHooks, "changed" | "log" | "afterGit">, label: string, setFolder: string | undefined, run: () => Promise<T>, o: { backup?: boolean; files?: { path: string; bytes?: Buffer }[]; sources?: string[]; only?: string[]; created?: (result: T) => string | undefined; message?: (result: T) => string; warn?: (result: T) => boolean } = {}): Promise<T> {
  const snap = setFolder !== undefined ? await takeSnapshot(gitRun, setFolder, label, { files: o.files, sources: o.sources, only: o.only }).catch(() => undefined) : undefined;
  const release = holdNotices();
  let result: T;
  let heldLines: string[] = [];
  try {
    result = await run();
  } finally {
    heldLines = release();
  }
  // one message per action, in plain words: what the open result said goes to the log
  const text = o.message?.(result) ?? "";
  const say = (buttons: string[]): Thenable<string | undefined> | undefined => {
    const line = text || (o.message ? "" : heldLines[0] ?? "");
    if (!line) return undefined;
    return (o.warn?.(result) ? vscode.window.showWarningMessage : vscode.window.showInformationMessage)(`AI Context Hub: ${plainPathsIn(line)}`, ...buttons);
  };
  for (const l of heldLines) h.log(l);
  // a set the action made: its folder is known only now
  if (snap && o.created) snap.setFolder = o.created(result) ?? snap.setFolder;
  if (!snap || (snap.setFolder ? !differs(snap) && !(o.created && existsSync(snap.setFolder)) : true)) {
    void say([]);
    return result;
  }
  // how the set looks right after the action, and the branches the action made: Undo only goes back to exactly this
  finishSnapshot(snap);
  last = { label, at: Date.now(), snap };
  // on disk too, per set: every window on the set shows the same Undo and there is only ever one
  try {
    saveUndo(process.env, label, snap);
  } catch (e) {
    h.log(`undo not saved to disk: ${(e as Error).message}`);
  }
  h.changed();
  const undo = "Undo";
  const show = "Show Backup";
  const backups = o.backup ? newBackups(snap) : [];
  const buttons = [undo, ...(backups.length ? [show] : [])];
  const shown = o.message || heldLines.length ? say(buttons) : vscode.window.showInformationMessage(`AI Context Hub: ${label}.`, ...buttons);
  void shown?.then((pick) => {
    if (pick === undo) void undoLast(h);
    if (pick === show) void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(backups[0].dir));
  });
  return result;
}

/** Puts the set back as it was before the last action, or says in one sentence why it cannot and does nothing. */
export async function undoLast(h: Pick<StoryHooks, "changed" | "log" | "afterGit">): Promise<boolean> {
  // the undo of this window's set from the file (made by this window or another), unless this window made a newer one itself
  const folder = openFacts(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath).set?.folder;
  const kept = folder ? loadUndo(process.env, folder) : undefined;
  const entry = kept && (!last || kept.savedAt >= last.at) ? { label: kept.label, snap: kept.snap, custom: undefined } : last;
  if (!entry) {
    void vscode.window.showInformationMessage("AI Context Hub: nothing to undo.");
    return false;
  }
  const { label, snap, custom } = entry;
  const done = () => {
    last = undefined;
    if (snap?.setFolder) clearUndo(process.env, snap.setFolder);
    if (folder) clearUndo(process.env, folder);
  };
  if (custom) {
    const r = await custom();
    if (r.problem) {
      void vscode.window.showWarningMessage(`AI Context Hub: cannot undo "${label}": ${plainPathsIn(r.problem)}. Nothing was changed.`);
      return false;
    }
    done();
    forgetScan(process.env);
    h.afterGit?.();
    h.changed();
    void vscode.window.showInformationMessage(`AI Context Hub: undone: ${label}.`);
    return true;
  }
  const plan = await planUndo(gitRun, snap!);
  if (plan.problem) {
    void vscode.window.showWarningMessage(`AI Context Hub: cannot undo "${label}": ${plainPathsIn(plan.problem)}. Nothing was changed.`);
    return false;
  }
  const res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Undoing ${label}...` }, () => runUndo(plan));
  h.log(`undo ${label}: ${res.lines.join(" | ")}`);
  forgetScan(process.env);
  if (res.ok) done();
  h.afterGit?.();
  h.changed();
  void (res.ok ? vscode.window.showInformationMessage(`AI Context Hub: undone: ${label}.`) : vscode.window.showWarningMessage(`AI Context Hub: ${plainPathsIn(res.lines[res.lines.length - 1])}`));
  return res.ok;
}

export function registerUndoCommand(h: StoryHooks): void {
  h.reg("aihub.bar.undoLast", () => undoLast(h));
}
