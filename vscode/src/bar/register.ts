import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import * as vscode from "vscode";
import { forgetScan, gitDirFor, writeLookIn } from "../../../cli/src/lib/machineScan";
import { forgetUse, pathKey, readRecentUse, ago } from "../../../cli/src/lib/recentUse";
import { syncRepoName } from "../../../cli/src/lib/workspaceNames";
import { CliProblem } from "./cliCheck";
import { BarEngine, openFacts, setWorkspaceDirSource } from "./engine";
import { BACKGROUND_ENV, gitRun } from "./ownWindow";
import { cli, jsonOf } from "./runner";
import { RemoteRepos } from "./remoteRepos";
import { registerSearchCommands } from "./searchUi";
import { registerPipelineCommands } from "./pipelinesUi";
import { registerBrowseCommands } from "./browseUi";
import { registerOpenReposAsSet } from "./openReposAsSetUi";
import { registerWikiCommands } from "./wikiUi";
import { registerStoryBrowserCommands } from "./storiesUi";
import { SizeMemo } from "./setSize";
import { showFailure } from "./failureUi";
import { withCloneRecovery } from "./missingCloneUi";
import { hideClone, setPreferredClone } from "./hiddenClones";
import { BehindMemo, gitStatusOf, targetOf, prOfBranch, PrMemo, type GitRepoLike, type PrRow, prListCalls } from "./repoStatus";
import { registerCloneCommands } from "./cloneUi";
import { linkedOf, registerStoryCommands } from "./storyUi";
import { registerSetOps, SetFileWatcher } from "./setOps";
import { registerBatchCommands, registerPullRequestCommand } from "./batchUi";
import { registerUndoCommand, setCustomUndo, undoLabel, undoLast } from "./undoUi";
import { BehindManager } from "./behindRun";
import { FETCH_FRESH_MS, FetchGate, Told, headSha, openCheckDelay, operationInProgress, type FetchStore } from "./behind";
import { gitRaw } from "./ownWindow";
import { configHome } from "../../../cli/src/lib/configHome";
import { writeAtomic } from "../../../cli/src/lib/setFile";
import { openPath, windowIsEmpty } from "./window";
import { BAR_COMMANDS, type BarApi, type BarState } from "./types";
import { PrCommentsController } from "../comments/ui";
import type { Seen, Target } from "../comments/model";

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
      execFile("git", ["--no-optional-locks", "status", "--porcelain"], { cwd: path, timeout: 10_000, env: BACKGROUND_ENV, windowsHide: true, maxBuffer: 4_000_000 }, (err, out) => resolve(err ? undefined : out.split("\n").filter(Boolean).length));
    });
    memo.set(path, { at: Date.now(), n });
    return n;
  };
}

export interface BarDeps {
  log: (line: string) => void;
  /** places this extension knew before (its older recent list): workspace files of sets */
  extraPlaces?: () => string[];
  /** puts a prompt in the chat ("Fix in chat" on a review thread) */
  toChat?: (text: string) => Promise<void>;
}

export interface BarHandle {
  api: BarApi;
  engine: BarEngine;
  /** a command changed what the buttons show */
  changed: () => void;
  /** the review comments of the pull requests (the single-repository status bar hands it its pull request) */
  comments: PrCommentsController;
}

export function registerBar(ctx: vscode.ExtensionContext, deps: BarDeps): BarHandle {
  // a set whose first folder is a repository outside the set folder is found from the set file next to the workspace file
  setWorkspaceDirSource(() => {
    const f = vscode.workspace.workspaceFile;
    return f?.scheme === "file" ? dirname(f.fsPath) : undefined;
  });
  const dirtyOf = dirtyCounter();
  // changes and ahead come from the git extension of VS Code when it is running (no process of ours); behind the target is one git call per repository after a HEAD change
  const behind = new BehindMemo(gitRun);
  const gitRepos = (): GitRepoLike[] | undefined => {
    const ext = vscode.extensions.getExtension("vscode.git");
    return ext?.isActive ? (ext.exports?.getAPI?.(1)?.repositories as GitRepoLike[] | undefined) : undefined;
  };
  // the pull requests of the set: one aihub call for the whole set, remembered for minutes, never on a timer
  const prs = new PrMemo(async (builds) => {
    const f = openFacts(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
    const cwd = f.set?.repos[0]?.path;
    if (!cwd) return [];
    const rows: PrRow[] = [];
    for (const args of prListCalls(f.set!.repos.map((r) => r.branch), builds)) {
      const out = await cli(args, cwd);
      rows.push(...(JSON.parse(out.slice(out.search(/[[{]/))) as PrRow[]));
    }
    return rows;
  });
  const unpushed = new Map<string, { at: number; n: Promise<number | undefined> }>();
  const unpushedOf = (path: string): Promise<number | undefined> => {
    const hit = unpushed.get(path);
    if (hit && Date.now() - hit.at < DIRTY_TTL_MS) return hit.n;
    const n = gitRun(path, ["rev-list", "--count", "HEAD", "--not", "--remotes"]).then((o) => Number(o.trim()) || 0, () => undefined);
    unpushed.set(path, { at: Date.now(), n });
    return n;
  };
  // the sizes are kept in a file with their time (a set is measured at most once a day), never measured while the window has no focus
  const sizes = new SizeMemo(undefined, { file: join(configHome(process.env), "sizes.json"), focused: () => vscode.window.state.focused });
  // behind the target branch: a fetch of the target per repository after each other, the question or the update as aiContextHub.behindTarget says
  let openedChecked = false;
  const activatedAt = Date.now();
  // the times of the last fetches are kept in a file: a reload or a second window on the same set does not fetch again
  const fetchFile = join(configHome(process.env), "fetched.json");
  const fetchStore: FetchStore = {
    read: () => {
      try {
        return JSON.parse(readFileSync(fetchFile, "utf8")) as Record<string, { ok: boolean; at: number }>;
      } catch {
        return {};
      }
    },
    write: (rec) => {
      try {
        mkdirSync(configHome(process.env), { recursive: true });
        writeAtomic(fetchFile, JSON.stringify(rec));
      } catch {
        /* a note that is not kept only means one more fetch */
      }
    },
  };
  const toldFile = join(configHome(process.env), "behind-told.json");
  const behindMgr = new BehindManager({
    git: gitRun,
    raw: gitRaw,
    count: (path, name) => behind.behind(path, name),
    cli: (args, cwd) => cli(args, cwd),
    gate: new FetchGate(gitRun, Date.now, fetchStore),
    told: new Told(
      () => {
        try {
          return (JSON.parse(readFileSync(toldFile, "utf8")) as { keys?: string[] }).keys ?? [];
        } catch {
          return [];
        }
      },
      (keys) => {
        try {
          mkdirSync(configHome(process.env), { recursive: true });
          writeAtomic(toldFile, JSON.stringify({ keys }));
        } catch {
          /* a note that is not kept only means the same stand is told again */
        }
      },
    ),
    ui: {
      mode: () => (cfg().get<string>("behindTarget", "auto") as "ask" | "auto" | "off"),
      setAuto: async () => void (await cfg().update("behindTarget", "auto", vscode.ConfigurationTarget.Global)),
      focused: () => vscode.window.state.focused,
      repos: () => {
        const f = openFacts(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
        const changes = (p: string) => gitStatusOf(gitRepos() ?? [], p)?.changes;
        return f.set ? f.set.repos.map((r) => ({ name: r.name, path: r.path, branch: r.branch, changes: changes(r.path) })) : f.repo ? [{ name: f.repo.name, path: f.repo.path, branch: f.repo.branch, changes: changes(f.repo.path) }] : [];
      },
      setFolder: () => openFacts(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath).set?.folder,
      ask: async (message, buttons) => vscode.window.showInformationMessage(`AI Context Hub: ${message}`, ...buttons),
      said: (line, undo) => {
        void vscode.window.showInformationMessage(`AI Context Hub: ${line}`, ...(undo ? ["Undo"] : [])).then((pick) => {
          if (pick === "Undo" && undo) void undoLast({ log: deps.log, changed, afterGit: () => behind.forget() });
        });
        if (undo) setCustomUndo({ engine, log: deps.log, changed, reg: () => undefined }, undo.label, undo.run);
        deps.log(line);
      },
      changed: (p) => {
        behind.forget(p);
        changed();
      },
    },
  });
  // the Azure DevOps list for the search: read only when the search asks, once a day, never without focus
  const remote = new RemoteRepos({
    env: process.env,
    // a minimised test window never has the focus; aiContextHub.searchWithoutFocus lets it read (test windows only)
    focused: () => vscode.window.state.focused || vscode.workspace.getConfiguration("aiContextHub").get<boolean>("searchWithoutFocus", false) === true,
    changed: () => changed(),
    read: async ({ refresh }) => {
      // the CLI needs one clone of Azure DevOps to know the organisation; its sign-in is the one the CLI already has
      const cwd = engine.scan().repos.find((r) => /dev\.azure\.com|visualstudio\.com/i.test(r.remote ?? ""))?.path;
      if (!cwd) throw new Error("no clone of Azure DevOps on this PC yet: the organisation is not known");
      const out = await cli(["repos", "ado", "--json", ...(refresh ? ["--refresh"] : [])], cwd);
      return (jsonOf<{ repos?: { name: string; project: string; remoteUrl: string }[] }>(out).repos ?? []).map((r) => ({ name: r.name, project: r.project, remoteUrl: r.remoteUrl }));
    },
  });
  const engine = new BarEngine({
    remote: (local) => remote.get(local),
    unpushedOf,
    sizes,
    undoLabel,
    env: process.env,
    dir: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    dirtyOf,
    linkedOf,
    extraPlaces: deps.extraPlaces,
    // behind the target is counted from the refs that are there (one rev-list per repository, remembered per pair of commits), also without focus and before any fetch; only the fetch waits for focus
    statusOf: async (path, name) => ({ ...(gitStatusOf(gitRepos() ?? [], path) ?? {}), ...(await behind.behind(path, name).then((n) => (n === undefined ? {} : { behindTarget: n, target: targetOf(path, name) }))) }),
    prOf: (repo, branch) => prOfBranch(prs.get(), repo, branch),
    prsKnown: () => prs.get().length > 0,
  });
  // the review comments: read with the pull requests (one aihub for all of them), placed in a file only when it opens
  const seenFile = join(configHome(process.env), "pr-comments-seen.json");
  const comments = new PrCommentsController({
    cli: (args, cwd) => cli(args, cwd),
    log: deps.log,
    changed: () => changed(),
    enabled: () => cfg().get<string>("prComments", "on") !== "off",
    toChat: deps.toChat,
    isSet: () => !!openFacts(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath).set,
    store: {
      read: () => {
        try {
          const j = JSON.parse(readFileSync(seenFile, "utf8")) as Partial<Seen>;
          return { threads: j.threads ?? {}, prs: j.prs ?? {}, told: j.told ?? {} };
        } catch {
          return { threads: {}, prs: {} };
        }
      },
      write: (s) => {
        mkdirSync(configHome(process.env), { recursive: true });
        writeAtomic(seenFile, JSON.stringify(s));
      },
    },
  }).register(ctx);
  /** The repositories of the open set with an active pull request (from the pull request list that was read). */
  const commentTargets = (): Target[] => {
    const f = openFacts(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
    return (f.set?.repos ?? []).flatMap((r) => {
      const pr = prOfBranch(prs.get(), r.name, r.branch);
      return pr && pr.status !== "merged" ? [{ repo: r.name, path: r.path, pr: pr.id, url: pr.url }] : [];
    });
  };
  const readComments = (force = false) => {
    if (openFacts(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath).set) comments.setTargets(commentTargets());
    return comments.refresh(force);
  };
  /** The state with the review comments in it (counts per pull request, the list for the overview). */
  const fullState = async (): Promise<BarState> => {
    const s = await engine.state();
    for (const r of s.repos) {
      const c = r.pr && r.pr.status !== "merged" ? comments.countsOf(r.name, r.pr.id) : undefined;
      if (c && r.pr) r.pr = { ...r.pr, comments: c };
    }
    const list = comments.list();
    return list ? { ...s, openComments: list } : s;
  };
  const emitter = new vscode.EventEmitter<void>();
  let debounce: NodeJS.Timeout | undefined;
  // what the last state the buttons read looked like: an event goes out only when the state really differs (every listener reads git again per event)
  let lastState: string | undefined;
  const changed = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      void fullState().then(
        (s) => {
          const now = JSON.stringify(s);
          if (now === lastState) return;
          lastState = now;
          emitter.fire();
        },
        () => emitter.fire(),
      );
    }, 300);
  };
  const setFile = new SetFileWatcher({ log: deps.log, changed });
  const api: BarApi = {
    getState: () => {
      watchHeads();
      attachGit();
      // opening a set (or its overview menu) reads the pull requests once, then they are remembered for minutes
      const f = openFacts(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
      if (f.set) void prs.refresh().then((read) => (read && changed(), void readComments()));
      // the first state of a window with a set or a repository: look at the target branch once (a fetch per repository, never without focus)
      if ((f.set || f.repo) && !openedChecked) {
        openedChecked = true;
        // a few seconds after the window opened, never before: the first state and every click come first
        setTimeout(() => void behindMgr.run("open"), openCheckDelay(activatedAt, Date.now()));
      }
      return fullState().then((s) => ((lastState = JSON.stringify(s)), s));
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
        // in the middle of a rebase or merge HEAD changes at every step: the names follow when it is over
        if (operationInProgress(repoPath)) return;
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
    // the folder names in the Explorer are right when a set is opened, not only after a switch (files only, written only when they differ)
    if (facts.set) for (const p of paths) syncName(p, facts.set.folder);
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
    gitSubs.forEach((s) => s.dispose());
    gitSubs.clear();
    attachGit();
  }
  // What the git extension of VS Code knows (changed files, commits ahead) and a commit, merge or pull in a terminal reach the bar through its
  // state-change event: no watcher of ours, no process. An event goes out only when changes, ahead or the commit differ from what was last seen
  // (the extension also says "changed" at every saved file). The extension may start after us and open repositories later: tried again at every
  // state read and whenever it opens a repository.
  const gitSubs = new Map<string, { dispose(): unknown }>();
  const gitSeen = new Map<string, string>();
  let openSub: { dispose(): unknown } | undefined;
  function attachGit() {
    const facts = openFacts(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
    const paths = facts.set ? facts.set.repos.map((r) => r.path) : facts.repo ? [facts.repo.path] : [];
    const repos = gitRepos();
    if (!repos) return;
    if (!openSub) {
      const api = vscode.extensions.getExtension("vscode.git")?.exports?.getAPI?.(1) as { onDidOpenRepository?: (l: () => void) => { dispose(): unknown } } | undefined;
      openSub = api?.onDidOpenRepository?.(() => (attachGit(), changed()));
      if (openSub) ctx.subscriptions.push(openSub);
    }
    for (const p of paths) {
      if (gitSubs.has(p)) continue;
      const gr = repos.find((x) => pathKey(x.rootUri.fsPath) === pathKey(p));
      const sub = gr?.state.onDidChange?.(() => {
        const st = gitStatusOf(gitRepos() ?? [], p);
        const now = `${st?.changes}|${st?.ahead}|${headSha(p)}`;
        if (gitSeen.get(p) === now) return;
        gitSeen.set(p, now);
        changed();
      });
      if (sub) {
        gitSubs.set(p, sub);
        const st = gitStatusOf(repos, p);
        gitSeen.set(p, `${st?.changes}|${st?.ahead}|${headSha(p)}`);
      }
    }
  }
  ctx.subscriptions.push(
    emitter,
    setFile,
    { dispose: () => (clearTimeout(debounce), nameTimers.forEach((t) => clearTimeout(t)), heads.forEach((h) => h.dispose()), gitSubs.forEach((s) => s.dispose())) },
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

  registerCommands(ctx, engine, deps, changed, { prs, behind, mgr: behindMgr, remote, readComments, comments });
  // the window gets focus back and the last successful fetch is over 30 minutes ago: look again (one fetch per repository)
  ctx.subscriptions.push(
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused && openedChecked && Date.now() - behindMgr.gate.lastOk() > FETCH_FRESH_MS) void behindMgr.run("focus");
      // back in the window after more than 5 minutes: the comments may have new replies (never without focus)
      if (s.focused) comments.focusBack();
    }),
  );
  return { api, engine, changed, comments };
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

function registerCommands(ctx: vscode.ExtensionContext, engine: BarEngine, deps: BarDeps, changed: () => void, memo: { prs: PrMemo; behind: BehindMemo; mgr: BehindManager; remote: RemoteRepos; readComments: (force?: boolean) => Promise<boolean>; comments: PrCommentsController }): void {
  const { prs, behind, mgr, readComments, comments } = memo;
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
    showFailure(e);
  };
  const reg = (id: string, f: (...a: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, (...a) => withCloneRecovery(async () => f(...a)).catch(fail)));

  // pipelines in the bar: one aihub process per call, only when the bar asks
  registerPipelineCommands(reg, (t) => deps.toChat?.(t));
  // the repository browser: one aihub process per call, only when the browser asks
  registerBrowseCommands(reg);
  // the wiki browser: one aihub process per call, only when the wiki view asks; the agent actions put text in the chat
  registerWikiCommands(reg, (t) => deps.toChat?.(t));
  registerStoryBrowserCommands(reg);

  // the overview menu opens: read the pull requests again (at most once per call, a failed call is remembered like a good one)
  reg(BAR_COMMANDS.refreshStatus, async () => {
    await prs.refresh(true);
    behind.forget();
    changed();
    // the overview shows the open comments: read them with the pull requests
    void readComments(true);
    // the overview menu opens: look at the target branch too
    void mgr.run("menu");
  });

  reg(BAR_COMMANDS.showComment, (arg?: { repo?: string; threadId?: number }) => comments.showComment(arg));
  reg(BAR_COMMANDS.refreshComments, async () => {
    // no pull request known yet (a set that just opened): read the pull requests first
    if (!comments.hasTargets()) await prs.refresh(true);
    await readComments(true);
  });

  // the left menu opens: measure the sets in the background, the state gets the sizes as they come in
  reg(BAR_COMMANDS.measureSets, (arg?: { force?: boolean }) => void engine.measureSets(changed, { force: arg?.force === true }).catch(() => undefined));
  // which clone of a repository is used, and which are taken out of the list (personal, files in the aihub config home)
  reg(BAR_COMMANDS.useClone, (arg?: { name?: string; path?: string }) => {
    if (!arg?.path || !arg.name) return;
    setPreferredClone(process.env, arg.name, arg.path);
    forgetScan(process.env);
    changed();
  });
  reg(BAR_COMMANDS.removeClone, (arg?: { path?: string }) => {
    if (!arg?.path) return;
    hideClone(process.env, arg.path);
    forgetScan(process.env);
    changed();
  });
  // the clean-up dialog opens: now the uncommitted work of the sets that can be removed is looked at
  reg(BAR_COMMANDS.checkClean, () => void engine.checkClean(changed).catch(() => undefined));

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

  registerStoryCommands({ engine, log: deps.log, changed, reg, afterGit: () => behind.forget() });
  // Open as Set… (repository browser) and New Set… (title bar): clones what is missing, one aihub worktree open, the window, Undo
  registerOpenReposAsSet({ engine, log: deps.log, changed, reg, afterGit: () => behind.forget() });
  // after an own Update or Push the stand against the target is looked at again
  registerBatchCommands({ engine, log: deps.log, changed, reg, afterGit: () => (behind.forget(), void mgr.run("own")) });
  registerPullRequestCommand({ engine, log: deps.log, changed, reg, refreshPrs: () => prs.refresh(true).then(() => undefined) });
  registerCloneCommands({ engine, log: deps.log, changed, reg, afterGit: () => behind.forget() });
  registerUndoCommand({ engine, log: deps.log, changed, reg, afterGit: () => behind.forget() });
  registerSetOps({ engine, log: deps.log, changed, reg });
  registerSearchCommands({ engine, remote: memo.remote, log: deps.log, changed, reg });
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
