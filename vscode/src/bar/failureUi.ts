import * as vscode from "vscode";
import { plainError } from "./plainError";

/** A failure of git or of the CLI as one plain sentence, with "Show Details" for the original text. `lead` says what was being done. */
export function showFailure(e: unknown, lead = "", level: "error" | "warning" = "error"): void {
  const plain = plainError(e instanceof Error ? e.message : String(e));
  const text = `AI Context Hub: ${lead ? `${lead}: ` : ""}${plain.text}.`;
  const show = level === "error" ? vscode.window.showErrorMessage : vscode.window.showWarningMessage;
  void show(text, "Show Details").then((pick) => {
    if (pick === "Show Details") void vscode.window.showInformationMessage("AI Context Hub: details", { modal: true, detail: plain.details });
  });
}
