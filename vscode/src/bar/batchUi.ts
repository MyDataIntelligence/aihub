import * as vscode from "vscode";
import { forgetScan } from "../../../cli/src/lib/machineScan";
import { commitOne, eachRepo, parseMessage, pushOne, summarize, updateOne, type RepoRef, type RepoResult } from "./batch";
import { openFacts } from "./engine";
import { gitRun } from "./ownWindow";
import { cli } from "./runner";
import type { StoryHooks } from "./storyUi";

/** The repositories of the set this window shows (or its one repository), by name or all. */
function reposOf(names?: string[]): RepoRef[] {
  const f = openFacts(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
  const all: RepoRef[] = f.set ? f.set.repos.map((r) => ({ name: r.name, path: r.path })) : f.repo ? [{ name: f.repo.name, path: f.repo.path }] : [];
  if (!names?.length) return all;
  const want = new Set(names.map((n) => n.toLowerCase()));
  return all.filter((r) => want.has(r.name.toLowerCase()));
}

async function report(h: StoryHooks, what: string, results: RepoResult[]): Promise<void> {
  const text = summarize(what, results);
  h.log(`${text}\n${results.filter((r) => r.detail).map((r) => `--- ${r.repo}\n${r.detail}`).join("\n")}`);
  forgetScan(process.env);
  h.afterGit?.();
  h.changed();
  const bad = results.filter((r) => !r.ok);
  if (!bad.length) return void vscode.window.showInformationMessage(`AI Context Hub: ${text.split("\n")[0]}`);
  const more = "Show Details";
  const pick = await vscode.window.showWarningMessage(`AI Context Hub: ${text.split("\n")[0]}. ${bad.map((r) => r.line).join("; ")}`, more);
  if (pick === more) void vscode.window.showWarningMessage(`${what}`, { modal: true, detail: bad.map((r) => `${r.line}\n${r.detail ?? ""}`).join("\n\n") });
}

/** Update all, Push all and Commit all of the open set: one result line per repository, a failing repository never stops the others. */
export function registerBatchCommands(h: StoryHooks): void {
  h.reg("aihub.bar.updateAll", async (arg?: { repos?: string[] }) => {
    const repos = reposOf(arg?.repos);
    if (!repos.length) return [];
    const results = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Updating ${repos.length} ${repos.length === 1 ? "repository" : "repositories"}...` }, () => eachRepo(repos, (r) => updateOne(gitRun, r)));
    await report(h, "Update all", results);
    return results;
  });

  h.reg("aihub.bar.pushAll", async (arg?: { repos?: string[] }) => {
    const repos = reposOf(arg?.repos);
    if (!repos.length) return [];
    const results = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Pushing ${repos.length} ${repos.length === 1 ? "repository" : "repositories"}...` }, () => eachRepo(repos, (r) => pushOne(gitRun, r)));
    await report(h, "Push all", results);
    return results;
  });

  h.reg("aihub.bar.commitAll", async (arg?: { message?: string; repos?: string[]; push?: boolean }) => {
    const repos = reposOf(arg?.repos);
    if (!repos.length) return [];
    let message = arg?.message?.trim();
    if (!message) {
      message = (await vscode.window.showInputBox({ title: `Commit ${repos.length} ${repos.length === 1 ? "repository" : "repositories"}`, prompt: "One message for every ticked repository (feat: what changed)", validateInput: (v) => (v.trim() ? undefined : "Enter a message") }))?.trim();
      if (!message) return [];
    }
    const results = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Committing..." }, () => eachRepo(repos, (r) => commitOne(cli, r, message!, !!arg?.push), 1));
    await report(h, arg?.push ? "Commit and push all" : "Commit all", results);
    return results;
  });
}

export { parseMessage };
