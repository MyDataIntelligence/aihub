import * as path from "path";
import * as vscode from "vscode";
import { readJson, type Runner } from "./cli";
import { lessonLabel, lessonPage, tourSteps, type Lesson, type LessonMeta } from "./learnModel";

/** Only links of the iDiagram app open outside VS Code. */
export const isIDiagramLink = (u: string) => {
  try {
    const x = new URL(u);
    return (x.protocol === "https:" && x.hostname === "idiagram.vercel.app") || ((x.hostname === "localhost" || x.hostname === "127.0.0.1") && x.protocol === "http:");
  } catch {
    return false;
  }
};

type Node = { kind: "lesson"; meta: LessonMeta } | { kind: "group"; id: "lessons" | "concepts"; label: string } | { kind: "concept"; row: ConceptRow };

interface ConceptRow {
  name: string;
  eli5: string;
  example: string;
  lessons: string[];
  learned: boolean;
}

/**
 * Learn in VS Code: your personal lessons (aihub learn list --json) in the Explorer, one page per lesson with rendered
 * Mermaid pictures, and a guided tour through the changed pieces. Reading only; the lessons are written by /leer.
 */
export class LearnController implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private panels = new Map<string, vscode.WebviewPanel>();
  private decoration = vscode.window.createTextEditorDecorationType({ backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"), isWholeLine: true });
  private tourRun = 0;

  constructor(
    private ctx: vscode.ExtensionContext,
    private getRunner: () => Runner,
    private getCwd: () => string | undefined,
    private log: (l: string) => void,
  ) {}

  refresh() {
    this.emitter.fire(undefined);
  }

  async getChildren(n?: Node): Promise<Node[]> {
    if (!n) return [{ kind: "group", id: "lessons", label: "Lessons" }, { kind: "group", id: "concepts", label: "Concepts" }];
    const cwd = this.getCwd();
    if (!cwd || n.kind !== "group") return [];
    try {
      if (n.id === "lessons") return (await readJson<LessonMeta[]>(this.getRunner(), ["learn", "list"], cwd)).map((meta) => ({ kind: "lesson" as const, meta }));
      return (await readJson<ConceptRow[]>(this.getRunner(), ["learn", "concepts"], cwd)).map((row) => ({ kind: "concept" as const, row }));
    } catch (e) {
      this.log(`learn: ${(e as Error).message}`);
      return [];
    }
  }

  getTreeItem(n: Node): vscode.TreeItem {
    if (n.kind === "group") {
      const it = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.Expanded);
      it.contextValue = `aihubLearnGroup`;
      return it;
    }
    if (n.kind === "concept") {
      const it = new vscode.TreeItem(n.row.name, vscode.TreeItemCollapsibleState.None);
      it.description = n.row.learned ? "learned" : n.row.eli5;
      it.tooltip = `${n.row.eli5}\n\nIn this change: ${n.row.example}`;
      it.iconPath = new vscode.ThemeIcon(n.row.learned ? "check" : "lightbulb");
      it.contextValue = "aihubLearnConcept";
      return it;
    }
    const it = new vscode.TreeItem(lessonLabel(n.meta), vscode.TreeItemCollapsibleState.None);
    it.description = n.meta.title;
    it.tooltip = `${n.meta.title}\n${n.meta.savedAt.slice(0, 10)} · ${n.meta.concepts} concept(s), ${n.meta.quiz} question(s)`;
    it.iconPath = new vscode.ThemeIcon("mortar-board");
    it.contextValue = "aihubLesson";
    it.command = { command: "aihub.learn.open", title: "Open the lesson", arguments: [n] };
    return it;
  }

  private async load(id: string): Promise<Lesson | undefined> {
    const cwd = this.getCwd();
    if (!cwd) return undefined;
    try {
      return await readJson<Lesson>(this.getRunner(), ["learn", "show", "--id", id], cwd);
    } catch (e) {
      void vscode.window.showErrorMessage(`AI Context Hub: ${(e as Error).message}`);
      return undefined;
    }
  }

  private async pickLesson(n?: Node): Promise<string | undefined> {
    if (n?.kind === "lesson") return n.meta.id;
    const cwd = this.getCwd();
    if (!cwd) return undefined;
    const list = await readJson<LessonMeta[]>(this.getRunner(), ["learn", "list"], cwd).catch(() => []);
    if (!list.length) return void vscode.window.showInformationMessage("No lessons yet. Ask your chat for /leer on a PR or branch; it saves a lesson here.");
    return (await vscode.window.showQuickPick(list.map((m) => ({ label: lessonLabel(m), description: m.title, id: m.id })), { placeHolder: "Open which lesson?" }))?.id;
  }

  async open(n?: Node) {
    const id = await this.pickLesson(n);
    if (!id) return;
    const lesson = await this.load(id);
    if (!lesson) return;
    const existing = this.panels.get(id);
    if (existing) return existing.reveal();
    const res = vscode.Uri.joinPath(this.ctx.extensionUri, "resources");
    const panel = vscode.window.createWebviewPanel("aihubLesson", lessonLabel(lesson.meta), vscode.ViewColumn.Beside, { enableScripts: true, localResourceRoots: [res], retainContextWhenHidden: true });
    this.panels.set(id, panel);
    panel.onDidDispose(() => this.panels.delete(id));
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    panel.webview.html = lessonPage(lesson, nonce, panel.webview.cspSource, panel.webview.asWebviewUri(vscode.Uri.joinPath(res, "mermaid.min.js")).toString());
    panel.webview.onDidReceiveMessage(async (m: { type: string; path?: string; line?: number; name?: string; correct?: number; of?: number; url?: string }) => {
      const cwd = this.getCwd();
      if (m.type === "open" && m.path) await this.openFile(m.path, m.line ?? 0);
      else if (m.type === "tour") void this.tour(lesson);
      else if (m.type === "external" && m.url && isIDiagramLink(m.url)) void vscode.env.openExternal(vscode.Uri.parse(m.url));
      else if (m.type === "learned" && m.name && cwd) {
        await this.getRunner()(["learn", "concepts", "--mark", m.name], cwd).catch(() => undefined);
        this.refresh();
      } else if (m.type === "score" && cwd) await this.getRunner()(["learn", "quiz", "--score", id, "--correct", String(m.correct), "--of", String(m.of)], cwd).catch(() => undefined);
    });
  }

  private async openFile(rel: string, line: number): Promise<vscode.TextEditor | undefined> {
    const cwd = this.getCwd();
    if (!cwd) return undefined;
    const uri = vscode.Uri.file(path.join(cwd, rel));
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const ed = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
      if (line > 0) {
        const pos = new vscode.Position(Math.min(line - 1, doc.lineCount - 1), 0);
        ed.selection = new vscode.Selection(pos, pos);
        ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
      return ed;
    } catch {
      void vscode.window.showWarningMessage(`${rel} is not in this checkout (the branch may be another one).`);
      return undefined;
    }
  }

  /** The guided tour: one stop per changed piece, with Previous / Next / Stop. */
  async tour(lesson: Lesson) {
    const steps = tourSteps(lesson);
    if (!steps.length) return void vscode.window.showInformationMessage("This lesson has no changed pieces to walk through.");
    const run = ++this.tourRun;
    let i = 0;
    while (i >= 0 && i < steps.length && run === this.tourRun) {
      const s = steps[i];
      const ed = await this.openFile(s.path, s.line);
      if (ed) ed.setDecorations(this.decoration, [new vscode.Range(s.line - 1, 0, s.line - 1, 0)]);
      const buttons = [...(i > 0 ? ["Previous"] : []), i < steps.length - 1 ? "Next" : "Finish", "Stop"];
      const pick = await vscode.window.showInformationMessage(`Step ${i + 1}/${steps.length} · ${s.path}:${s.line}\n${s.title}${s.detail ? `\n${s.detail}` : ""}`, ...buttons);
      ed?.setDecorations(this.decoration, []);
      if (pick === "Next") i++;
      else if (pick === "Previous") i--;
      else break;
    }
    for (const e of vscode.window.visibleTextEditors) e.setDecorations(this.decoration, []);
  }

  register(ctx: vscode.ExtensionContext) {
    ctx.subscriptions.push(
      this,
      vscode.window.registerTreeDataProvider("aihub.learn", this),
      vscode.commands.registerCommand("aihub.learn.open", (n?: Node) => this.open(n)),
      vscode.commands.registerCommand("aihub.learn.tour", async (n?: Node) => {
        const id = await this.pickLesson(n);
        const l = id ? await this.load(id) : undefined;
        if (l) await this.tour(l);
      }),
      vscode.commands.registerCommand("aihub.learn.refresh", () => this.refresh()),
      vscode.commands.registerCommand("aihub.learn.forget", async (n?: Node) => {
        const id = await this.pickLesson(n);
        const cwd = this.getCwd();
        if (!id || !cwd) return;
        if ((await vscode.window.showWarningMessage(`Remove the lesson ${id} from your personal store?`, { modal: true }, "Remove")) !== "Remove") return;
        await this.getRunner()(["learn", "forget", "--id", id], cwd);
        this.refresh();
      }),
      vscode.commands.registerCommand("aihub.learn.markConcept", async (n?: Node) => {
        const cwd = this.getCwd();
        if (n?.kind !== "concept" || !cwd) return;
        await this.getRunner()(["learn", "concepts", n.row.learned ? "--unmark" : "--mark", n.row.name], cwd);
        this.refresh();
      }),
    );
  }

  dispose() {
    this.decoration.dispose();
    this.panels.forEach((p) => p.dispose());
  }
}
