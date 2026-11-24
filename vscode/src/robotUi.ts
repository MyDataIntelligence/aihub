import * as vscode from "vscode";
import { makeRunner, readJson, type Runner } from "./cli";
import { resultMessage, robotTestLines, type RobotResult } from "./robotModel";

/**
 * "Run Robot Test": pick a suite, a test and (when team.yaml has several) a test environment, run it locally in a
 * terminal with the repository's interpreter (the team's runner script when there is one), then show PASS/FAIL with
 * log.html and report.html. Also "Run this test" above every test case of a .robot file. The CLI finds runner, suites
 * and environments (`aihub robot local`) and reads the result (`aihub robot result`).
 */

const cfg = () => vscode.workspace.getConfiguration("aihub");

interface Discovery {
  root: string;
  runner: { script: string; cwd: string } | null;
  suites: { file: string; rel: string; tests: { name: string; line: number }[] }[];
  environments: string[];
}
interface LocalCommand {
  cwd: string;
  exe: string;
  args: string[];
  env: Record<string, string>;
  outputDir?: string;
}

export class RobotController {
  private running = false;
  constructor(
    private ctx: vscode.ExtensionContext,
    private cwd: () => string | undefined,
  ) {}

  private runner(): Runner {
    return makeRunner({ command: String(cfg().get("cliPath", "aihub")) || "aihub", timeoutMs: 60_000 });
  }

  register() {
    this.ctx.subscriptions.push(
      vscode.commands.registerCommand("aihub.robot.run", (arg?: vscode.Uri | { file: string; test?: string }) => this.run(arg)),
      vscode.languages.registerCodeLensProvider({ pattern: "**/*.robot" }, {
        provideCodeLenses: (doc) =>
          robotTestLines(doc.getText()).map((t) => new vscode.CodeLens(new vscode.Range(t.line, 0, t.line, 0), { title: "$(play) Run this test", command: "aihub.robot.run", arguments: [{ file: doc.uri.fsPath, test: t.name }] })),
      }),
    );
  }

  private folder(arg?: vscode.Uri | { file: string }) {
    const p = arg instanceof vscode.Uri ? arg.fsPath : arg?.file;
    const f = p ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(p)) : undefined;
    return f?.uri.fsPath ?? this.cwd() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  async run(arg?: vscode.Uri | { file: string; test?: string }): Promise<void> {
    if (this.running) return void vscode.window.showInformationMessage("A Robot run is still going; it is in the Robot terminal.");
    const cwd = this.folder(arg);
    if (!cwd) return void vscode.window.showWarningMessage("Open a folder with Robot tests first.");
    let d: Discovery;
    try {
      d = await readJson<Discovery>(this.runner(), ["robot", "local"], cwd);
    } catch (e) {
      return void vscode.window.showErrorMessage(`AI Context Hub: ${(e as Error).message}`);
    }
    // what to run: the clicked test, the clicked file or folder, else a pick
    let file = arg instanceof vscode.Uri ? arg.fsPath : arg?.file;
    let test = arg && !(arg instanceof vscode.Uri) ? arg.test : undefined;
    if (!file) {
      if (!d.suites.length) return void vscode.window.showWarningMessage("No .robot files found in this repository.");
      const pick = await vscode.window.showQuickPick(
        [{ label: "$(run-all) All suites", file: undefined as string | undefined }, ...d.suites.map((s) => ({ label: s.rel, description: `${s.tests.length} test(s)`, file: s.file }))],
        { title: "Run Robot Test · suite", placeHolder: d.runner ? `with ${d.runner.script.split(/[\\/]/).pop()}` : "with python -m robot" },
      );
      if (!pick) return;
      file = pick.file;
    }
    const suite = d.suites.find((s) => file && s.file.toLowerCase() === file.toLowerCase());
    if (file && !test && suite && suite.tests.length > 1) {
      const pick = await vscode.window.showQuickPick([{ label: `$(run-all) All tests in ${suite.rel}`, test: undefined as string | undefined }, ...suite.tests.map((t) => ({ label: t.name, test: t.name as string | undefined }))], { title: "Run Robot Test · test" });
      if (!pick) return;
      test = pick.test;
    }
    let env: string | undefined = d.environments[0];
    if (d.environments.length > 1) {
      const pick = await vscode.window.showQuickPick(d.environments, { title: "Run Robot Test · test environment (team.yaml robot.environments)" });
      if (!pick) return;
      env = pick;
    }
    let c: LocalCommand;
    try {
      c = await readJson<LocalCommand>(this.runner(), ["robot", "local", "--command", ...(file ? ["--file", file] : []), ...(test ? ["--test", test] : []), ...(env ? ["--env", env] : [])], cwd);
    } catch (e) {
      return void vscode.window.showErrorMessage(`AI Context Hub: ${(e as Error).message}`);
    }
    await this.execute(c, cwd, test ?? suite?.rel ?? "all suites", env);
  }

  private async execute(c: LocalCommand, cwd: string, what: string, env: string | undefined) {
    const t0 = Date.now();
    const task = new vscode.Task({ type: "aihub-robot" }, vscode.TaskScope.Workspace, `Robot: ${what}${env ? ` (${env})` : ""}`, "AI Context Hub", new vscode.ProcessExecution(c.exe, c.args, { cwd: c.cwd, env: c.env }));
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true };
    this.running = true;
    const exec = await vscode.tasks.executeTask(task);
    const code = await new Promise<number | undefined>((resolve) => {
      const sub = vscode.tasks.onDidEndTaskProcess((e) => {
        if (e.execution === exec) {
          sub.dispose();
          resolve(e.exitCode);
        }
      });
    });
    this.running = false;
    let r: RobotResult | null = null;
    try {
      r = await readJson<RobotResult | null>(this.runner(), ["robot", "result", "--since", String(t0 - 1000), "--dir", c.outputDir ?? c.cwd], cwd);
    } catch {
      r = null;
    }
    const buttons = [r?.log ? "Open log.html" : "", r?.report ? "Open report.html" : ""].filter(Boolean);
    const show = r?.status === "PASS" ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
    const pick = await show(resultMessage(r, code), ...buttons);
    if (pick === "Open log.html" && r?.log) await vscode.env.openExternal(vscode.Uri.file(r.log));
    if (pick === "Open report.html" && r?.report) await vscode.env.openExternal(vscode.Uri.file(r.report));
  }
}
