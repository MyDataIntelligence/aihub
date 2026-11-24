import { readLocalSet, RepoSetController } from "./repoSetUi";
import { reposetStatus } from "./repoSetModel";
import { windowSet } from "./storyModel";
import { registerStories } from "./storyUi";
import { RecentStore, registerRecents, rememberStory } from "./recentsUi";
import * as vscode from "vscode";
import { ACTIONS, actionById, actionsFor, isOpencodeTerminalName, pickTarget, type ChatSetting, type ChatTarget } from "./actions";
import { checkCli, CLI_VERSION_KEY, cliVersionStillKnown, CliError, INSTALL_COMMAND, makeRunner, type CachedCliVersion, type Runner } from "./cli";
import { chatOpenArgs, copilotAgentInstalled } from "./agents";
import { BarLoader } from "./data";
import { renderBody, renderError, renderPage } from "./html";
import { popupFor } from "./popups";
import { statusItems, type BarError, type BarModel, type StatusItem, type Tone } from "./model";
import { Refresher, type Result } from "./refresher";
import { registerGitCommands } from "./gitUi";
import { ThreadsController } from "./threadsUi";
import { LearnController } from "./learnUi";
import { registerWorktreeCommands } from "./worktreeUi";
import { clearTrackedInterval, clearTrackedTimeout, count, trackedInterval, trackedTimeout, trackedWatcher } from "./perf/probe";
import { startPerf, stopPerf } from "./perfUi";

const cfg = () => vscode.workspace.getConfiguration("aihub");

/** The folder whose repository the bar shows: the one of the active editor, else the first. */
function repoFolder(): string | undefined {
  const ed = vscode.window.activeTextEditor?.document.uri;
  const f = (ed && vscode.workspace.getWorkspaceFolder(ed)) ?? vscode.workspace.workspaceFolders?.[0];
  return f?.uri.fsPath;
}

class Bar implements vscode.WebviewViewProvider, vscode.Disposable {
  private log = vscode.window.createOutputChannel("AI Context Hub");
  private items = new Map<string, vscode.StatusBarItem>();
  /** The main entry for several repositories on one branch: next to the built-in branch item (priority 11000). */
  private reposetItem?: vscode.StatusBarItem;
  private view: vscode.WebviewView | undefined;
  private last: Result | undefined;
  private refresher: Refresher;
  private runner!: Runner;
  private loader!: BarLoader;
  private cliChecked = false;
  private cwd: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private gitDebounce: NodeJS.Timeout | undefined;
  private subs: vscode.Disposable[] = [];
  /** Called after every successful read (the review threads follow the PR). */
  onModel: ((m: BarModel) => void) | undefined;
  /** Called after every read, ok or not (the activation timer waits for the first one). */
  onPublish: ((ok: boolean) => void) | undefined;

  constructor(private ctx: vscode.ExtensionContext) {
    this.refresher = new Refresher(
      async () => {
        if (!this.cwd) throw new CliError("failed", "Open a folder with a git repository to see its story, pull request and pipeline.");
        if (!this.cliChecked) await this.checkCliOnce(this.cwd);
        try {
          return await this.loader.load();
        } catch (e) {
          // gone or replaced: ask for the version again next time
          if (e instanceof CliError && e.kind === "missing") (this.cliChecked = false), void this.ctx.globalState.update(CLI_VERSION_KEY, undefined);
          throw e;
        }
      },
      (r) => this.publish(r),
      { minGapMs: () => this.intervalMs() },
    );
    this.configure();
    this.subs.push(
      vscode.window.registerWebviewViewProvider("aihub.bar", this, { webviewOptions: { retainContextWhenHidden: true } }),
      vscode.window.onDidChangeWindowState((s) => {
        count("event.windowState");
        this.refresher.focused = s.focused;
        if (s.focused) void this.refresher.request("focus");
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("aihub")) {
          this.configure();
          void this.refresher.request("manual");
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.configure()),
      vscode.window.onDidChangeActiveTextEditor(() => {
        count("event.activeEditor");
        if (repoFolder() !== this.cwd) {
          this.configure();
          void this.refresher.request("manual");
        }
      }),
    );
  }

  /** `aihub --version` at most once a day per CLI command: a known good version is remembered (one process less per window and settings change). */
  private async checkCliOnce(cwd: string) {
    const command = this.cliCommand();
    const known = this.ctx.globalState.get<CachedCliVersion>(CLI_VERSION_KEY);
    if (cliVersionStillKnown(known, command, Date.now())) {
      count("cli.versionCached");
    } else {
      const version = await checkCli(this.runner, cwd);
      void this.ctx.globalState.update(CLI_VERSION_KEY, { command, version, at: Date.now() } satisfies CachedCliVersion);
    }
    this.cliChecked = true;
  }

  private cliCommand() {
    return String(cfg().get("cliPath", "aihub")) || "aihub";
  }

  private intervalMs() {
    return Math.max(15, Number(cfg().get("refreshIntervalSeconds", 60))) * 1000;
  }

  /** (Re)builds the runner, the loader, the timer and the git watcher from the settings. */
  private configure() {
    this.cwd = repoFolder();
    // background reads never wait for a sign-in window: without a credential they fail at once and the bar says so
    const quiet = { GCM_INTERACTIVE: "never", GIT_TERMINAL_PROMPT: "0" };
    this.runner = makeRunner({ command: this.cliCommand(), timeoutMs: Math.max(5, Number(cfg().get("timeoutSeconds", 30))) * 1000, env: quiet });
    this.cliChecked = false;
    this.loader = new BarLoader(this.runner, { cwd: this.cwd ?? "", fabric: !!cfg().get("fabric.enabled", true), fabricTtlMs: Math.max(180_000, this.intervalMs() * 3), combined: "auto" });
    clearTrackedInterval(this.timer);
    this.timer = trackedInterval("bar.refresh", () => void this.refresher.request("timer"), this.intervalMs());
    this.watchGit();
  }

  private gitWatcher: vscode.FileSystemWatcher | undefined;
  private gitWatcherStats: ReturnType<typeof trackedWatcher> | undefined;
  private watchGit() {
    this.gitWatcher?.dispose();
    this.gitWatcherStats?.dispose();
    if (!this.cwd) return;
    const glob = ".git/{HEAD,refs/heads/**}";
    this.gitWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.cwd, glob));
    const stats = (this.gitWatcherStats = trackedWatcher("bar.gitBranch", glob));
    const fire = () => {
      stats.hit();
      clearTrackedTimeout(this.gitDebounce);
      this.gitDebounce = trackedTimeout("bar.gitDebounce", () => {
        this.loader.invalidate();
        void this.refresher.request("git");
      }, 1500);
    };
    this.gitWatcher.onDidChange(fire);
    this.gitWatcher.onDidCreate(fire);
  }

  start() {
    this.renderReposetItem();
    // Silent by default: no popup, no panel opening. The status bar is the entry; the first read is delayed so startup stays fast.
    trackedTimeout("bar.firstRead", () => void this.refresher.request("start"), 2000);
  }

  refresh(): Promise<void> {
    this.loader.invalidate();
    return this.refresher.request("manual");
  }

  // ---- display ---------------------------------------------------------------------------------

  private publish(r: Result) {
    this.last = r;
    if (r.ok) this.log.appendLine(`${new Date().toISOString()} ok ${r.model.branch} pr=${r.model.pr?.id ?? "-"} checks=${r.model.checks} threads=${r.model.openThreads} fabric=${r.model.fabric ? `${r.model.fabric.failed.length} failed` : "-"}`);
    else this.log.appendLine(`${new Date().toISOString()} ${r.error.kind}: ${r.error.message}`);
    this.renderStatusBar();
    this.renderView();
    this.onPublish?.(r.ok);
    if (r.ok) this.onModel?.(r.model);
  }

  private renderReposetItem() {
    const it = (this.reposetItem ??= vscode.window.createStatusBarItem("aihub.reposet", vscode.StatusBarAlignment.Left, 10999));
    it.name = "AI Context Hub: Open Repo Set";
    // a set is local: also without an `aihub status` answer (no Azure DevOps remote, offline) it shows its branch
    const show = (set: Parameters<typeof reposetStatus>[0]) => {
      const v = reposetStatus(set);
      it.text = v.text;
      it.tooltip = new vscode.MarkdownString(v.tooltip);
    };
    // a menu like PyCharm's Open / Recent Projects: open a repo set, a new set, a story, or a recent one
    it.command = "aihub.reposet.menu";
    // the set of the status read; else what the workspace file says (also for switched checkouts, which have no set file)
    show((this.last?.ok ? this.last.model.set : null) ?? windowSet(cfg().get("set")));
    it.show();
    // only after a failed status read (never at activation): the set file next to the folder, read once per folder
    if (this.last && !this.last.ok) {
      const last = this.last;
      void readLocalSet(this.cwd).then((set) => set && this.last === last && show(set));
    }
  }

  private renderStatusBar() {
    this.renderReposetItem();
    const r = this.last;
    if (!r) return;
    const wanted: StatusItem[] = r.ok
      ? statusItems(r.model)
      : [{ id: "story", text: r.error.kind === "no-repo" ? "$(git-branch) AI Hub" : `$(warning) aihub: ${r.error.kind === "missing" ? "not installed" : r.error.kind === "old" ? "update needed" : "no status"}`, tooltip: r.error.message, tone: "warn", command: "aihub.showBar" }];
    const keep = new Set(wanted.map((w) => w.id));
    for (const [id, item] of this.items) if (!keep.has(id as StatusItem["id"])) (item.dispose(), this.items.delete(id));
    wanted.forEach((w, i) => {
      let item = this.items.get(w.id);
      if (!item) {
        item = vscode.window.createStatusBarItem(`aihub.${w.id}`, vscode.StatusBarAlignment.Left, 100 - i);
        item.name = `AI Context Hub: ${w.id}`;
        this.items.set(w.id, item);
      }
      item.text = w.text;
      item.tooltip = w.tooltip;
      item.command = w.command;
      item.color = toneColor(w.tone);
      item.backgroundColor = w.tone === "bad" ? new vscode.ThemeColor("statusBarItem.errorBackground") : w.tone === "warn" && w.id !== "story" ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
      item.show();
    });
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const res = vscode.Uri.joinPath(this.ctx.extensionUri, "resources");
    view.webview.options = { enableScripts: true, localResourceRoots: [res] };
    view.webview.onDidReceiveMessage((m: { type: string; id?: string }) => void this.onMessage(m));
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    view.webview.html = renderPage(this.bodyHtml(), nonce, view.webview.cspSource, view.webview.asWebviewUri(vscode.Uri.joinPath(res, "codicon.css")).toString());
    view.onDidChangeVisibility(() => view.visible && void this.refresher.request("focus"));
  }

  private bodyHtml(): string {
    const r = this.last;
    if (!r) return `<div class="muted">Reading status...</div>`;
    return r.ok ? renderBody(r.model) : renderError(r.error);
  }

  private renderView() {
    void this.view?.webview.postMessage({ type: "render", html: this.bodyHtml() });
  }

  private async onMessage(m: { type: string; id?: string }) {
    switch (m.type) {
      case "chat":
        return void this.sendToChat(m.id ?? "");
      case "chip":
      case "menu":
        return this.showPopup(m.type === "menu" ? "menu" : (m.id ?? ""));
    }
  }

  /** Chips open a native pick list: details and secondary actions stay out of the bar. */
  private async showPopup(chip: string) {
    if (chip === "refresh") return void this.refresh();
    if (chip === "reposet") return void vscode.commands.executeCommand("aihub.reposet.open");
    if (chip === "installHelp") return void vscode.commands.executeCommand("aihub.installHelp");
    const model = this.model();
    if (!model) {
      const err = this.errorOf();
      return void vscode.window.showInformationMessage(err?.message ?? "No status yet.");
    }
    const popup = popupFor(chip, model);
    const items = popup.items.map((i) => (i.separator ? { label: "", kind: vscode.QuickPickItemKind.Separator } : { label: i.label, description: i.description, detail: i.detail, run: i.run }));
    const pick = (await vscode.window.showQuickPick(items as (vscode.QuickPickItem & { run?: (typeof popup.items)[number]["run"] })[], { title: popup.title, placeHolder: "Pick an action, or Esc" })) as { run?: (typeof popup.items)[number]["run"] } | undefined;
    if (!pick?.run) return;
    if (pick.run.kind === "chat") await this.sendToChat(pick.run.id);
    else if (pick.run.kind === "command") await vscode.commands.executeCommand(pick.run.id);
  }

  runnerNow(): Runner {
    return this.runner;
  }

  cwdNow(): string | undefined {
    return this.cwd;
  }

  model(): BarModel | undefined {
    return this.last?.ok ? this.last.model : undefined;
  }

  errorOf(): BarError | undefined {
    return this.last && !this.last.ok ? this.last.error : undefined;
  }

  logLine(line: string) {
    this.log.appendLine(`${new Date().toISOString()} ${line}`);
  }

  showLog() {
    this.log.show(true);
  }

  // ---- chat ------------------------------------------------------------------------------------

  /** Puts the action's text in the chat input. Never presses Enter; the user reads and sends it. */
  async sendToChat(actionId: string): Promise<void> {
    const action = actionById(actionId);
    if (!action) return;
    await this.sendText(action.text);
  }

  /** Puts any text in the chat input (an action, or a question about a selection). */
  async sendText(text: string): Promise<void> {
    const action = { text };
    const setting = cfg().get<ChatSetting>("chatTarget", "auto");
    const term = vscode.window.terminals.find((t) => isOpencodeTerminalName(t.name));
    const target: ChatTarget = pickTarget(setting, !!term);
    this.log.appendLine(`${new Date().toISOString()} chat ${target}: ${action.text}`);
    if (target === "opencode") {
      const t = term ?? (await this.openOpencodeTerminal());
      if (!t) return void vscode.window.showInformationMessage("Could not start opencode. Install it, or set aihub.chatTarget to copilot.");
      t.show(false);
      t.sendText(action.text, false);
      return;
    }
    const name = String(cfg().get("chatAgentName", "aihub"));
    const installed = copilotAgentInstalled(name, this.cwd);
    const args = chatOpenArgs(action.text, { agentName: name, agentInstalled: installed, agentMode: !!cfg().get("chatAgentMode", true) });
    this.log.appendLine(`${new Date().toISOString()} chat.open ${JSON.stringify(args)}`);
    try {
      await vscode.commands.executeCommand("workbench.action.chat.open", args);
    } catch {
      await vscode.commands.executeCommand("workbench.action.chat.open", { query: action.text, isPartialQuery: true });
    }
    if (!installed) void this.offerAgentInstall(name);
  }

  /** Once per machine: the aihub agent is not installed, so the chat opened with the default agent. */
  private async offerAgentInstall(name: string) {
    if (this.ctx.globalState.get("aihub.agentOfferShown")) return;
    await this.ctx.globalState.update("aihub.agentOfferShown", true);
    const copy = "Copy install command";
    const pick = await vscode.window.showInformationMessage(`The "${name}" chat agent is not installed, so the default agent was used. Install it with: aihub skills install`, copy);
    if (pick === copy) await vscode.env.clipboard.writeText("aihub skills install");
  }

  /** The opencode VS Code extension's command when it is installed, else a terminal named opencode that starts opencode with the aihub agent. */
  private async openOpencodeTerminal(): Promise<vscode.Terminal | undefined> {
    const cmds = await vscode.commands.getCommands(true);
    const open = ["opencode.openTerminal", "opencode.openNewTerminal"].find((c) => cmds.includes(c));
    if (open) {
      await vscode.commands.executeCommand(open);
      for (let i = 0; i < 10; i++) {
        const t = vscode.window.terminals.find((x) => isOpencodeTerminalName(x.name));
        if (t) return t;
        await new Promise((r) => setTimeout(r, 300));
      }
      return vscode.window.activeTerminal;
    }
    const name = String(cfg().get("chatAgentName", "aihub"));
    const t = vscode.window.createTerminal({ name: "opencode", cwd: this.cwd });
    t.show(false);
    t.sendText(`opencode --agent ${name}`, true);
    // give the TUI time to start before the text goes to its prompt
    await new Promise((r) => setTimeout(r, 12000));
    return t;
  }

  dispose() {
    clearTrackedInterval(this.timer);
    clearTrackedTimeout(this.gitDebounce);
    this.gitWatcher?.dispose();
    this.gitWatcherStats?.dispose();
    this.items.forEach((i) => i.dispose());
    this.reposetItem?.dispose();
    this.log.dispose();
    this.subs.forEach((s) => s.dispose());
  }
}

const toneColor = (t: Tone): vscode.ThemeColor | undefined => (t === "ok" ? new vscode.ThemeColor("charts.green") : t === "run" ? new vscode.ThemeColor("charts.blue") : undefined);

export function activate(ctx: vscode.ExtensionContext) {
  // first, so every command, notification and process after this is measured
  let bar: Bar | undefined;
  const act = startPerf(ctx, () => bar?.cwdNow());
  act.phase("bar (settings, panel, status bar listeners)");
  bar = new Bar(ctx);
  bar.onPublish = (ok) => act.firstRefresh(ok);
  act.phase("commands");
  activateRest(ctx, bar, act.phase);
  act.done();
}

function activateRest(ctx: vscode.ExtensionContext, bar: Bar, phase: (name: string) => void) {
  ctx.subscriptions.push(
    bar,
    vscode.commands.registerCommand("aihub.refresh", () => bar.refresh()),
    vscode.commands.registerCommand("aihub.showBar", () => vscode.commands.executeCommand("aihub.bar.focus")),
    vscode.commands.registerCommand("aihub.openLog", () => bar.showLog()),
    vscode.commands.registerCommand("aihub.sendToChat", (id?: string) => (id ? bar.sendToChat(id) : vscode.commands.executeCommand("aihub.actions"))),
    vscode.commands.registerCommand("aihub.openPr", async () => {
      const url = bar.model()?.pr?.url;
      if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    vscode.commands.registerCommand("aihub.actions", async () => {
      const m = bar.model();
      if (!m) return void vscode.commands.executeCommand("aihub.showBar");
      const pick = await vscode.window.showQuickPick(
        actionsFor(m).map((a) => ({ label: `$(${a.icon}) ${a.label}`, description: a.text.length > 40 ? "" : a.text, id: a.id })),
        { placeHolder: "Puts the command in your chat; you press Enter" },
      );
      if (pick) await bar.sendToChat(pick.id);
    }),
    vscode.commands.registerCommand("aihub.installHelp", async () => {
      const copy = "Copy command";
      const choice = await vscode.window.showInformationMessage(`Install or update the aihub CLI with: ${INSTALL_COMMAND}`, copy);
      if (choice === copy) await vscode.env.clipboard.writeText(INSTALL_COMMAND);
    }),
  );
  for (const a of ACTIONS) ctx.subscriptions.push(vscode.commands.registerCommand(`aihub.chat.${a.id}`, () => bar.sendToChat(a.id)));
  const selection = (verb: string) => async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.selection.isEmpty) return;
    const rel = vscode.workspace.asRelativePath(ed.document.uri);
    const text = `${verb} in ${rel} lines ${ed.selection.start.line + 1}-${ed.selection.end.line + 1}: `;
    await bar.sendText(text);
  };
  ctx.subscriptions.push(vscode.commands.registerCommand("aihub.editor.ask", selection("Question about the code")), vscode.commands.registerCommand("aihub.editor.suggestFix", selection("Suggest a fix for the code")));
  phase("review threads");
  const threads = new ThreadsController(() => bar.runnerNow(), () => bar.cwdNow(), (t) => bar.sendText(t), (l) => bar.logLine(l), () => void bar.refresh());
  threads.register(ctx);
  phase("learn view");
  const learn = new LearnController(ctx, () => bar.runnerNow(), () => bar.cwdNow(), (l) => bar.logLine(l));
  learn.register(ctx);
  bar.onModel = (m) => void threads.sync(m.pr && m.pr.status === "active" ? m.pr.id : undefined, m.openThreads);
  phase("branch menu");
  registerGitCommands(ctx, (l) => bar.logLine(l), (id) => bar.sendToChat(id));
  phase("repos on branch");
  const reposet = new RepoSetController(ctx, { cwd: () => bar.cwdNow(), log: (l) => bar.logLine(l), refresh: () => (refreshSets(), void bar.refresh()) });
  reposet.register();
  phase("my stories");
  const recents = new RecentStore(ctx.globalState);
  registerRecents(ctx, recents, reposet, (l) => bar.logLine(l));
  registerStories(ctx, { cwd: () => bar.cwdNow(), log: (l) => bar.logLine(l), opened: (s) => rememberStory(recents, s) });
  phase("worktree sets view");
  const refreshSets = registerWorktreeCommands(ctx, (l) => bar.logLine(l), (id) => bar.sendToChat(id), () => reposet.groups());
  phase("status bar");
  bar.start();
  // the groups come from the CLI: ask again once the first status read is behind us
  trackedTimeout("worktreeSets.firstRefresh", () => refreshSets(), 4000);
}

export function deactivate(): Promise<void> {
  return stopPerf();
}
