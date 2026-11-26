import { existsSync } from "node:fs";
import * as vscode from "vscode";
import { forgetScan } from "../../../cli/src/lib/machineScan";
import { pathKey } from "../../../cli/src/lib/recentUse";
import { readSetFile } from "../../../cli/src/lib/setFile";
import { openFacts } from "./engine";
import { gitRun } from "./ownWindow";
import { plainPath } from "./paths";
import { relinkWorktree } from "./relink";
import type { StoryHooks } from "./storyUi";

/** A worktree whose source clone is gone: find the clone again, or use another clone of the repository. */
export function registerCloneCommands(h: StoryHooks): void {
  const context = (arg: unknown) => {
    const wt = typeof arg === "string" ? arg : (arg as { path?: string } | undefined)?.path;
    const set = openFacts(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath).set;
    const file = set ? readSetFile(set.folder) : undefined;
    const entry = file && [file.top, ...(file.top.others ?? [])].flatMap((m) => m.repos).find((r) => wt && pathKey(r.path) === pathKey(wt));
    return set && wt && entry ? { setFolder: set.folder, worktree: wt, repo: entry.name, source: entry.source } : undefined;
  };
  const apply = async (c: NonNullable<ReturnType<typeof context>>, newSource: string) => {
    const r = await relinkWorktree(gitRun, { setFolder: c.setFolder, worktree: c.worktree, repo: c.repo, newSource });
    if (r.problem) return void vscode.window.showWarningMessage(`AI Context Hub: ${r.problem}. Nothing was changed.`);
    forgetScan(process.env);
    h.changed();
    void vscode.window.showInformationMessage(`AI Context Hub: ${c.repo} uses the clone at ${plainPath(newSource)} now.`);
  };

  h.reg("aihub.bar.locateClone", async (arg?: unknown) => {
    const c = context(arg);
    if (!c) return void vscode.window.showInformationMessage("AI Context Hub: this window does not show that repository of a set.");
    const pick = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title: `Where is the clone of ${c.repo} now?`, openLabel: "Use This Clone" });
    if (pick?.[0]) await apply(c, pick[0].fsPath);
  });

  h.reg("aihub.bar.useAnotherClone", async (arg?: unknown) => {
    const c = context(arg);
    if (!c) return void vscode.window.showInformationMessage("AI Context Hub: this window does not show that repository of a set.");
    const mine = (await h.engine.repositories()).find((r) => r.name.toLowerCase() === c.repo.toLowerCase());
    const others = (mine?.clones ?? (mine ? [{ path: mine.path, branch: mine.branch }] : [])).filter((x) => existsSync(x.path) && pathKey(x.path) !== pathKey(c.source ?? ""));
    if (!others.length) return void vscode.window.showInformationMessage(`AI Context Hub: there is no other clone of ${c.repo} on this PC. Use Locate the Clone, or remove it from the set.`);
    const chosen = await vscode.window.showQuickPick(others.map((x) => ({ label: plainPath(x.path), description: x.branch, path: x.path })), { title: `Another clone of ${c.repo}` });
    if (chosen) await apply(c, chosen.path);
  });
}
