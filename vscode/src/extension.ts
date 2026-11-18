import * as vscode from "vscode";
import { actionById, actionsFor, isOpencodeTerminalName, pickTarget, type ChatSetting, type ChatTarget } from "./actions";
import { checkCli, CliError, INSTALL_COMMAND, makeRunner, type Runner } from "./cli";
import { chatOpenArgs, copilotAgentInstalled } from "./agents";
import { BarLoader } from "./data";
import { renderBody, renderError, renderPage } from "./html";
import { statusItems, type BarError, type BarModel, type StatusItem, type Tone } from "./model";
import { Refresher, type Result } from "./refresher";
import { registerGitCommands } from "./gitUi";
import { registerWorktreeCommands } from "./worktreeUi";

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

  constructor(private ctx: vscode.ExtensionContext) {
    this.refresher = new Refresher(
      async () => {
        if (!this.cwd) throw new CliError("failed", "Open a folder with a git repository to see its story, pull request and pipeline.");
        if (!this.cliChecked) {
          await checkCli(this.runner, this.cwd);
          this.cliChecked = true;
        }
        return this.loader.load();
      },
      (r) => this.publish(r),
      { minGapMs: () => this.intervalMs() },
    );
    this.configure();
    this.subs.push(
      vscode.window.registerWebviewViewProvider("aihub.bar", this, { webviewOptions: { retainContextWhenHidden: true } }),
      vscode.window.onDidChangeWindowState((s) => {
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
        if (repoFolder() !== this.cwd) {
          this.configure();
          void this.refresher.request("manual");
        }
      }),
    );
  }

  private intervalMs() {
    return Math.max(15, Number(cfg().get("refreshIntervalSeconds", 60))) * 1000;
  }

  /** (Re)builds the runner, the loader, the timer and the git watcher from the settings. */
  private configure() {
    this.cwd = repoFolder();
    this.runner = makeRunner({ command: String(cfg().get("cliPath", "aihub")) || "aihub", timeoutMs: Math.max(5, Number(cfg().get("timeoutSeconds", 30))) * 1000 });
    this.cliChecked = false;
    this.loader = new BarLoader(this.runner, { cwd: this.cwd ?? "", fabric: !!cfg().get("fabric.enabled", true), fabricTtlMs: Math.max(180_000, this.intervalMs() * 3) });
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.refresher.request("timer"), this.intervalMs());
    this.watchGit();
  }

  private gitWatcher: vscode.FileSystemWatcher | undefined;
  private watchGit() {
    this.gitWatcher?.dispose();
    if (!this.cwd) return;
    this.gitWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.cwd, ".git/{HEAD,refs/heads/**}"));
    const fire = () => {
      clearTimeout(this.gitDebounce);
      this.gitDebounce = setTimeout(() => {
        this.loader.invalidate();
        void this.refresher.request("git");
      }, 1500);
    };
    this.gitWatcher.onDidChange(fire);
    this.gitWatcher.onDidCreate(fire);
  }

  start() {
    // Silent by default: no popup, no panel opening. The status bar is the entry; the first read is delayed so startup stays fast.
    setTimeout(() => void this.refresher.request("start"), 2000);
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
  }

  private renderStatusBar() {
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
      case "refresh":
        return void this.refresh();
      case "openPr":
        return void vscode.commands.executeCommand("aihub.openPr");
      case "openLog":
        return this.log.show(true);
      case "installHelp":
        return void vscode.commands.executeCommand("aihub.installHelp");
      case "chat":
        return void this.sendToChat(m.id ?? "");
    }
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
    const setting = cfg().get<ChatSetting>("chatTarget", "auto");
    const term = vscode.window.terminals.find((t) => isOpencodeTerminalName(t.name));
    const target: ChatTarget = pickTarget(setting, !!term);
    this.log.appendLine(`${new Date().toISOString()} chat ${target}: ${action.text}`);
    if (target === "opencode") {
      const t = term ?? (await this.openOpencodeTerminal());
      if (!t) {
        void vscode.window.showInformationMessage("No opencode terminal is open. Start opencode in a terminal, or set aihub.chatTarget to copilot.");
        return;
      }
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

  private async openOpencodeTerminal(): Promise<vscode.Terminal | undefined> {
    const cmds = await vscode.commands.getCommands(true);
    const open = ["opencode.openTerminal", "opencode.openNewTerminal"].find((c) => cmds.includes(c));
    if (!open) return undefined;
    await vscode.commands.executeCommand(open);
    for (let i = 0; i < 10; i++) {
      const t = vscode.window.terminals.find((x) => isOpencodeTerminalName(x.name));
      if (t) return t;
      await new Promise((r) => setTimeout(r, 300));
    }
    return vscode.window.activeTerminal;
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    clearTimeout(this.gitDebounce);
    this.gitWatcher?.dispose();
    this.items.forEach((i) => i.dispose());
    this.log.dispose();
    this.subs.forEach((s) => s.dispose());
  }
}

const toneColor = (t: Tone): vscode.ThemeColor | undefined => (t === "ok" ? new vscode.ThemeColor("charts.green") : t === "run" ? new vscode.ThemeColor("charts.blue") : undefined);

export function activate(ctx: vscode.ExtensionContext) {
  const bar = new Bar(ctx);
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
  registerGitCommands(ctx, (l) => bar.logLine(l), (id) => bar.sendToChat(id));
  registerWorktreeCommands(ctx, (l) => bar.logLine(l), (id) => bar.sendToChat(id));
  bar.start();
}

export function deactivate() {}
