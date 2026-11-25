import * as vscode from "vscode";

const cfg = () => vscode.workspace.getConfiguration("aiContextHub");

export const windowIsEmpty = (): boolean => !vscode.workspace.workspaceFolders?.length;

/** An empty window is reused (like PyCharm's welcome screen); else the setting decides (default: a new window). */
export const windowChoice = (): "new" | "this" => (windowIsEmpty() || cfg().get<string>("openIn", "new") === "this" ? "this" : "new");

export async function openPath(path: string, how: "auto" | "new" | "this" = "auto"): Promise<void> {
  const target = how === "auto" ? windowChoice() : how;
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(path), target === "this" ? { forceReuseWindow: true } : { forceNewWindow: true });
}
