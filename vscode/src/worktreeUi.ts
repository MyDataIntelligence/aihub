import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { findRepos, validateBranchName, type Repo } from "./worktrees/core";
import { deleteGroup, listGroups, saveGroup } from "./worktrees/extras";
import { createGit } from "./worktrees/git";
import { cleanUpCandidate, createSet, lossSummary, mergedWorktrees, pushSet, removeSet, setStatuses, syncSet, type RepoStep } from "./worktrees/service";
import { defaultSetsRoot, listSetsIn, readSet, removeRepoFromSet, setWorkspaceFile, type SetRepo, type WorktreeSet } from "./worktrees/sets";

/**
 * Worktree sets in the Explorer: one branch, one folder, one workspace file, several repositories. The logic is the
 * git-only code of Worktree Maker (src/worktrees); this file asks the questions and shows the results.
 */

const cfg = () => vscode.workspace.getConfiguration("aihub.worktrees");

const setsRoot = () => (String(cfg().get("setsRoot", "")).trim() || defaultSetsRoot());
const remote = () => String(cfg().get("remote", "origin")) || "origin";
const bases = () => (cfg().get<string[]>("baseBranches", ["staging", "main"]) ?? ["staging", "main"]).filter(Boolean);

/** Folders scanned for repositories: the setting, else the parents of the workspace folders. */
function repoRoots(): string[] {
  const set = (cfg().get<string[]>("repoRoots", []) ?? []).filter(Boolean);
  if (set.length) return set;
  return [...new Set((vscode.workspace.workspaceFolders ?? []).map((f) => path.dirname(f.uri.fsPath)))];
}

type Node = { kind: "set"; set: WorktreeSet } | { kind: "repo"; set: WorktreeSet; repo: SetRepo };

export class WorktreeSetsProvider implements vscode.TreeDataProvider<Node> {
  private emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(private git: ReturnType<typeof createGit>) {}

  refresh() {
    this.emitter.fire(undefined);
  }

  async getChildren(n?: Node): Promise<Node[]> {
    if (!n) return (await listSetsIn([setsRoot()])).map((set) => ({ kind: "set", set }));
    if (n.kind === "set") return n.set.repos.map((repo) => ({ kind: "repo", set: n.set, repo }));
    return [];
  }

  async getTreeItem(n: Node): Promise<vscode.TreeItem> {
    if (n.kind === "set") {
      const it = new vscode.TreeItem(n.set.branch, vscode.TreeItemCollapsibleState.Expanded);
      it.description = `${n.set.repos.length} repo${n.set.repos.length === 1 ? "" : "s"}`;
      it.contextValue = "aihubSet";
      it.iconPath = new vscode.ThemeIcon("repo-forked");
      it.tooltip = n.set.folder;
      return it;
    }
    const it = new vscode.TreeItem(n.repo.name, vscode.TreeItemCollapsibleState.None);
    it.contextValue = "aihubSetRepo";
    it.iconPath = new vscode.ThemeIcon("repo");
    it.tooltip = n.repo.path;
    const s = (await setStatuses(this.git, remote(), n.set)).find((x) => x.name === n.repo.name);
    if (s) it.description = !s.exists ? "missing" : [s.dirty ? `${s.dirty} changed` : "", s.ahead ? `${s.ahead} to push` : s.unpushed ? `${s.unpushed} to push` : "", s.behind ? `${s.behind} behind` : ""].filter(Boolean).join(", ") || "clean";
    return it;
  }
}

const summary = (steps: RepoStep[]) => steps.map((s) => `${s.name}: ${s.status === "ok" ? "" : s.status + ": "}${s.message}${s.nextStep ? ` (${s.nextStep})` : ""}`).join("\n");

export function registerWorktreeCommands(ctx: vscode.ExtensionContext, log: (line: string) => void, toChat: (actionId: string) => Promise<void>): void {
  const git = createGit("git", log);
  const provider = new WorktreeSetsProvider(git);
  ctx.subscriptions.push(vscode.window.registerTreeDataProvider("aihub.worktreeSets", provider));
  const reg = (id: string, fn: (...a: any[]) => Promise<void>) =>
    ctx.subscriptions.push(
      vscode.commands.registerCommand(id, async (...a: any[]) => {
        try {
          await fn(...a);
        } catch (e) {
          void vscode.window.showErrorMessage(`AI Context Hub: ${(e as Error).message}`);
        }
      }),
    );

  /** The set a command applies to: the clicked row, else a pick. */
  const pickSet = async (n?: Node, placeHolder = "Choose a worktree set"): Promise<WorktreeSet | undefined> => {
    if (n?.set) return (await readSet(n.set.folder)) ?? n.set;
    const sets = await listSetsIn([setsRoot()]);
    if (!sets.length) return void vscode.window.showInformationMessage("There are no worktree sets yet. Create one first.");
    return (await vscode.window.showQuickPick(sets.map((s) => ({ label: s.branch, description: `${s.repos.length} repos`, set: s })), { placeHolder }))?.set;
  };

  const pickRepos = async (): Promise<Repo[] | undefined> => {
    const roots = repoRoots();
    if (!roots.length) return void vscode.window.showWarningMessage("Open a folder, or set aihub.worktrees.repoRoots, so repositories can be found.");
    const found = await findRepos(roots, Number(cfg().get("scanDepth", 2)));
    if (!found.length) return void vscode.window.showWarningMessage(`No git repositories found in ${roots.join(", ")}.`);
    const groups = listGroups(ctx.globalState);
    let preselect: string[] = [];
    if (groups.length) {
      const g = await vscode.window.showQuickPick([{ label: "Choose repositories...", group: undefined as undefined | (typeof groups)[number] }, ...groups.map((x) => ({ label: x.name, description: `${x.repoPaths.length} repos`, group: x }))], { placeHolder: "Use a saved repo group?" });
      if (!g) return;
      preselect = g.group?.repoPaths ?? [];
      if (g.group) return found.filter((r) => preselect.includes(r.path));
    }
    const picks = await vscode.window.showQuickPick(found.map((r) => ({ label: r.name, description: r.path, repo: r })), { canPickMany: true, placeHolder: "Repositories for the set" });
    return picks?.map((p) => p.repo);
  };

  const showResult = async (title: string, lines: string, hasError: boolean) => {
    log(`${title}\n${lines}`);
    void (hasError ? vscode.window.showWarningMessage(`${title}: some repositories need attention.\n${lines}`, { modal: true }) : vscode.window.showInformationMessage(`${title}: ${lines.split("\n").length} repo(s) done.`));
  };

  const open = async (set: WorktreeSet, newWindow: boolean) => {
    const file = setWorkspaceFile(set);
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(file), { forceNewWindow: newWindow });
  };

  reg("aihub.worktrees.create", async (n?: Node) => {
    const existing = n?.set;
    const repos = await pickRepos();
    if (!repos?.length) return;
    const branch =
      existing?.branch ??
      (await vscode.window.showInputBox({
        prompt: "Branch name for the set (new or existing)",
        value: "feature/",
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim().length < 3 ? "Enter a branch name" : undefined),
      }));
    if (!branch) return;
    const bad = await validateBranchName(git, branch, repos[0].path);
    if (bad) return void vscode.window.showErrorMessage(bad);
    const base = existing?.base ?? (bases().length === 1 ? bases()[0] : await vscode.window.showQuickPick(bases(), { placeHolder: "Base branch for a new branch" }));
    if (!base) return;
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Creating worktrees for ${branch}...` }, () => createSet(git, { root: setsRoot(), branch, base, remote: remote(), repos }));
    provider.refresh();
    const bad2 = r.outcomes.some((o) => o.status === "error");
    await showResult(`Set ${branch}`, r.outcomes.map((o) => `${o.repo.name}: ${o.status}: ${o.message}${o.nextStep ? ` (${o.nextStep})` : ""}`).join("\n"), bad2);
    if (r.set) {
      const go = await vscode.window.showInformationMessage(`Set ${branch} is ready.`, "Open in new window", "Open in this window");
      if (go) await open(r.set, go === "Open in new window");
    }
  });

  reg("aihub.worktrees.addRepos", async (n?: Node) => {
    const set = await pickSet(n, "Add repositories to which set?");
    if (set) await vscode.commands.executeCommand("aihub.worktrees.create", { kind: "set", set });
  });

  for (const [id, newWindow] of [["aihub.worktrees.openSet", true], ["aihub.worktrees.openInNewWindow", true], ["aihub.worktrees.openSetHere", false]] as const) {
    reg(id, async (n?: Node) => {
      const set = await pickSet(n, "Open which set?");
      if (set) await open(set, newWindow);
    });
  }

  reg("aihub.worktrees.revealSet", async (n?: Node) => {
    const set = await pickSet(n);
    if (set) await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(set.folder));
  });

  reg("aihub.worktrees.syncSet", async (n?: Node) => {
    const set = await pickSet(n, "Sync which set?");
    if (!set) return;
    const steps = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Syncing ${set.branch}...` }, () => syncSet(git, set, remote()));
    provider.refresh();
    await showResult(`Sync ${set.branch}`, summary(steps), steps.some((s) => s.status === "error"));
  });

  reg("aihub.worktrees.pushSet", async (n?: Node) => {
    const set = await pickSet(n, "Push which set?");
    if (!set) return;
    const statuses = await setStatuses(git, remote(), set);
    const yes = await vscode.window.showWarningMessage(`Push ${set.repos.length} repo(s) of ${set.branch} to ${remote()}?${lossSummary(statuses).length ? "\n\n" + lossSummary(statuses).join("\n") : ""}`, { modal: true }, "Push");
    if (yes !== "Push") return;
    const steps = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Pushing ${set.branch}...` }, () => pushSet(git, set, remote()));
    provider.refresh();
    await showResult(`Push ${set.branch}`, summary(steps), steps.some((s) => s.status === "error"));
  });

  reg("aihub.worktrees.createPullRequests", async (n?: Node) => {
    const set = await pickSet(n, "Create pull requests for which set?");
    if (!set) return;
    // The agent runs `aihub pr create` per repository; open the set so each repository is a folder it can work in.
    await open(set, true);
    await toChat("pr");
  });

  reg("aihub.worktrees.removeSet", async (n?: Node) => {
    const set = await pickSet(n, "Remove which set?");
    if (!set) return;
    const loss = lossSummary(await setStatuses(git, remote(), set));
    const yes = await vscode.window.showWarningMessage(`Remove the worktree set ${set.branch} (${set.repos.length} repos)? The branches stay.${loss.length ? "\n\nYou would lose:\n" + loss.join("\n") : ""}`, { modal: true }, loss.length ? "Remove and discard" : "Remove");
    if (!yes) return;
    const res = await removeSet(git, set, loss.length > 0);
    provider.refresh();
    await showResult(`Remove ${set.branch}`, res.map((r) => `${r.name}: ${r.message}`).join("\n"), res.some((r) => !r.ok));
  });

  reg("aihub.worktrees.removeRepoFromSet", async (n?: Node) => {
    if (n?.kind !== "repo") return void vscode.window.showInformationMessage("Right-click a repository inside a set.");
    const st = (await setStatuses(git, remote(), n.set)).find((s) => s.name === n.repo.name);
    const loss = st ? lossSummary([st]) : [];
    const yes = await vscode.window.showWarningMessage(`Remove ${n.repo.name} from ${n.set.branch}?${loss.length ? "\n\nYou would lose:\n" + loss.join("\n") : ""}`, { modal: true }, loss.length ? "Remove and discard" : "Remove");
    if (!yes) return;
    const r = await removeRepoFromSet(git, n.set, n.repo.name, loss.length > 0);
    provider.refresh();
    void (r.ok ? vscode.window.showInformationMessage(r.message) : vscode.window.showWarningMessage(r.message));
  });

  reg("aihub.worktrees.cleanup", async () => {
    const roots = repoRoots();
    const repos = roots.length ? await findRepos(roots, Number(cfg().get("scanDepth", 2))) : [];
    if (!repos.length) return void vscode.window.showInformationMessage("No repositories found to scan.");
    const found = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Looking for merged worktrees..." }, () => mergedWorktrees(git, repos, remote(), bases()));
    if (!found.length) return void vscode.window.showInformationMessage("No merged worktrees to clean up.");
    const picks = await vscode.window.showQuickPick(found.map((c) => ({ label: c.label, description: c.worktree.path, picked: true, c })), { canPickMany: true, placeHolder: "Remove these worktrees and their local branches" });
    if (!picks?.length) return;
    const out: string[] = [];
    for (const p of picks) {
      const r = await cleanUpCandidate(git, p.c);
      out.push(`${p.c.repo.name}: ${r.message}`);
    }
    provider.refresh();
    await showResult("Clean up merged worktrees", out.join("\n"), false);
  });

  reg("aihub.worktrees.saveGroup", async () => {
    const found = await findRepos(repoRoots(), Number(cfg().get("scanDepth", 2)));
    const name = await vscode.window.showInputBox({ prompt: "Name of the repo group", ignoreFocusOut: true });
    if (!name) return;
    const picks = await vscode.window.showQuickPick(found.map((r) => ({ label: r.name, description: r.path, r })), { canPickMany: true, placeHolder: "Repositories in this group" });
    if (picks?.length) await saveGroup(ctx.globalState, { name, repoPaths: picks.map((p) => p.r.path) });
  });

  reg("aihub.worktrees.deleteGroup", async () => {
    const groups = listGroups(ctx.globalState);
    if (!groups.length) return void vscode.window.showInformationMessage("There are no saved repo groups.");
    const pick = await vscode.window.showQuickPick(groups.map((g) => ({ label: g.name, description: `${g.repoPaths.length} repos` })), { placeHolder: "Delete which group?" });
    if (pick) await deleteGroup(ctx.globalState, pick.label);
  });

  reg("aihub.worktrees.refresh", async () => provider.refresh());

  reg("aihub.worktrees.setActions", async (n?: Node) => {
    const items = [
      ["Open in new window", "aihub.worktrees.openSet"],
      ["Open in this window", "aihub.worktrees.openSetHere"],
      ["Add repositories...", "aihub.worktrees.addRepos"],
      ["Sync (fetch + fast-forward)", "aihub.worktrees.syncSet"],
      ["Push...", "aihub.worktrees.pushSet"],
      ["Create pull requests...", "aihub.worktrees.createPullRequests"],
      ["Reveal folder", "aihub.worktrees.revealSet"],
      ["Remove...", "aihub.worktrees.removeSet"],
    ] as const;
    const set = await pickSet(n);
    if (!set) return;
    const pick = await vscode.window.showQuickPick(items.map(([label, cmd]) => ({ label, cmd })), { placeHolder: `${set.branch}: what do you want to do?` });
    if (pick) await vscode.commands.executeCommand(pick.cmd, { kind: "set", set });
  });

  void os;
}
