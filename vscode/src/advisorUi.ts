import { promises as fs } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { readJson, makeRunner, type Runner } from "./cli";
import { HEAVY_DIRS, pickNotification, vscodeFindings, type AdvisorFinding, type FolderFacts, type NotifyState } from "./advisorModel";
import { clearTrackedInterval, trackedInterval, trackedTimeout } from "./perf/probe";

/**
 * "AI Context Hub: Performance Advisor": what makes git, node and VS Code slow here, one card per cause with the evidence,
 * the exact change, the risk and the undo. The CLI measures (`aihub doctor --perf --json`); this file adds the VS Code
 * settings, applies on a click (administrator changes only after a confirmation, through one UAC prompt) and offers at
 * most one finding per day as a notification, each finding at most once.
 */

const cfg = () => vscode.workspace.getConfiguration("aihub");
const NOTIFY_KEY = "aihub.advisor.notify";
const SETTINGS_KEY = "aihub.advisor.appliedSettings";

interface CliAdvice {
  findings: AdvisorFinding[];
  applied: { id: string; title: string; scope: string; at: string; revert: string[] }[];
}
interface AppliedSetting {
  id: string;
  title: string;
  at: string;
  previous: { key: string; value: unknown }[];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Heavy folders in a workspace folder, two levels deep, with a capped file count (cheap: stops at 2000 per folder). */
async function heavyDirs(root: string): Promise<FolderFacts["heavy"]> {
  const found: FolderFacts["heavy"] = [];
  const count = async (dir: string, cap = 2000): Promise<number> => {
    let n = 0;
    const stack = [dir];
    while (stack.length && n < cap) {
      const d = stack.pop()!;
      for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) stack.push(join(d, e.name));
        else if (++n >= cap) break;
      }
    }
    return n;
  };
  for (const rel of HEAVY_DIRS) {
    for (const base of ["", ...(await fs.readdir(root, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name)]) {
      const dir = join(root, base, ...rel.split("/"));
      const st = await fs.stat(dir).catch(() => undefined);
      if (st?.isDirectory()) found.push({ dir: rel, files: await count(dir) });
    }
  }
  return found;
}

export class AdvisorController implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private last: AdvisorFinding[] = [];
  private cliApplied: CliAdvice["applied"] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private ctx: vscode.ExtensionContext,
    private cwd: () => string | undefined,
  ) {}

  private runner(): Runner {
    // doctor --perf measures for a few seconds (process starts, one PowerShell call)
    return makeRunner({ command: String(cfg().get("cliPath", "aihub")) || "aihub", timeoutMs: 120_000, env: { GCM_INTERACTIVE: "never", GIT_TERMINAL_PROMPT: "0" } });
  }

  register() {
    this.ctx.subscriptions.push(this, vscode.commands.registerCommand("aihub.performance.advisor", () => this.show()));
    // background check: 10 minutes after the start, then once a day; at most one notification a day
    if (cfg().get<boolean>("performanceAdvisor.notify", true)) {
      trackedTimeout("advisor.firstCheck", () => void this.check(), 10 * 60_000).unref?.();
      this.timer = trackedInterval("advisor.dailyCheck", () => void this.check(), 24 * 3_600_000);
      this.timer.unref?.();
    }
  }

  /** All findings: the CLI's measurements plus the VS Code settings. */
  async findings(): Promise<AdvisorFinding[]> {
    const cwd = this.cwd() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    let cli: CliAdvice = { findings: [], applied: [] };
    if (cwd) {
      try {
        cli = await readJson<CliAdvice>(this.runner(), ["doctor", "--perf"], cwd);
      } catch (e) {
        void vscode.window.showWarningMessage(`AI Context Hub: aihub doctor --perf did not answer (${(e as Error).message}). Update the CLI: npm i -g @ferronhooi/aihub`);
      }
    }
    const folders = await Promise.all((vscode.workspace.workspaceFolders ?? []).map(async (f) => ({ name: f.name, heavy: await heavyDirs(f.uri.fsPath) })));
    const own = vscodeFindings(folders, vscode.workspace.getConfiguration("files").get("watcherExclude", {}), vscode.workspace.getConfiguration("search").get("exclude", {}));
    this.cliApplied = cli.applied ?? [];
    this.last = [...cli.findings, ...own];
    return this.last;
  }

  private notifyState(): NotifyState {
    return this.ctx.globalState.get<NotifyState>(NOTIFY_KEY) ?? { offered: [], never: [] };
  }

  /** The daily check: one notification for one finding, never a series. */
  async check(): Promise<void> {
    const found = await this.findings().catch(() => [] as AdvisorFinding[]);
    const state = this.notifyState();
    const f = pickNotification(found, state, Date.now());
    if (!f) return;
    await this.ctx.globalState.update(NOTIFY_KEY, { ...state, offered: [...state.offered, f.id], lastAt: Date.now() });
    const add = f.scope === "admin" && f.itRequest ? "Copy IT request" : "Add";
    const pick = await vscode.window.showInformationMessage(`AI Context Hub: ${f.title}`, add, "Show command", "Not now", "Never for this");
    if (pick === add) await this.apply(f.id);
    else if (pick === "Show command") await this.show(f.id);
    else if (pick === "Never for this") await this.ctx.globalState.update(NOTIFY_KEY, { ...this.notifyState(), never: [...this.notifyState().never, f.id] });
  }

  async show(focus?: string): Promise<void> {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel("aihub.advisor", "Performance Advisor", vscode.ViewColumn.Active, { enableScripts: true });
      this.panel.onDidDispose(() => (this.panel = undefined));
      this.panel.webview.onDidReceiveMessage((m: { type: string; id?: string }) => void this.onMessage(m));
    }
    this.panel.webview.html = this.html([], true);
    this.panel.reveal();
    await this.findings();
    if (this.panel) this.panel.webview.html = this.html(this.last, false, focus);
  }

  private async onMessage(m: { type: string; id?: string }) {
    const f = this.last.find((x) => x.id === m.id);
    if (m.type === "apply" && m.id) await this.apply(m.id);
    else if (m.type === "undo" && m.id) await this.undo(m.id);
    else if (m.type === "copy" && f) await vscode.env.clipboard.writeText(f.itRequest ?? [...f.apply, "", "undo:", ...f.revert].join("\n"));
    else if (m.type === "never" && m.id) await this.ctx.globalState.update(NOTIFY_KEY, { ...this.notifyState(), never: [...this.notifyState().never, m.id] });
    else if (m.type === "refresh") return this.show();
    if (m.type !== "copy" && this.panel) {
      // measuring again costs a few process starts and a PowerShell call: only after an undo (the finding comes back)
      if (m.type === "undo") await this.findings();
      else await this.reloadCliApplied();
      this.panel.webview.html = this.html(this.last, false);
    } else if (m.type === "copy") void vscode.window.showInformationMessage(f?.itRequest ? "IT request copied." : "Command copied.");
  }

  async apply(id: string): Promise<void> {
    const f = this.last.find((x) => x.id === id) ?? (await this.findings()).find((x) => x.id === id);
    if (!f) return;
    if (f.settings) return this.applySettings(f);
    if (f.scope === "info") return;
    if (f.scope === "admin") {
      if (f.itRequest) {
        await vscode.env.clipboard.writeText(f.itRequest);
        return void vscode.window.showInformationMessage("Defender is managed by IT here: the request text with the paths and the measurements is on the clipboard.");
      }
      const dry = !!cfg().get<boolean>("performanceAdvisor.adminDryRun", false);
      const go = await vscode.window.showWarningMessage(
        `${f.change}\n\nRisk: ${f.risk}\n\n${dry ? "Dry run (aihub.performanceAdvisor.adminDryRun): nothing is changed." : "Windows asks for administrator rights (UAC)."}\n\n${f.apply.join("\n")}`,
        { modal: true },
        dry ? "Show what would run" : "Run as administrator",
      );
      if (!go) return;
      return void (await this.runCli(["doctor", "--perf", "--apply", id, dry ? "--dry-run" : "--elevate"], dry ? "Dry run" : `Applied ${id}`));
    }
    return void (await this.runCli(["doctor", "--perf", "--apply", id], `Applied ${id}`));
  }

  private async runCli(args: string[], done: string): Promise<boolean> {
    const cwd = this.cwd() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) return false;
    try {
      const out = (await this.runner()(args, cwd)).trim();
      if (args.includes("--dry-run")) void vscode.window.showInformationMessage(`AI Context Hub: ${done}: nothing was changed.`, { modal: true, detail: out });
      else {
        void vscode.window.showInformationMessage(`AI Context Hub: ${done}. ${out.split(/\r?\n/).slice(-1).join(" ")}`);
        const id = args[args.indexOf("--apply") + 1];
        if (args.includes("--apply")) this.last = this.last.filter((x) => x.id !== id);
      }
      return true;
    } catch (e) {
      void vscode.window.showErrorMessage(`AI Context Hub: ${(e as Error).message}`);
      return false;
    }
  }

  /** What the CLI recorded as applied (perf-advisor.json), without measuring again. */
  private async reloadCliApplied() {
    const env = process.env;
    const file = join(env.AIHUB_HOME || join(env.USERPROFILE || env.HOME || "", ".aihub"), "perf-advisor.json");
    try {
      this.cliApplied = (JSON.parse(await fs.readFile(file, "utf8")) as { applied?: CliAdvice["applied"] }).applied ?? [];
    } catch {
      this.cliApplied = [];
    }
  }

  private async applySettings(f: AdvisorFinding) {
    const previous: AppliedSetting["previous"] = [];
    for (const s of f.settings ?? []) {
      const c = vscode.workspace.getConfiguration();
      const before = c.inspect<Record<string, boolean>>(s.key)?.workspaceValue;
      previous.push({ key: s.key, value: before });
      await c.update(s.key, { ...(before ?? {}), ...s.add }, vscode.ConfigurationTarget.Workspace);
    }
    const list = (this.ctx.globalState.get<AppliedSetting[]>(SETTINGS_KEY) ?? []).filter((a) => a.id !== f.id);
    list.push({ id: f.id, title: f.title, at: new Date().toISOString(), previous });
    await this.ctx.globalState.update(SETTINGS_KEY, list);
    this.last = this.last.filter((x) => x.id !== f.id);
    void vscode.window.showInformationMessage(`AI Context Hub: ${f.change} Undo is in the Performance Advisor.`);
  }

  async undo(id: string): Promise<void> {
    const list = this.ctx.globalState.get<AppliedSetting[]>(SETTINGS_KEY) ?? [];
    const s = list.find((a) => a.id === id);
    if (s) {
      for (const p of s.previous) await vscode.workspace.getConfiguration().update(p.key, p.value, vscode.ConfigurationTarget.Workspace);
      await this.ctx.globalState.update(SETTINGS_KEY, list.filter((a) => a.id !== id));
      return void vscode.window.showInformationMessage(`AI Context Hub: undone: ${s.title}`);
    }
    const a = this.cliApplied.find((x) => x.id === id);
    if (!a) return;
    if (a.scope === "admin") {
      const dry = !!cfg().get<boolean>("performanceAdvisor.adminDryRun", false);
      const go = await vscode.window.showWarningMessage(`Undo ${id}?\n\n${a.revert.join("\n")}`, { modal: true }, dry ? "Show what would run" : "Run as administrator");
      if (!go) return;
      return void (await this.runCli(["doctor", "--perf", "--undo", id, dry ? "--dry-run" : "--elevate"], `Undone ${id}`));
    }
    return void (await this.runCli(["doctor", "--perf", "--undo", id], `Undone ${id}`));
  }

  private html(found: AdvisorFinding[], loading: boolean, focus?: string): string {
    const applied = [...(this.ctx.globalState.get<AppliedSetting[]>(SETTINGS_KEY) ?? []).map((a) => ({ id: a.id, title: a.title, at: a.at })), ...this.cliApplied.map((a) => ({ id: a.id, title: a.title, at: a.at }))];
    const never = this.notifyState().never;
    const card = (f: AdvisorFinding) => {
      const primary = f.scope === "info" ? "" : f.scope === "admin" && f.itRequest ? `<button data-t="copy" data-id="${esc(f.id)}">Copy IT request</button>` : `<button data-t="apply" data-id="${esc(f.id)}">${f.scope === "admin" ? "Add (administrator)" : "Apply"}</button>`;
      return `<section class="card ${f.id === focus ? "focus" : ""}"><h2>${esc(f.title)}</h2>
<div class="tag ${f.scope}">${f.scope === "admin" ? "needs administrator" : f.scope === "user" ? "your settings, no administrator" : "advice"}</div>
<ul>${f.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>
<p><b>Change:</b> ${esc(f.change)}</p><p><b>Risk:</b> ${esc(f.risk)}</p><p><b>Undo:</b> ${esc(f.undo)}</p>
${f.apply.length ? `<pre>${esc(f.apply.join("\n"))}</pre>` : ""}
<div class="row">${primary}${f.apply.length || f.itRequest ? `<button class="secondary" data-t="copy" data-id="${esc(f.id)}">Show / copy command</button>` : ""}${never.includes(f.id) ? `<span class="muted">no notification for this</span>` : `<button class="secondary" data-t="never" data-id="${esc(f.id)}">Never for this</button>`}</div></section>`;
    };
    const nonce = Math.random().toString(36).slice(2);
    const body = loading
      ? `<p class="muted">Measuring process starts, Defender, indexing and git settings...</p>`
      : `${found.length ? found.map(card).join("") : `<p>Nothing found that slows git, node or VS Code down here.</p>`}
<h2>Applied</h2>${applied.length ? `<ul>${applied.map((a) => `<li>${esc(a.title)} <span class="muted">(${esc(a.at)})</span> <button class="secondary" data-t="undo" data-id="${esc(a.id)}">Undo</button></li>`).join("")}</ul>` : `<p class="muted">Nothing applied.</p>`}`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:0 16px 24px;max-width:900px}
h1{font-size:1.4em}h2{font-size:1.05em;margin:0 0 6px}.card{border:1px solid var(--vscode-panel-border);border-radius:6px;padding:12px 14px;margin:12px 0}
.card.focus{border-color:var(--vscode-focusBorder)}.tag{display:inline-block;font-size:.8em;padding:1px 6px;border-radius:3px;margin-bottom:6px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
.tag.admin{background:var(--vscode-inputValidation-warningBackground)}pre{background:var(--vscode-textCodeBlock-background);padding:8px;white-space:pre-wrap;word-break:break-all}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:4px 10px;border-radius:2px;cursor:pointer}
button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.muted{opacity:.7}ul{margin:4px 0 8px 18px;padding:0}
</style></head><body><h1>Performance Advisor <button class="secondary" data-t="refresh">Measure again</button></h1>
<p class="muted">One card per cause, only with measured evidence. Nothing changes without your click; administrator changes ask Windows for permission (UAC).</p>
${body}<script nonce="${nonce}">const vs=acquireVsCodeApi();document.addEventListener('click',e=>{const b=e.target.closest('button');if(b)vs.postMessage({type:b.dataset.t,id:b.dataset.id});});</script></body></html>`;
  }

  dispose() {
    clearTrackedInterval(this.timer);
    this.panel?.dispose();
  }
}
