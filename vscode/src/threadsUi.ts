import * as path from "path";
import * as vscode from "vscode";
import { readJson, type Runner } from "./cli";
import { fixPrompt, isOpen, parseThreads, replyArgs, repoPath, type ReplyStatus, type Thread } from "./threadsModel";

/**
 * PR review threads as VS Code comment threads on the changed files. Reading is `aihub comments get --json`;
 * resolve, won't fix, reactivate and reply are `aihub comments reply --reply`; "fix in chat" only puts a prompt in the chat.
 */
export class ThreadsController implements vscode.Disposable {
  private controller = vscode.comments.createCommentController("aihub", "AI Context Hub review threads");
  private shown = new Map<vscode.CommentThread, { id: number; model: Thread }>();
  private pr = 0;
  private busy: Promise<void> | undefined;

  constructor(
    private getRunner: () => Runner,
    private getCwd: () => string | undefined,
    private toChat: (text: string) => Promise<void>,
    private log: (line: string) => void,
    private onChanged: () => void,
  ) {
    this.controller.options = { placeHolder: "Reply to this review thread", prompt: "Reply" };
  }

  /** Called with the PR of the branch (or undefined). Reads the threads and mirrors them in the editor. */
  async sync(pr: number | undefined, openThreads: number): Promise<void> {
    if (this.busy) return this.busy;
    this.busy = this.run(pr, openThreads).finally(() => (this.busy = undefined));
    return this.busy;
  }

  private async run(pr: number | undefined, openThreads: number) {
    const cwd = this.getCwd();
    if (!pr || !cwd || (openThreads === 0 && this.shown.size === 0)) return this.clear();
    try {
      const { threads } = parseThreads(await readJson(this.getRunner(), ["comments", "get", "--pr", String(pr), "--include-resolved"], cwd));
      this.pr = pr;
      this.clear();
      for (const t of threads) {
        if (!t.file || !t.line) continue;
        const uri = vscode.Uri.file(path.join(cwd, repoPath(t.file)));
        const line = Math.max(0, t.line - 1);
        const th = this.controller.createCommentThread(uri, new vscode.Range(line, 0, line, 0), t.comments.map((c) => ({ body: new vscode.MarkdownString(c.text), mode: vscode.CommentMode.Preview, author: { name: c.author } })));
        th.label = isOpen(t) ? "Review thread" : `Review thread (${t.status})`;
        th.contextValue = isOpen(t) ? "aihubOpen" : "aihubResolved";
        th.collapsibleState = isOpen(t) ? vscode.CommentThreadCollapsibleState.Expanded : vscode.CommentThreadCollapsibleState.Collapsed;
        th.canReply = true;
        this.shown.set(th, { id: t.threadId, model: t });
      }
    } catch (e) {
      this.log(`threads: ${(e as Error).message}`);
    }
  }

  private clear() {
    for (const th of this.shown.keys()) th.dispose();
    this.shown.clear();
  }

  private async post(th: vscode.CommentThread, status: ReplyStatus | "", text: string) {
    const entry = this.shown.get(th);
    const cwd = this.getCwd();
    if (!entry || !cwd) return;
    try {
      const args = replyArgs(this.pr, entry.id, status, text);
      this.log(`aihub ${args.join(" ")}`);
      await this.getRunner()(args, cwd);
      void vscode.window.showInformationMessage(status ? `Thread ${entry.id}: ${status}.` : `Replied to thread ${entry.id}.`);
      this.onChanged();
    } catch (e) {
      void vscode.window.showErrorMessage(`AI Context Hub: ${(e as Error).message}`);
    }
  }

  register(ctx: vscode.ExtensionContext) {
    const status = (s: ReplyStatus) => async (th: vscode.CommentThread) => {
      const text = await vscode.window.showInputBox({ prompt: s === "fixed" ? "What did you change? (optional)" : "Reason (optional)", ignoreFocusOut: true });
      if (text === undefined) return;
      await this.post(th, s, text);
    };
    ctx.subscriptions.push(
      this,
      vscode.commands.registerCommand("aihub.thread.resolve", status("fixed")),
      vscode.commands.registerCommand("aihub.thread.wontFix", status("wontFix")),
      vscode.commands.registerCommand("aihub.thread.reactivate", (th: vscode.CommentThread) => this.post(th, "active", "")),
      vscode.commands.registerCommand("aihub.thread.reply", (r: vscode.CommentReply) => this.post(r.thread, "", r.text)),
      vscode.commands.registerCommand("aihub.thread.fixInChat", async (th: vscode.CommentThread) => {
        const e = this.shown.get(th);
        if (e) await this.toChat(fixPrompt(this.pr, e.model));
      }),
    );
  }

  dispose() {
    this.clear();
    this.controller.dispose();
  }
}
