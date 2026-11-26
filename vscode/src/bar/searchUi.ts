import { existsSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { forgetScan, headBranchOf } from "../../../cli/src/lib/machineScan";
import { readSeenStories } from "../../../cli/src/lib/storyCache";
import { cloneParent, cloneWithProgress, folderName, removeFolder, untouched } from "./cloneRepo";
import { openFacts, type BarEngine } from "./engine";
import { gitRun, openOwn } from "./ownWindow";
import type { RemoteRepos } from "./remoteRepos";
import { cli } from "./runner";
import { setLabel } from "./state";
import { BAR_COMMANDS } from "./types";
import { openPath } from "./window";

/**
 * The search of the left menu: the Azure DevOps list (read when the search asks), cloning from it, and opening a branch
 * where it is checked out. Nothing here runs when a menu opens; every git or aihub process starts from a click.
 */
export interface SearchHost {
  engine: BarEngine;
  remote: RemoteRepos;
  log: (line: string) => void;
  changed: () => void;
  reg: (id: string, f: (...a: any[]) => unknown) => void;
}

type Row = vscode.QuickPickItem & { act?: string };

/** A pick whose active row is `active` (Enter runs it), not the first row. */
function pick(title: string, placeholder: string, rows: Row[], active: Row): Promise<Row | undefined> {
  return new Promise((resolve) => {
    const q = vscode.window.createQuickPick<Row>();
    q.title = title;
    q.placeholder = placeholder;
    q.items = rows;
    q.activeItems = [active];
    let done = false;
    q.onDidAccept(() => {
      done = true;
      resolve(q.selectedItems[0] ?? q.activeItems[0]);
      q.hide();
    });
    q.onDidHide(() => {
      if (!done) resolve(undefined);
      q.dispose();
    });
    q.show();
  });
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function registerSearchCommands(h: SearchHost): void {
  h.reg(BAR_COMMANDS.loadRemoteRepositories, () => void h.remote.load().catch(() => undefined));
  h.reg(BAR_COMMANDS.refreshRemoteRepositories, () => h.remote.load({ force: true }));

  h.reg(BAR_COMMANDS.signInAzureDevOps, () => {
    const t = vscode.window.createTerminal("Sign in to Azure DevOps");
    t.show();
    t.sendText("az login");
    // when the terminal is closed the list is read again (the user signed in, or gave up: then the failure is remembered again)
    const sub = vscode.window.onDidCloseTerminal((closed) => {
      if (closed !== t) return;
      sub.dispose();
      void h.remote.load({ force: true });
    });
    vscode.window.showInformationMessage("AI Context Hub: sign in with 'az login' in the terminal, then close it; the search reads Azure DevOps again.");
  });

  h.reg(BAR_COMMANDS.cloneRepository, async (arg?: unknown) => {
    const a = (arg ?? {}) as Record<string, unknown>;
    const name = str(a.name);
    const remoteUrl = str(a.remoteUrl);
    const project = str(a.project);
    if (!name || !remoteUrl) return void vscode.window.showWarningMessage("AI Context Hub: which repository? Pick one in the search of the left menu.");
    const facts = openFacts(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
    const set = facts.set;
    const label = set ? setLabel(set, readSeenStories(process.env)) : "";
    let parent = cloneParent(h.engine.folders(), h.engine.scan().repos.map((r) => r.path));
    for (;;) {
      const into = parent ? join(parent, folderName(name)) : undefined;
      const info: Row = { label: `$(folder) ${into ? `Clone into ${into}` : "Choose a folder to clone into"}`, description: project ? `from ${project}` : undefined, act: "folder" };
      const open: Row = { label: "Clone and Open", description: "in a new window", act: "open" };
      const add: Row = { label: `Clone and Add to ${label}`, description: set ? `on ${set.branch}` : undefined, act: "add" };
      const other: Row = { label: "Choose Another Folder…", act: "folder" };
      const rows = into ? [info, open, ...(set ? [add] : []), other] : [info, other];
      const chosen = await pick(`Clone ${name}`, into ? "Enter clones and opens it in a new window" : "Choose where the clone goes", rows, into ? open : other);
      if (!chosen) return;
      if (chosen.act === "folder" || !into) {
        const dirs = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: "Clone into this folder", defaultUri: parent ? vscode.Uri.file(parent) : undefined });
        if (!dirs?.[0]) return;
        parent = dirs[0].fsPath;
        continue;
      }
      if (existsSync(into)) {
        const again = await vscode.window.showWarningMessage(`AI Context Hub: ${into} exists already; nothing was overwritten.`, "Choose Another Folder…");
        if (again !== "Choose Another Folder…") return;
        const dirs = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: "Clone into this folder" });
        if (!dirs?.[0]) return;
        parent = dirs[0].fsPath;
        continue;
      }
      await cloneAndFinish(h, { name, remoteUrl, dir: into, addTo: chosen.act === "add" && set ? { first: set.repos[0]?.path ?? set.folder, label } : undefined });
      return;
    }
  });

  h.reg(BAR_COMMANDS.openCheckout, async (arg?: unknown) => {
    const a = (arg ?? {}) as Record<string, unknown>;
    const repo = str(a.repo);
    const branch = str(a.branch);
    const path = str(a.path);
    const where = str(a.where);
    if (!repo || !branch || !path) return;
    if (!existsSync(path)) {
      forgetScan(process.env);
      h.changed();
      return void vscode.window.showWarningMessage(`AI Context Hub: ${path} is gone; the list was refreshed.`);
    }
    const info: Row = { label: `$(folder) ${path}`, act: where === "none" ? "own" : "open" };
    if (where === "none") {
      const own: Row = { label: "Check Out in Its Own Folder and Open", description: "a worktree of its own, outside every set", act: "own" };
      const chosen = await pick(`${repo} · ${branch}`, "Enter checks it out in its own folder and opens it in a new window", [info, own], own);
      if (!chosen) return;
      try {
        const worktreeRoot = String(vscode.workspace.getConfiguration("worktreeMaker").get("worktreeRoot", "") ?? "");
        const res = await openOwn({ git: gitRun, source: path, setPath: path, current: headBranchOf(path), branch, worktreeRoot });
        h.log(`open checkout: ${res.note}`);
        forgetScan(process.env);
        h.changed();
        await openPath(res.path, "new");
      } catch (e) {
        void vscode.window.showErrorMessage(`AI Context Hub: could not check out ${branch} of ${repo}: ${(e as Error).message}`);
      }
      return;
    }
    const setId = str(a.setId);
    const label = str(a.setLabel);
    const short = label.split(" ")[0] || "the set";
    const open: Row = { label: "Open This Folder in a New Window", description: setId ? `only ${repo}; set ${short} stays as it is` : `only ${repo}`, act: "open" };
    const whole: Row = { label: `Open the Whole Set ${label || short}`, act: "set" };
    const chosen = await pick(`${repo} · ${branch}`, "Enter opens this folder in a new window", [info, open, ...(setId ? [whole] : [])], open);
    if (!chosen) return;
    if (chosen.act === "set") return void (await vscode.commands.executeCommand(BAR_COMMANDS.openSet, setId));
    h.log(`open checkout ${path} (${branch})`);
    await openPath(path, "new");
  });
}

async function cloneAndFinish(h: SearchHost, o: { name: string; remoteUrl: string; dir: string; addTo?: { first: string; label: string } }): Promise<void> {
  const res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Cloning ${o.name}`, cancellable: true }, (progress, token) => {
    let last = 0;
    return cloneWithProgress({
      url: o.remoteUrl,
      dir: o.dir,
      onProgress: (pct) => {
        progress.report({ increment: pct - last, message: `${pct}%` });
        last = pct;
      },
      onCancel: (stop) => token.onCancellationRequested(stop),
    });
  });
  if (!res.ok) {
    if (res.cancelled) return void vscode.window.showInformationMessage(`AI Context Hub: the clone of ${o.name} was cancelled; the half clone was removed.`);
    return void vscode.window.showErrorMessage(`AI Context Hub: ${o.name} could not be cloned: ${res.error}`);
  }
  h.log(`cloned ${o.name} to ${o.dir}`);
  forgetScan(process.env);
  h.engine.scan({ refresh: true });
  h.changed();
  let added = false;
  if (o.addTo) {
    try {
      await cli(["worktree", "add", "--repos", o.name, "--json"], o.addTo.first);
      added = true;
      forgetScan(process.env);
      h.changed();
    } catch (e) {
      void vscode.window.showWarningMessage(`AI Context Hub: ${o.name} was cloned to ${o.dir}, but could not be added to ${o.addTo.label}: ${(e as Error).message}`);
    }
  }
  // one message with Undo; opening a new window comes after it, so this window keeps the message
  void vscode.window.showInformationMessage(`${o.name} cloned to ${o.dir}${added ? ` and added to ${o.addTo!.label}` : ""}`, "Undo").then(async (b) => {
    if (b !== "Undo") return;
    if (added) {
      try {
        await cli(["worktree", "drop", "--repos", o.name, "--json"], o.addTo!.first);
      } catch (e) {
        return void vscode.window.showWarningMessage(`AI Context Hub: ${o.name} stays: it could not be taken out of the set (${(e as Error).message}).`);
      }
    }
    const check = await untouched(gitRun, o.dir).catch((e: Error) => ({ ok: false, why: e.message }));
    if (!check.ok) {
      forgetScan(process.env);
      h.changed();
      return void vscode.window.showWarningMessage(`AI Context Hub: ${o.dir} was kept: ${check.why}.`);
    }
    removeFolder(o.dir);
    forgetScan(process.env);
    h.changed();
    if (existsSync(o.dir)) return void vscode.window.showWarningMessage(`AI Context Hub: ${o.dir} could not be removed completely (a file is in use); remove it by hand.`);
    void vscode.window.showInformationMessage(`AI Context Hub: the clone of ${o.name} was removed.`);
  });
  if (!o.addTo) await openPath(o.dir, "new");
}
