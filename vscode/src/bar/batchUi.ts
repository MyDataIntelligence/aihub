import * as vscode from "vscode";
import { forgetScan } from "../../../cli/src/lib/machineScan";
import { createPullRequests, prOffers } from "./createPrs";
import { targetOf } from "./repoStatus";
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
    const results = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Pushing ${repos.length} ${repos.length === 1 ? "repository" : "repositories"}...` }, () => eachRepo(repos, (r) => pushOne(gitRun, r, targetOf(r.path, r.name))));
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

/** Create Pull Requests: a quick pick with ticks (only repositories on a story branch without a pull request are ticked), then one aihub pr create per repository. */
export function registerPullRequestCommand(h: StoryHooks): void {
  h.reg("aihub.bar.createPullRequests", async (arg?: { repos?: string[] }) => {
    // the build of each open pull request is read now (one policy read per open pull request), so the reasons are right
    await h.refreshPrs?.();
    const state = await h.engine.state({ refresh: false });
    if (state.mode !== "set" || !state.story) return void vscode.window.showInformationMessage("AI Context Hub: this window does not show a story set.");
    const offers = prOffers(state.repos);
    type Row = vscode.QuickPickItem & { offer?: ReturnType<typeof prOffers>[number] };
    const rows: Row[] = [
      ...offers.filter((o) => o.enabled).map((o) => ({ label: o.repo, description: o.branch, detail: o.reason, picked: o.picked && (!arg?.repos || arg.repos.includes(o.repo)), offer: o })),
      ...(offers.some((o) => !o.enabled) ? [{ label: "Not offered", kind: vscode.QuickPickItemKind.Separator } as Row] : []),
      ...offers.filter((o) => !o.enabled).map((o) => ({ label: o.repo, description: o.reason, detail: o.branch, offer: o })),
    ];
    if (!offers.some((o) => o.enabled)) return void vscode.window.showInformationMessage(`AI Context Hub: no pull request to make. ${offers.map((o) => `${o.repo}: ${o.reason}`).join("; ")}`);
    const chosen = await vscode.window.showQuickPick(rows, { title: `Create Pull Requests for #${state.story.id}`, placeHolder: "Tick the repositories; Enter creates one pull request each", canPickMany: true });
    const picked = (chosen ?? []).filter((c) => c.offer?.enabled).map((c) => ({ name: c.offer!.repo, path: c.offer!.path, target: targetOf(c.offer!.path, c.offer!.repo) }));
    if (!picked.length) return [];
    const { results, linked } = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Creating ${picked.length} pull request${picked.length === 1 ? "" : "s"}...` }, () => createPullRequests(cli, picked, state.story!.id));
    await report(h, "Create pull requests", results.map((r) => ({ repo: r.repo, ok: r.ok, line: r.line, detail: r.url })));
    if (linked) h.log(`create pull requests: ${linked}`);
    return results;
  });
}
