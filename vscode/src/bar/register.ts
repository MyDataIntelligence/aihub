import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import * as vscode from "vscode";
import { forgetScan, gitDirFor, writeLookIn } from "../../../cli/src/lib/machineScan";
import { forgetUse, pathKey, readRecentUse, ago } from "../../../cli/src/lib/recentUse";
import { syncRepoName } from "../../../cli/src/lib/workspaceNames";
import { CliProblem } from "./cliCheck";
import { BarEngine, openFacts } from "./engine";
import { gitRun } from "./ownWindow";
import { cli } from "./runner";
import { BehindMemo, gitStatusOf, prOfBranch, PrMemo, type GitRepoLike, type PrRow } from "./repoStatus";
import { linkedOf, registerStoryCommands } from "./storyUi";
import { registerSetOps, SetFileWatcher } from "./setOps";
import { openPath, windowIsEmpty } from "./window";
import { BAR_COMMANDS, type BarApi, type BarState } from "./types";

/**
 * The buttons' engine in this extension: `activate()` returns `{ bar }`, the commands do the work. Nothing runs at
 * activation except registering the commands; the state is read when a button asks for it.
 */
const cfg = () => vscode.workspace.getConfiguration("aiContextHub");
const DIRTY_TTL_MS = 20_000;

/** Changed files of a worktree: one `git status` per path, remembered for 20 seconds; undefined when git cannot say. */
export function dirtyCounter(): (path: string) => Promise<number | undefined> {
  const memo = new Map<string, { at: number; n: Promise<number | undefined> }>();
  return (path) => {
    const hit = memo.get(path);
    if (hit && Date.now() - hit.at < DIRTY_TTL_MS) return hit.n;
    const n = new Promise<number | undefined>((resolve) => {
      // --no-optional-locks: counting changes must never take the index lock a commit of the user needs at the same moment
      execFile("git", ["--no-optional-locks", "status", "--porcelain"], { cwd: path, timeout: 10_000, windowsHide: true, maxBuffer: 4_000_000 }, (err, out) => resolve(err ? undefined : out.split("\n").filter(Boolean).length));
    });
    memo.set(path, { at: Date.now(), n });
    return n;
  };
}

export interface BarDeps {
  log: (line: string) => void;
  /** places this extension knew before (its older recent list): workspace files of sets */
  extraPlaces?: () => string[];
}

export interface BarHandle {
  api: BarApi;
  engine: BarEngine;
  /** a command changed what the buttons show */
  changed: () => void;
}

export function registerBar(ctx: vscode.ExtensionContext, deps: BarDeps): BarHandle {
  const dirtyOf = dirtyCounter();
  // changes and ahead come from the git extension of VS Code when it is running (no process of ours); behind the target is one git call per repository after a HEAD change
  const behind = new BehindMemo(gitRun);
  const gitRepos = (): GitRepoLike[] | undefined => {
    const ext = vscode.extensions.getExtension("vscode.git");
    return ext?.isActive ? (ext.exports?.getAPI?.(1)?.repositories as GitRepoLike[] | undefined) : undefined;
  };
  // the pull requests of the set: one aihub call for the whole set, remembered for minutes, never on a timer
  const prs = new PrMemo(async () => {
    const f = openFacts(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
    const cwd = f.set?.repos[0]?.path;
    if (!cwd) return [];
    const out = await cli(["pr", "list", "--mine", "--status", "all", "--json"], cwd);
    return JSON.parse(out.slice(out.search(/[[{]/))) as PrRow[];
  });
  const engine = new BarEngine({
    env: process.env,
    dir: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    dirtyOf,
    linkedOf,
    extraPlaces: deps.extraPlaces,
    statusOf: async (path, name) => ({ ...(gitStatusOf(gitRepos() ?? [], path) ?? {}), ...(await behind.behind(path, name).then((n) => (n === undefined ? {} : { behindTarget: n }))) }),
    prOf: (repo, branch) => prOfBranch(prs.get(), repo, branch),
  });
  const emitter = new vscode.EventEmitter<void>();
  let debounce: NodeJS.Timeout | undefined;
  const changed = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => emitter.fire(), 300);
  };
  const setFile = new SetFileWatcher({ log: deps.log, changed });
  const api: BarApi = {
    getState: () => {
      watchHeads();
      // opening a set (or its overview menu) reads the pull requests once, then they are remembered for minutes
      if (openFacts(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath).set) void prs.refresh().then(changed);
      return engine.state();
    },
    onDidChangeState: emitter.event,
  };

  // ---- what changes the state: the folder of this window, and the branch of its repositories --------------------
  let heads: vscode.Disposable[] = [];
  let watched = "";
  // the folder name in the Explorer and repos[].branch follow the real HEAD, whoever switched: files only, debounced, written only when they differ
  const nameTimers = new Map<string, NodeJS.Timeout>();
  function syncName(repoPath: string, setFolder: string) {
    clearTimeout(nameTimers.get(repoPath));
    nameTimers.set(
      repoPath,
      setTimeout(() => {
        nameTimers.delete(repoPath);
        try {
          const ws = vscode.workspace.workspaceFile;
          const r = syncRepoName({ setFolder, workspaceFile: ws?.scheme === "file" ? ws.fsPath : undefined, repoPath });
          if (r.workspace || r.setFile) deps.log(`names follow HEAD: ${repoPath} (workspace file ${r.workspace ? "written" : "same"}, set file ${r.setFile ? "written" : "same"})`);
        } catch (e) {
          deps.log(`names follow HEAD: ${(e as Error).message}`);
        }
      }, 600),
    );
  }
  /** One watcher per repository of the open set (or the one repository): its HEAD only, set up when a button first asks. */
  function watchHeads() {
    const facts = openFacts(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
    const paths = facts.set ? facts.set.repos.map((r) => r.path) : facts.repo ? [facts.repo.path] : [];
    setFile.aim();
    const key = paths.join("|");
    if (key === watched) return;
    watched = key;
    heads.forEach((h) => h.dispose());
    heads = paths.flatMap((p) => {
      // a worktree's HEAD is in the main clone's .git/worktrees/<name>; a clone's in its own .git
      const gitDir = gitDirFor(p);
      if (!gitDir) return [];
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(gitDir), "HEAD"));
      const onHead = () => {
        behind.forget(p);
        changed();
        if (facts.set) syncName(p, facts.set.folder);
      };
      w.onDidChange(onHead);
      w.onDidCreate(onHead);
      return [w];
    });
  }
  ctx.subscriptions.push(
    emitter,
    setFile,
    { dispose: () => (clearTimeout(debounce), nameTimers.forEach((t) => clearTimeout(t)), heads.forEach((h) => h.dispose())) },
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      engine.noteOpen();
      changed();
    }),
  );
  // the window shows a set or a repository: remember it (a few seconds after startup, file reads only)
  const first = setTimeout(() => (engine.noteOpen(), changed()), 4000);
  ctx.subscriptions.push({ dispose: () => clearTimeout(first) });
  const askContinue = setTimeout(() => void offerContinue(deps), 6000);
  ctx.subscriptions.push({ dispose: () => clearTimeout(askContinue) });

  registerCommands(ctx, engine, deps, changed, { prs, behind });
  return { api, engine, changed };
}

/**
 * An empty window (no folder): one notification with where you were, one button. Why a notification and not a
 * panel: it names the last set or repository, asks nothing else, and goes away by itself; the Explorer's welcome view
 * keeps a static "Continue where you were" link for later. Never starts a process.
 */
async function offerContinue(deps: BarDeps): Promise<void> {
  if (!windowIsEmpty() || !cfg().get<boolean>("continueWhereYouWere", true)) return;
  const last = readRecentUse(process.env).find((r) => existsSync(r.id));
  if (!last) return;
  const open = `Open ${last.label}`;
  const pick = await vscode.window.showInformationMessage(`Continue where you were: ${last.label}${last.detail ? ` (${last.detail})` : ""}, ${ago(last.lastUsed, Date.now())}`, open);
  if (pick === open) {
    deps.log(`continue where you were: ${last.id}`);
    await openPath(last.id, "this");
  }
}

// ---- commands ------------------------------------------------------------------------------------------------

const idOf = (a: unknown): string | undefined => (typeof a === "string" ? a : a && typeof a === "object" && "id" in a ? String((a as { id: unknown }).id) : undefined);

function registerCommands(ctx: vscode.ExtensionContext, engine: BarEngine, deps: BarDeps, changed: () => void, memo: { prs: PrMemo; behind: BehindMemo }): void {
  const { prs, behind } = memo;
  const fail = (e: unknown) => {
    if (e instanceof CliProblem) {
      const copy = "Copy update command";
      const run = "Update now";
      void vscode.window.showWarningMessage(`AI Context Hub: ${e.message}`, copy, run).then((pick) => {
        if (pick === copy) void vscode.env.clipboard.writeText(e.updateCommand);
        if (pick === run) {
          const t = vscode.window.createTerminal("aihub update");
          t.show();
          t.sendText(e.updateCommand);
        }
      });
      return;
    }
    void vscode.window.showErrorMessage(`AI Context Hub: ${(e as Error).message}`);
  };
  const reg = (id: string, f: (...a: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, (...a) => Promise.resolve(f(...a)).catch(fail)));

  // the overview menu opens: read the pull requests again (at most once per call, a failed call is remembered like a good one)
  reg(BAR_COMMANDS.refreshStatus, async () => {
    await prs.refresh(true);
    behind.forget();
    changed();
  });

  reg(BAR_COMMANDS.refresh, async () => {
    engine.scan({ refresh: true });
    changed();
  });

  reg(BAR_COMMANDS.openRepository, async (arg?: unknown) => {
    const given = typeof arg === "string" ? arg : (arg as { path?: string } | undefined)?.path;
    const path = given ?? (await pickRepository(engine));
    if (!path) return;
    if (!existsSync(path)) return void vscode.window.showWarningMessage(`AI Context Hub: ${path} does not exist (any more).`);
    deps.log(`open repository ${path}`);
    await openPath(path);
  });

  reg(BAR_COMMANDS.openSet, async (arg?: unknown) => {
    const id = idOf(arg);
    if (!id) return;
    const set = engine.scan().sets.find((s) => pathKey(s.id) === pathKey(id) || pathKey(s.folder) === pathKey(id));
    const target = set?.id ?? id;
    if (!existsSync(target)) return void vscode.window.showWarningMessage(`AI Context Hub: the set ${target} is gone; refresh the list.`);
    deps.log(`open set ${target}`);
    await openPath(target);
  });

  reg(BAR_COMMANDS.openRecent, async (arg?: unknown) => {
    const id = idOf(arg);
    const item = id ? readRecentUse(process.env).find((r) => pathKey(r.id) === pathKey(id)) : undefined;
    if (!item) return void vscode.window.showWarningMessage("AI Context Hub: that item is not in the recent list.");
    if (!existsSync(item.id)) {
      forgetUse(process.env, item.id);
      changed();
      return void vscode.window.showWarningMessage(`AI Context Hub: ${item.label} is gone (${item.id}); it was taken off the list.`);
    }
    deps.log(`open recent ${item.kind} ${item.id}`);
    await openPath(item.id);
  });

  reg(BAR_COMMANDS.reopenLast, async () => {
    const here = openFacts(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
    const hereKey = pathKey(here.set?.folder ?? here.repo?.path ?? "\u0000");
    // the newest item that is not what this window shows (in an empty window: simply the newest)
    const item = readRecentUse(process.env).find((r) => existsSync(r.id) && !pathKey(r.id).startsWith(hereKey));
    if (!item) return void vscode.window.showInformationMessage("AI Context Hub: nothing recent to go back to yet.");
    await openPath(item.id);
  });

  reg(BAR_COMMANDS.lookIn, async () => {
    for (;;) {
      const folders = engine.folders();
      type Row = vscode.QuickPickItem & { act: "add" | "refresh" | "remove"; folder?: string };
      const last = engine.scan();
      const rows: Row[] = [
        ...(last.truncated ? [{ label: "$(warning) Not everything was scanned", description: "too many folders: narrow Folders to Look In...", act: "refresh" as const }] : []),
        ...(last.skippedRemote?.length ? [{ label: "$(cloud) OneDrive and network folders were left out", description: "add one below to scan it", act: "refresh" as const }] : []),
        { label: "$(add) Add a folder...", description: "repositories and sets below it are found (a few levels deep)", act: "add" },
        { label: "$(refresh) Look again now", description: "the result is kept for a few minutes", act: "refresh" },
        { label: "Folders to look in", kind: vscode.QuickPickItemKind.Separator, act: "refresh" },
        ...folders.map((f) => ({ label: `$(folder) ${basename(f) || f}`, description: f, detail: "Select to remove it from the list", act: "remove" as const, folder: f })),
      ];
      const pick = await vscode.window.showQuickPick(rows, { title: "Folders to Look In", placeHolder: "Where repositories and worktree sets are looked for (only when a menu opens)" });
      if (!pick) return;
      if (pick.act === "add") {
        const chosen = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: true, openLabel: "Look in this folder" });
        if (chosen?.length) writeLookIn(process.env, [...folders, ...chosen.map((u) => u.fsPath)]);
      } else if (pick.act === "remove" && pick.folder) {
        writeLookIn(process.env, folders.filter((f) => pathKey(f) !== pathKey(pick.folder!)));
      } else forgetScan(process.env);
      engine.scan({ refresh: true });
      changed();
    }
  });

  registerStoryCommands({ engine, log: deps.log, changed, reg });
  registerSetOps({ engine, log: deps.log, changed, reg });
}

async function pickRepository(engine: BarEngine): Promise<string | undefined> {
  const state: BarState = await engine.state();
  type Row = vscode.QuickPickItem & { path?: string; browse?: boolean };
  const rows: Row[] = [
    { label: "$(folder-opened) Browse...", description: "any folder with a repository", browse: true },
    { label: "Repositories on this PC", kind: vscode.QuickPickItemKind.Separator },
    ...state.repositories.map((r) => ({ label: r.name, description: `${r.branch}${r.otherClones ? `  +${r.otherClones} more` : ""}`, detail: r.path, path: r.path })),
  ];
  const pick = await vscode.window.showQuickPick(rows, { title: "Open Repository", placeHolder: "A repository on this PC, or browse", matchOnDetail: true });
  if (!pick) return undefined;
  if (!pick.browse) return pick.path;
  const chosen = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: "Open" });
  return chosen?.[0]?.fsPath;
}
