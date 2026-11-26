import * as path from "path";
import * as vscode from "vscode";
import { branchChangedFiles, checkConflicts, commitsAhead, currentBranch, defaultTarget, filesDifferingFrom, pushedAlready, recentSubjects, refChoices, refExists, resetPathsToRef, revertToMergeBase, squashCommits, switchBranch, switchChoices, type ChangedFile } from "./gitActions";
import { createGit, type Git } from "./worktrees/git";
import { showFailure } from "./bar/failureUi";

/**
 * The Branch menu of the old extension: Reset to Branch or Commit, Check for Merge Conflicts, Clean Up Unrelated
 * Changes, Squash Branch Commits, and Switch branch. Plain git in the extension; every destructive step is confirmed
 * first with the files that change.
 */

const REMOTE = "origin";

/** Resource URIs from a context-menu call: Explorer (uri, uris[]), SCM (resource state or states), or the active editor. */
export function urisFromArgs(args: unknown[]): vscode.Uri[] {
  const out: vscode.Uri[] = [];
  const add = (x: unknown) => {
    if (x instanceof vscode.Uri) out.push(x);
    else if (x && typeof x === "object" && "resourceUri" in x && (x as { resourceUri: unknown }).resourceUri instanceof vscode.Uri) out.push((x as { resourceUri: vscode.Uri }).resourceUri);
    else if (x && typeof x === "object" && "resourceStates" in x) ((x as { resourceStates: unknown[] }).resourceStates ?? []).forEach(add);
  };
  const [first, second] = args;
  if (Array.isArray(second)) second.forEach(add);
  else add(first);
  if (!out.length && Array.isArray(first)) first.forEach(add);
  if (!out.length && vscode.window.activeTextEditor) out.push(vscode.window.activeTextEditor.document.uri);
  return [...new Map(out.map((u) => [u.fsPath, u])).values()];
}

async function repoRootOf(git: Git, fsPath: string): Promise<string | undefined> {
  const dir = /\.[^\\/]+$/.test(path.basename(fsPath)) ? path.dirname(fsPath) : fsPath;
  const r = await git(["rev-parse", "--show-toplevel"], dir).then((x) => (x.code === 0 ? x : git(["rev-parse", "--show-toplevel"], path.dirname(fsPath))));
  return r.code === 0 ? path.normalize(r.stdout.trim()) : undefined;
}

/** The repository the action applies to: of the clicked file, else of the active editor, else the first workspace folder. */
async function repoFor(git: Git, uris: vscode.Uri[]): Promise<string | undefined> {
  const probe = uris[0]?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return probe ? repoRootOf(git, probe) : undefined;
}

const list = (items: string[], max = 12) => items.slice(0, max).join("\n") + (items.length > max ? `\n... and ${items.length - max} more` : "");

export function registerGitCommands(ctx: vscode.ExtensionContext, log: (line: string) => void, toChat: (actionId: string) => Promise<void>): void {
  const git = createGit("git", log);
  const reg = (id: string, fn: (...a: unknown[]) => Promise<void>) =>
    ctx.subscriptions.push(
      vscode.commands.registerCommand(id, async (...a: unknown[]) => {
        try {
          await fn(...a);
        } catch (e) {
          void showFailure(e);
        }
      }),
    );

  const target = async (cwd: string): Promise<string | undefined> => {
    const t = await defaultTarget(git, cwd, REMOTE);
    if (!t) void vscode.window.showWarningMessage(`No ${REMOTE}/staging or ${REMOTE}/main found in this repository.`);
    return t;
  };

  reg("aihub.git.resetToRef", async (...args) => {
    const uris = urisFromArgs(args);
    const cwd = await repoFor(git, uris);
    if (!cwd || !uris.length) return void vscode.window.showWarningMessage("Select one or more files first.");
    const choices = await refChoices(git, cwd, REMOTE);
    const pick = await vscode.window.showQuickPick([...choices, "Other branch, tag or commit..."], { placeHolder: "Reset the selected files to..." });
    if (!pick) return;
    const ref = pick.startsWith("Other") ? await vscode.window.showInputBox({ prompt: "Branch, tag or commit", ignoreFocusOut: true }) : pick;
    if (!ref) return;
    if (!(await refExists(git, cwd, ref))) return void vscode.window.showWarningMessage(`${ref} does not exist in this repository.`);
    const rel = uris.map((u) => path.relative(cwd, u.fsPath).replace(/\\/g, "/"));
    const differing = await filesDifferingFrom(git, cwd, ref, rel);
    if (!differing.length) return void vscode.window.showInformationMessage(`Nothing to reset: the selected files already match ${ref}.`);
    const yes = await vscode.window.showWarningMessage(`Reset ${differing.length} file(s) to ${ref}? Uncommitted changes in them are lost.\n\n${list(differing)}`, { modal: true }, "Reset");
    if (yes !== "Reset") return;
    const r = await resetPathsToRef(git, cwd, ref, differing);
    void (r.ok ? vscode.window.showInformationMessage(r.message) : showFailure(r.message));
  });

  reg("aihub.git.checkMergeConflicts", async (...args) => {
    const cwd = await repoFor(git, urisFromArgs(args));
    if (!cwd) return void vscode.window.showWarningMessage("Open a folder with a git repository first.");
    const t = await target(cwd);
    if (!t) return;
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Checking for merge conflicts with ${t}...` }, () => checkConflicts(git, cwd, t));
    if (r.clean) return void vscode.window.showInformationMessage(r.message);
    const reset = "Reset these files to " + t;
    const pick = await vscode.window.showWarningMessage(`${r.message}\n\n${list(r.files)}`, { modal: true }, reset, "Open first file");
    if (pick === "Open first file" && r.files[0]) await vscode.window.showTextDocument(vscode.Uri.file(path.join(cwd, r.files[0])));
    if (pick === reset) {
      const yes = await vscode.window.showWarningMessage(`Reset ${r.files.length} file(s) to ${t}? Your changes in them are lost.`, { modal: true }, "Reset");
      if (yes === "Reset") {
        const s = await resetPathsToRef(git, cwd, t, r.files);
        void vscode.window.showInformationMessage(s.message);
      }
    }
  });

  reg("aihub.git.cleanUpUnrelated", async (...args) => {
    const cwd = await repoFor(git, urisFromArgs(args));
    if (!cwd) return void vscode.window.showWarningMessage("Open a folder with a git repository first.");
    const t = await target(cwd);
    if (!t) return;
    const changed = await branchChangedFiles(git, cwd, t);
    if (!changed.length) return void vscode.window.showInformationMessage(`This branch changes nothing compared with ${t}.`);
    const picks = await vscode.window.showQuickPick(
      changed.map((c) => ({ label: c.path, description: { A: "added", M: "modified", D: "deleted", R: "renamed" }[c.status] ?? c.status, file: c })),
      { canPickMany: true, placeHolder: `Tick the files that do NOT belong to this story; they are reset to ${t}` },
    );
    if (!picks?.length) return;
    const files: ChangedFile[] = picks.map((p) => p.file);
    const yes = await vscode.window.showWarningMessage(`Reset ${files.length} unrelated file(s) to ${t}?\n\n${list(files.map((f) => f.path))}`, { modal: true }, "Reset");
    if (yes !== "Reset") return;
    const r = await revertToMergeBase(git, cwd, t, files);
    void (r.ok ? vscode.window.showInformationMessage(r.message) : showFailure(r.message));
  });

  reg("aihub.git.squash", async (...args) => {
    const cwd = await repoFor(git, urisFromArgs(args));
    if (!cwd) return void vscode.window.showWarningMessage("Open a folder with a git repository first.");
    const t = await target(cwd);
    if (!t) return;
    const total = await commitsAhead(git, cwd, t);
    if (total < 2) return void vscode.window.showInformationMessage(`Nothing to squash: the branch has ${total} commit(s) since ${t}.`);
    const countText = await vscode.window.showInputBox({ prompt: `How many of the newest commits? (2 to ${total}; all ${total} since ${t} by default)`, value: String(total), validateInput: (v) => (/^\d+$/.test(v) && +v >= 2 && +v <= total ? undefined : `Enter a number from 2 to ${total}`), ignoreFocusOut: true });
    if (!countText) return;
    const count = +countText;
    const subjects = await recentSubjects(git, cwd, count);
    const message = await vscode.window.showInputBox({ prompt: "Commit message of the squashed commit", value: subjects[subjects.length - 1] ?? "", ignoreFocusOut: true });
    if (!message) return;
    const wasPushed = await pushedAlready(git, cwd, REMOTE);
    const yes = await vscode.window.showWarningMessage(`Squash the newest ${count} commits into one?${wasPushed ? "\n\nThe branch was pushed before, so you must push again with --force-with-lease." : ""}\n\n${list(subjects)}`, { modal: true }, "Squash");
    if (yes !== "Squash") return;
    const r = await squashCommits(git, cwd, t, message, count);
    if (!r.ok) return void showFailure(r.message);
    const branch = (await currentBranch(git, cwd)) ?? "HEAD";
    const buttons = wasPushed ? ["Push (force with lease)"] : ["Create or update the PR"];
    const next = await vscode.window.showInformationMessage(r.message, ...buttons);
    if (next === "Push (force with lease)") {
      const p = await git(["push", "--force-with-lease", REMOTE, branch], cwd);
      void (p.code === 0 ? vscode.window.showInformationMessage(`Pushed ${branch}.`) : vscode.window.showErrorMessage(p.stderr.split(/\r?\n/).find(Boolean) ?? "git push failed."));
    } else if (next) await toChat("pr");
  });

  reg("aihub.git.switchBranch", async (...args) => {
    const cwd = await repoFor(git, urisFromArgs(args));
    if (!cwd) return void vscode.window.showWarningMessage("Open a folder with a git repository first.");
    const current = await currentBranch(git, cwd);
    const choices = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Fetching branches..." }, () => switchChoices(git, cwd, REMOTE));
    const pick = await vscode.window.showQuickPick(
      choices.map((c) => ({ label: c.name, description: c.name === current ? "current" : c.remoteOnly ? "remote only: creates a tracking branch" : "", choice: c })),
      { placeHolder: `Switch branch (now on ${current ?? "?"})` },
    );
    if (!pick || pick.choice.name === current) return;
    const r = await switchBranch(git, cwd, pick.choice, REMOTE);
    void (r.ok ? vscode.window.showInformationMessage(r.message) : showFailure(r.message));
  });
}
