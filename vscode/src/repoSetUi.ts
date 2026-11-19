import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { makeRunner, readJson, type Runner } from "./cli";
import { findRepos, type Repo } from "./worktrees/core";
import { listGroups as listLocalGroups } from "./worktrees/extras";
import {
  branchItems,
  branchesArgs,
  groupItems,
  howItems,
  openArgs,
  prItems,
  summarizeOpen,
  windowItems,
  type BranchChoice,
  type BranchesJson,
  type GroupJson,
  type HowMode,
  type HowWindow,
  type OpenResultJson,
  type PickItem,
  type PrJson,
} from "./repoSetModel";

/**
 * "Repos op branch openen": group or repositories -> branch -> how. It is a local action: the quick pick runs
 * `aihub worktree open ... --json` itself (it never goes to the chat). All git work is in the CLI.
 */

const cfg = () => vscode.workspace.getConfiguration("aihub");

/** A runner with room for several `git fetch`es; the status reads keep their short limit. */
const slowRunner = (): Runner => makeRunner({ command: String(cfg().get("cliPath", "aihub")) || "aihub", timeoutMs: 180_000 });

const pick = async <T>(items: PickItem<T>[], title: string, placeHolder: string): Promise<T | undefined> => {
  const qp = items.map((i) => (i.separator ? ({ label: i.label, kind: vscode.QuickPickItemKind.Separator } as vscode.QuickPickItem) : { label: i.label, description: i.description, detail: i.detail, value: i.value }));
  const r = (await vscode.window.showQuickPick(qp as (vscode.QuickPickItem & { value?: T })[], { title, placeHolder, matchOnDescription: true, matchOnDetail: true })) as { value?: T } | undefined;
  return r?.value;
};

export interface RepoSetDeps {
  cwd: () => string | undefined;
  log: (line: string) => void;
  /** after a set was opened: refresh views */
  refresh: () => void;
}

export class RepoSetController {
  constructor(
    private ctx: vscode.ExtensionContext,
    private deps: RepoSetDeps,
  ) {}

  private cwd(): string {
    return this.deps.cwd() ?? os.homedir();
  }

  /** The groups of `aihub worktree groups`; groups the older Worktree Sets view kept in the extension are moved there once. */
  async groups(): Promise<GroupJson[]> {
    const run = slowRunner();
    const cwd = this.cwd();
    let known = await readJson<GroupJson[]>(run, ["worktree", "groups", "list"], cwd).catch(() => [] as GroupJson[]);
    const names = new Set(known.map((g) => g.name.toLowerCase()));
    let moved = false;
    for (const g of listLocalGroups(this.ctx.globalState)) {
      if (names.has(g.name.toLowerCase()) || !g.repoPaths.length) continue;
      try {
        await run(["worktree", "groups", "save", g.name, "--repos", g.repoPaths.join(","), "--json"], cwd);
        moved = true;
      } catch (e) {
        this.deps.log(`group ${g.name} could not be moved to the aihub config: ${(e as Error).message}`);
      }
    }
    if (moved) known = await readJson<GroupJson[]>(run, ["worktree", "groups", "list"], cwd).catch(() => known);
    return known;
  }

  private async tickRepos(): Promise<{ repos: Repo[]; group?: string } | undefined> {
    const roots = (cfg().get<string[]>("worktrees.repoRoots", []) ?? []).filter(Boolean);
    const search = roots.length ? roots : [...new Set((vscode.workspace.workspaceFolders ?? []).map((f) => path.dirname(f.uri.fsPath)))];
    if (!search.length) return void vscode.window.showWarningMessage("Open a folder, or set aihub.worktrees.repoRoots, so repositories can be found.");
    const found = await findRepos(search, Number(cfg().get("worktrees.scanDepth", 2)));
    if (!found.length) return void vscode.window.showWarningMessage(`No git repositories found in ${search.join(", ")}.`);
    const picks = await vscode.window.showQuickPick(
      found.map((r) => ({ label: r.name, description: r.path, repo: r })),
      { canPickMany: true, title: "Repos op branch openen (1/3)", placeHolder: "Tick the repositories" },
    );
    if (!picks?.length) return;
    const repos = picks.map((p) => p.repo);
    const name = await vscode.window.showInputBox({ title: "Save as a group?", prompt: "Name of the group, so next time one click opens all of them (Enter without a name skips)", ignoreFocusOut: true, validateInput: (v) => (v && !/^[\w.-]+$/.test(v) ? "Letters, digits, . - _ only" : undefined) });
    if (name === undefined) return;
    if (name.trim()) {
      await slowRunner()(["worktree", "groups", "save", name.trim(), "--repos", repos.map((r) => r.path).join(","), "--json"], this.cwd());
      return { repos, group: name.trim() };
    }
    return { repos };
  }

  private async chooseBranch(target: { group?: string; repos?: string[] }, total: number): Promise<{ branch: string; from?: string } | undefined> {
    const run = slowRunner();
    const rows = await Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Reading the branches..." }, () => readJson<BranchesJson>(run, branchesArgs(target), this.cwd()))).catch((e: Error) => {
      void vscode.window.showWarningMessage(`Could not read the branches: ${e.message}`);
      return { repos: [], branches: [] } as BranchesJson;
    });
    const choice = await pick<BranchChoice>(branchItems(rows.branches, rows.repos.length || total), "Repos op branch openen (2/3)", "Choose the branch");
    if (!choice) return;
    if (choice.kind === "existing") return { branch: choice.branch };
    if (choice.kind === "new-story" || choice.kind === "typed") {
      const branch = await vscode.window.showInputBox({
        title: choice.kind === "new-story" ? "New branch for a story" : "Branch name",
        prompt: choice.kind === "new-story" ? "Branch name, for example feature/1234-search" : "Branch name (a missing branch is created from each repository's target branch)",
        value: choice.kind === "new-story" ? "feature/" : "",
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim().length < 3 || /\s/.test(v) ? "Enter a branch name without spaces" : undefined),
      });
      return branch ? { branch: branch.trim() } : undefined;
    }
    const prs = await Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Reading your pull requests..." }, () => readJson<PrJson[]>(run, ["pr", "list", "--mine"], this.cwd()))).catch((e: Error) => {
      void vscode.window.showWarningMessage(`Could not read your pull requests: ${e.message}`);
      return [] as PrJson[];
    });
    if (!prs.length) return void vscode.window.showInformationMessage("No active pull requests of yours.");
    const p = await pick(prItems(prs), "Branch of a pull request", "Choose the pull request");
    return p ? { branch: p.source, from: p.target } : undefined;
  }

  /** The whole flow. `group` skips step 1 (the Worktree Sets view's "Open on branch..." button). */
  async open(group?: string): Promise<void> {
    let target: { group?: string; repos?: string[] };
    let total = 0;
    if (group) {
      target = { group };
      total = (await this.groups()).find((g) => g.name === group)?.repos.length ?? 0;
    } else {
      const choice = await pick(groupItems(await this.groups()), "Repos op branch openen (1/3)", "Choose a group, or tick repositories");
      if (!choice) return;
      if ("group" in choice) {
        target = { group: choice.group.name };
        total = choice.group.repos.length;
      } else {
        const t = await this.tickRepos();
        if (!t) return;
        target = t.group ? { group: t.group } : { repos: t.repos.map((r) => r.path) };
        total = t.repos.length;
      }
    }
    const b = await this.chooseBranch(target, total);
    if (!b) return;
    const mode = await pick<HowMode>(howItems(), "Repos op branch openen (3/3)", `How should ${b.branch} be opened?`);
    if (!mode) return;
    const window = await pick<HowWindow>(windowItems(), "Repos op branch openen (3/3)", "Where?");
    if (!window) return;
    const args = openArgs({ ...target, branch: b.branch, from: b.from, mode, window });
    this.deps.log(`aihub ${args.join(" ")}`);
    let out: string;
    try {
      out = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Opening ${b.branch}...` }, () => slowRunner()([...args, "--json"], this.cwd()));
    } catch (e) {
      return void vscode.window.showErrorMessage(`AI Context Hub: ${(e as Error).message}`);
    }
    const text = out.trim();
    let res: OpenResultJson;
    try {
      res = JSON.parse(text.slice(Math.max(0, text.search(/[{]/)))) as OpenResultJson;
    } catch {
      return void vscode.window.showErrorMessage("AI Context Hub: aihub worktree open did not print JSON. Update the CLI: npm i -g @ferronhooi/aihub");
    }
    const sum = summarizeOpen(res);
    this.deps.log(`${sum.title}\n${sum.lines.join("\n")}`);
    void (sum.ok ? vscode.window.showInformationMessage(sum.title) : vscode.window.showWarningMessage(`${sum.title}\n${sum.lines.join("\n")}`, { modal: true }));
    this.deps.refresh();
  }

  register(): void {
    this.ctx.subscriptions.push(
      vscode.commands.registerCommand("aihub.reposet.open", () => this.open().catch((e) => vscode.window.showErrorMessage(`AI Context Hub: ${(e as Error).message}`))),
      vscode.commands.registerCommand("aihub.reposet.openGroup", (n?: { group?: GroupJson }) => this.open(n?.group?.name).catch((e) => vscode.window.showErrorMessage(`AI Context Hub: ${(e as Error).message}`))),
    );
  }
}
