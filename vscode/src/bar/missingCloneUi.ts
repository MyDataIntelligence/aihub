import * as vscode from "vscode";
import { setPreferredClone } from "./hiddenClones";
import { missingCloneRepo, whyNotTheClone } from "./missingClone";

export interface RecoveryUi {
  warn: (text: string, ...buttons: string[]) => Thenable<string | undefined>;
  pickFolder: (repo: string) => Thenable<string | undefined>;
  remember: (repo: string, dir: string) => void;
}

const CHOOSE = "Choose Folder…";

const realUi: RecoveryUi = {
  warn: (text, ...buttons) => vscode.window.showWarningMessage(text, ...buttons),
  pickFolder: async (repo) => {
    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: "Use This Folder", title: `Choose the clone of ${repo}` });
    return picked?.[0]?.fsPath;
  },
  remember: (repo, dir) => setPreferredClone(process.env, repo, dir),
};

/**
 * Runs an action of the bar. When it fails because the clone of a repository cannot be found, asks once with one message and a
 * "Choose Folder…" button; a folder is accepted only when it is a clone of that repository, then remembered (the same preference as
 * `aihub repos prefer`) and the action is repeated once. Any other failure is thrown as it was.
 */
export async function withCloneRecovery<T>(run: () => Promise<T>, ui: RecoveryUi = realUi): Promise<T | undefined> {
  try {
    return await run();
  } catch (e) {
    const repo = missingCloneRepo(e);
    if (!repo) throw e;
    const pick = await ui.warn(`AI Context Hub: Can't find the clone of ${repo}.`, CHOOSE);
    if (pick !== CHOOSE) return undefined;
    const dir = await ui.pickFolder(repo);
    if (!dir) return undefined;
    const why = whyNotTheClone(dir, repo);
    if (why) {
      void ui.warn(`AI Context Hub: ${why}`);
      return undefined;
    }
    ui.remember(repo, dir);
    return run();
  }
}
