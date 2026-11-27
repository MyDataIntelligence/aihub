import * as vscode from "vscode";
import { forgetScan } from "../../../cli/src/lib/machineScan";
import { createPullRequests, madeLinks, prOffers } from "./createPrs";
import { protectedBranches, targetInfo } from "./repoStatus";

/** The target to pass as --target: only when team.yaml or the set file names it; else the CLI derives its own. */
const sureTarget = (path: string, name: string): string | undefined => {
  const t = targetInfo(path, name, { setFolder: openFacts(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath).set?.folder });
  return t.sure ? t.target : undefined;
};
import { commitOne, eachRepo, offlineSummary, parseMessage, pushOne, summarize, updateOne, type RepoRef, type RepoResult } from "./batch";
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

async function report(h: StoryHooks, what: string, results: RepoResult[], links: string[] = []): Promise<void> {
  const text = summarize(what, results);
  h.log(`${text}\n${results.filter((r) => r.detail).map((r) => `--- ${r.repo}\n${r.detail}`).join("\n")}`);
  forgetScan(process.env);
  h.afterGit?.();
  h.changed();
  const bad = results.filter((r) => !r.ok);
  const offline = offlineSummary(what, results);
  if (offline) return void vscode.window.showInformationMessage(`AI Context Hub: ${offline}`);
  // links (pull requests that were made): one button opens them all in the browser
  const open = links.length ? (links.length === 1 ? "Open Pull Request" : "Open Pull Requests") : undefined;
  const openAll = () => links.forEach((l) => void vscode.env.openExternal(vscode.Uri.parse(l)));
  if (!bad.length) {
    const picked = await vscode.window.showInformationMessage(`AI Context Hub: ${text.split("\n")[0]}`, ...(open ? [open] : []));
    if (picked && picked === open) openAll();
    return;
  }
  const more = "Show Details";
  const pick = await vscode.window.showWarningMessage(`AI Context Hub: ${text.split("\n")[0]}. ${bad.map((r) => r.line).join("; ")}`, ...(open ? [open] : []), more);
  if (pick && pick === open) openAll();
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
    // only the repositories that are on a story branch of the set, each pushed as <its branch> -> origin/<its branch>; never main, master, the target or a protected branch
    const state = await h.engine.state();
    const story = new Set(state.repos.filter((r) => r.storyBranch).map((r) => r.name.toLowerCase()));
    const all = reposOf(arg?.repos);
    const repos = all.filter((r) => story.has(r.name.toLowerCase()));
    const left = all.filter((r) => !story.has(r.name.toLowerCase())).map((r) => ({ repo: r.name, ok: true, line: `${r.name}: not on a story branch of the set, left alone` }));
    if (!all.length) return [];
    const setFolder = openFacts(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath).set?.folder;
    const done = repos.length
      ? await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Pushing ${repos.length} ${repos.length === 1 ? "repository" : "repositories"}...` }, () =>
          eachRepo(repos, (r) => pushOne(gitRun, r, { protect: ["main", "master", targetInfo(r.path, r.name, { setFolder }).target, ...protectedBranches(r.path)] })),
        )
      : [];
    const results = [...done, ...left];
    await report(h, "Push all", results);
    return results;
  });

  h.reg("aihub.bar.commitAll", async (arg?: { message?: string; repos?: (string | { name: string; files?: string[] })[]; push?: boolean }) => {
    // only what is named: a repository that is not in the list is never touched; without a list the user ticks the repositories that have changes
    let named = (arg?.repos ?? []).map((x) => (typeof x === "string" ? { name: x } : x));
    if (!named.length) {
      const state = await h.engine.state();
      const changed = state.repos.filter((r) => (r.changes ?? r.dirty ?? 0) > 0);
      if (!changed.length) return void vscode.window.showInformationMessage("AI Context Hub: no repository of this window has changes to commit.");
      type Row = vscode.QuickPickItem & { name: string };
      const rows: Row[] = changed.map((r) => ({ label: r.name, description: `${r.changes ?? r.dirty} changed file${(r.changes ?? r.dirty) === 1 ? "" : "s"} on ${r.branch}`, picked: true, name: r.name }));
      const chosen = await vscode.window.showQuickPick(rows, { title: "Commit: which repositories?", placeHolder: "Tick the repositories to commit; every change of a ticked repository is committed", canPickMany: true });
      named = (chosen ?? []).map((c) => ({ name: c.name }));
      if (!named.length) return [];
    }
    const byName = new Map(named.map((n) => [n.name.toLowerCase(), n.files]));
    const repos = reposOf(named.map((n) => n.name)).map((r) => ({ ...r, files: byName.get(r.name.toLowerCase()) }));
    if (!repos.length) return [];
    let message = arg?.message?.trim();
    if (!message) {
      message = (await vscode.window.showInputBox({ title: `Commit ${repos.length} ${repos.length === 1 ? "repository" : "repositories"}`, prompt: "One message for every ticked repository (feat: what changed)", validateInput: (v) => (v.trim() ? undefined : "Enter a message") }))?.trim();
      if (!message) return [];
    }
    const results = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Committing..." }, () => eachRepo(repos, (r) => commitOne(cli, r, message!, !!arg?.push, gitRun), 1));
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
    const picked = (chosen ?? []).filter((c) => c.offer?.enabled).map((c) => ({ name: c.offer!.repo, path: c.offer!.path, target: sureTarget(c.offer!.path, c.offer!.repo) }));
    // closed without a choice (Escape, focus elsewhere): nothing, as a cancel; confirmed with nothing ticked: say so
    if (!chosen) return [];
    if (!picked.length) return void vscode.window.showInformationMessage("AI Context Hub: no repository was ticked, so no pull request was made."), [];
    h.log(`create pull requests: ${picked.map((p) => p.name).join(", ")}`);
    const { results, linked } = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Creating ${picked.length} pull request${picked.length === 1 ? "" : "s"}` }, (progress) => createPullRequests(cli, picked, state.story!.id, (text) => progress.report({ message: text })));
    if (linked) h.log(`create pull requests: ${linked}`);
    // the new pull requests on the buttons and in the overview ("none yet" and "2 missing" go), then the message with the links
    void h.refreshPrs?.().then(() => h.changed(), () => undefined);
    await report(h, "Create pull requests", results.map((r) => ({ repo: r.repo, ok: r.ok, line: r.line, detail: r.url })), madeLinks(results));
    return results;
  });
}
