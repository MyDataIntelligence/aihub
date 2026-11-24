import { promises as fs } from "node:fs";
import { homedir, release, type } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import * as vscode from "vscode";
import { logFiles, PerfLog, readEvents } from "./perf/log";
import { clearTrackedInterval, perfEvent, perfLog, round, setPerfLog, startMonitor, trackedExecFile, trackedInterval, trackedTimeout, type Monitor, type PerfLevel } from "./perf/probe";
import { Scrubber } from "./perf/scrub";
import { renderReport, summarize, summaryLine } from "./perf/summary";
import { instrumentApi, type Api } from "./perf/instrument";
import { exportZip, maskOutsidePaths, PERIODS, periodStart, type Period, type SystemInfo } from "./perf/export";
import { mdToHtml } from "./perf/mdhtml";

/**
 * The built-in performance log (on by default, local only): what the extension costs at activation, per command,
 * per refresh, per child process, per timer and watcher, plus a host sample every 30-60 s. See src/perf/.
 */

const cfg = () => vscode.workspace.getConfiguration("aihub.performanceLog");
const DAY = 86_400_000;

export interface Activation {
  /** Closes the current phase and starts `name`. */
  phase(name: string): void;
  done(): void;
  /** The first status read is published. */
  firstRefresh(ok: boolean): void;
}

class PerfController implements vscode.Disposable {
  private log: PerfLog | undefined;
  private monitor: Monitor | undefined;
  private doctorTimer: NodeJS.Timeout | undefined;
  private subs: vscode.Disposable[] = [];
  readonly dir: string;

  constructor(
    private ctxRef: vscode.ExtensionContext,
    private cwd: () => string | undefined,
  ) {
    this.dir = join(ctxRef.globalStorageUri.fsPath, "perf");
    this.apply();
    this.subs.push(
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("aihub.performanceLog") && this.apply()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.log?.scrubber.setRoots(roots())),
    );
  }

  /** Starts or stops the log from the settings. */
  private apply() {
    const on = cfg().get<boolean>("enabled", true) !== false;
    const level: PerfLevel = cfg().get<string>("level", "basic") === "verbose" ? "verbose" : "basic";
    this.stop();
    if (!on) return;
    this.log = new PerfLog({ dir: this.dir, scrubber: new Scrubber({ roots: roots() }) });
    setPerfLog(this.log, level);
    this.monitor = startMonitor(level === "verbose" ? 30_000 : 60_000);
    // the doctor's summary: once 5 minutes after the start, then every 6 hours
    trackedTimeout("perf.doctorSummary.first",() => void this.writeDoctorSummary(), 5 * 60_000).unref?.();
    this.doctorTimer = trackedInterval("perf.doctorSummary", () => void this.writeDoctorSummary(), 6 * 3_600_000);
    this.doctorTimer.unref?.();
  }

  private stop() {
    clearTrackedInterval(this.doctorTimer);
    this.monitor?.sample();
    this.monitor?.stop();
    this.monitor = undefined;
    const old = this.log;
    setPerfLog(undefined);
    this.log = undefined;
    void old?.dispose();
  }

  private panel: vscode.WebviewPanel | undefined;
  private period: Period = "24h";
  private lastMd = "";

  /** The report of a period as markdown (also written to perf/report.md). */
  private async reportMd(period: Period): Promise<{ md: string; s: ReturnType<typeof summarize>; from: number; to: number }> {
    const log = this.log ?? perfLog();
    this.monitor?.sample();
    await log?.flush();
    const to = Date.now();
    const from = periodStart(period, to);
    const s = summarize(await readEvents(this.dir, from, to), from, to);
    const md = renderReport(s, this.dir) + (log ? "" : "\n\n> The performance log is off (aihub.performanceLog.enabled). This report shows what was logged before.\n");
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(join(this.dir, "report.md"), md, "utf8");
    return { md, s, from, to };
  }

  /** The report in a panel with a period choice and Export…, Copy summary and Open folder at the top. */
  async report(period: Period = this.period): Promise<void> {
    this.period = period;
    const { md, s } = await this.reportMd(period);
    this.lastMd = md;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel("aihub.perfReport", "Performance Report", vscode.ViewColumn.Active, { enableScripts: true });
      this.panel.onDidDispose(() => (this.panel = undefined));
      this.panel.webview.onDidReceiveMessage((m: { type: string; period?: Period }) => void this.onReportMessage(m));
    }
    this.panel.webview.html = reportPage(mdToHtml(md), period);
    this.panel.reveal();
    if (period === "24h") void this.writeDoctorSummary(s);
  }

  private async onReportMessage(m: { type: string; period?: Period }) {
    if (m.type === "period" && m.period) return this.report(m.period);
    if (m.type === "copy") {
      await vscode.env.clipboard.writeText(maskOutsidePaths(this.lastMd));
      return void vscode.window.showInformationMessage("Performance summary copied (markdown).");
    }
    if (m.type === "folder") return void vscode.env.openExternal(vscode.Uri.file(this.dir));
    if (m.type === "export") return this.exportZip();
  }

  /** One zip: report.md as shown, the extension's and the CLI's logs of the period, system.txt; scrubbed, no paths outside the workspace. */
  async exportZip(): Promise<void> {
    const { md, from, to } = await this.reportMd(this.period);
    const day = new Date().toISOString().slice(0, 10);
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(join(homedir(), `aihub-perf-${day}-${this.period}.zip`)), filters: { Zip: ["zip"] }, title: "Export the performance report" });
    if (!target) return;
    const { zip: data, files } = await exportZip({ dir: this.dir, from, to, reportMd: md, system: await this.system(), scrubber: new Scrubber({ roots: roots() }) });
    await fs.writeFile(target.fsPath, data);
    void vscode.window.showInformationMessage(`Exported ${files.length} files (${Math.round(data.length / 1024)} KB) to ${target.fsPath}. No tokens, e-mail addresses, file contents or paths outside the workspace.`);
  }

  private vm: string | undefined;
  private async system(): Promise<SystemInfo> {
    if (this.vm === undefined && process.platform === "win32")
      this.vm = await new Promise<string>((ok) =>
        trackedExecFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", "$c = Get-CimInstance Win32_ComputerSystem; \"$($c.Manufacturer) | $($c.Model) | $($c.HypervisorPresent)\""], { windowsHide: true, timeout: 20_000 }, (e, out) => {
          if (e) return ok("unknown");
          const t = out.trim();
          ok(/virtual|vmware|virtualbox|kvm|qemu|hyper-v|parallels|xen/i.test(t) ? `yes (${t.split(" | ").slice(0, 2).join(" ")})` : `no (${t.split(" | ").slice(0, 2).join(" ")})`);
        }),
      );
    const ext = this.ctxRef.extension?.packageJSON as { version?: string } | undefined;
    return {
      vscode: vscode.version,
      extension: ext?.version ?? "?",
      cli: this.ctxRef.globalState.get<{ version?: string }>("aihub.cliVersion")?.version,
      node: process.versions.node,
      os: `${type()} ${release()} ${process.arch}`,
      vm: this.vm,
    };
  }

  async export(): Promise<void> {
    this.monitor?.sample();
    await this.log?.flush();
    const files = await logFiles(this.dir);
    if (!files.length) return void vscode.window.showInformationMessage("The performance log is empty.");
    const day = new Date().toISOString().slice(0, 10);
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(join(homedir(), `aihub-perf-${day}.jsonl`)), filters: { "JSON lines": ["jsonl"] }, title: "Export the performance log (last 7 days)" });
    if (!target) return;
    const parts = await Promise.all(files.map((f) => fs.readFile(f, "utf8").catch(() => "")));
    await fs.writeFile(target.fsPath, parts.join(""), "utf8");
    void vscode.window.showInformationMessage(`Exported ${files.length} day(s) of the performance log to ${target.fsPath}. It holds no tokens, e-mail addresses or file contents.`);
  }

  /** `<git common dir>/aihub/vscode-perf.json`: where the log is and the summary of the last 24 h, for `aihub doctor`. */
  async writeDoctorSummary(given?: ReturnType<typeof summarize>): Promise<void> {
    const cwd = this.cwd();
    if (!cwd || !this.log) return;
    try {
      const now = Date.now();
      const s = given ?? summarize(await readEvents(this.dir, now - DAY, now), now - DAY, now);
      const common = await new Promise<string>((ok, bad) =>
        trackedExecFile("git", ["rev-parse", "--git-common-dir"], { cwd, windowsHide: true, timeout: 10_000 }, (e, out) => (e ? bad(e) : ok(out.trim()))),
      );
      const dir = join(isAbsolute(common) ? common : resolve(cwd, common), "aihub");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(join(dir, "vscode-perf.json"), JSON.stringify({ logDir: this.dir, updated: new Date(now).toISOString(), summary: summaryLine(s) }, null, 2), "utf8");
    } catch {
      /* not a git repository, or no write access: the doctor just shows nothing */
    }
  }

  dispose() {
    this.stop();
    this.subs.forEach((s) => s.dispose());
  }
}

const roots = () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);

/** The report panel: period choice and the three buttons above the report. */
function reportPage(body: string, period: Period): string {
  const nonce = Math.random().toString(36).slice(2);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:0 16px 24px;max-width:1100px}.bar{position:sticky;top:0;background:var(--vscode-editor-background);padding:10px 0;display:flex;gap:8px;align-items:center;flex-wrap:wrap;border-bottom:1px solid var(--vscode-panel-border)}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:4px 10px;border-radius:2px;cursor:pointer}button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
select{background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border);padding:3px}table{border-collapse:collapse;margin:6px 0 12px}td,th{border:1px solid var(--vscode-panel-border);padding:3px 8px}code{background:var(--vscode-textCodeBlock-background);padding:0 3px}
</style></head><body><div class="bar"><select id="period">${PERIODS.map((p) => `<option value="${p.id}"${p.id === period ? " selected" : ""}>${p.label}</option>`).join("")}</select><button data-t="export">Export…</button><button class="secondary" data-t="copy">Copy summary</button><button class="secondary" data-t="folder">Open folder</button></div>${body}
<script nonce="${nonce}">const vs=acquireVsCodeApi();document.addEventListener('click',e=>{const b=e.target.closest('button');if(b)vs.postMessage({type:b.dataset.t});});document.getElementById('period').addEventListener('change',e=>vs.postMessage({type:'period',period:e.target.value}));</script></body></html>`;
}

let controller: PerfController | undefined;

/**
 * Call first in `activate`: starts the log, instruments the API and registers the report and export commands.
 * Returns the activation timer for the phases.
 */
export function startPerf(ctx: vscode.ExtensionContext, cwd: () => string | undefined): Activation {
  const t0 = performance.now();
  const phases: Record<string, number> = {};
  let phase = "perf.setup";
  let phaseAt = t0;
  const mark = () => {
    const now = performance.now();
    phases[phase] = round((phases[phase] ?? 0) + now - phaseAt);
    phaseAt = now;
  };
  controller = new PerfController(ctx, cwd);
  const inst = instrumentApi(vscode as unknown as Api);
  ctx.subscriptions.push(
    controller,
    vscode.commands.registerCommand("aihub.performance.report", () => controller?.report()),
    vscode.commands.registerCommand("aihub.performance.export", () => controller?.export()),
  );
  let doneAt = 0;
  let first = false;
  return {
    phase(name) {
      mark();
      phase = name;
    },
    done() {
      mark();
      doneAt = performance.now();
      const pkg = ctx.extension?.packageJSON as { version?: string; activationEvents?: string[] } | undefined;
      perfEvent("activate", {
        ms: round(doneAt - t0),
        phases,
        activationEvents: pkg?.activationEvents ?? [],
        hostUptimeMs: round(process.uptime() * 1000),
        version: pkg?.version,
        vscode: vscode.version,
        remote: vscode.env.remoteName,
        platform: process.platform,
        folders: vscode.workspace.workspaceFolders?.length ?? 0,
        instrumented: inst,
        level: cfg().get("level", "basic"),
      });
    },
    firstRefresh(ok) {
      if (first) return;
      first = true;
      perfEvent("activate.firstRefresh", { ms: round(performance.now() - t0), ok });
    },
  };
}

export function stopPerf(): Promise<void> {
  const log = perfLog();
  controller?.dispose();
  controller = undefined;
  return log ? log.dispose() : Promise.resolve();
}
