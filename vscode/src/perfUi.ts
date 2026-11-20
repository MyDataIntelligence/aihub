import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import * as vscode from "vscode";
import { logFiles, PerfLog, readEvents } from "./perf/log";
import { clearTrackedInterval, perfEvent, perfLog, round, setPerfLog, startMonitor, trackedExecFile, trackedInterval, trackedTimeout, type Monitor, type PerfLevel } from "./perf/probe";
import { Scrubber } from "./perf/scrub";
import { renderReport, summarize, summaryLine } from "./perf/summary";
import { instrumentApi, type Api } from "./perf/instrument";

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
    ctx: vscode.ExtensionContext,
    private cwd: () => string | undefined,
  ) {
    this.dir = join(ctx.globalStorageUri.fsPath, "perf");
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

  async report(): Promise<void> {
    const log = this.log ?? perfLog();
    this.monitor?.sample();
    await log?.flush();
    const now = Date.now();
    const s = summarize(await readEvents(this.dir, now - DAY, now), now - DAY, now);
    const md = renderReport(s, this.dir) + (log ? "" : "\n\n> The performance log is off (aihub.performanceLog.enabled). This report shows what was logged before.\n");
    await fs.mkdir(this.dir, { recursive: true });
    const file = vscode.Uri.file(join(this.dir, "report.md"));
    await fs.writeFile(file.fsPath, md, "utf8");
    try {
      await vscode.commands.executeCommand("markdown.showPreview", file);
    } catch {
      await vscode.window.showTextDocument(file);
    }
    void this.writeDoctorSummary(s);
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
