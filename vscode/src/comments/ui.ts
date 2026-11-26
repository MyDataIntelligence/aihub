import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { fixPrompt } from "../threadsModel";
import {
  badgeOf,
  commentMarkdown,
  fileCounts,
  markSeen,
  newSince,
  notice,
  openComments,
  outdatedMarkdown,
  parseThreadsRead,
  placeThread,
  prCounts,
  repoRel,
  statusLabel,
  suggestionRange,
  threadsArgs,
  type OpenComment,
  type Placement,
  type PrThread,
  type Seen,
  type Target,
  type ThreadsRead,
} from "./model";

/** Read no more often than the pull requests themselves: 5 minutes, a failed read too. */
export const COMMENTS_TTL_MS = 5 * 60_000;

export interface CommentsDeps {
  cli: (args: string[], cwd: string) => Promise<string>;
  log: (line: string) => void;
  /** what the title bar shows changed (counts, unread, the list) */
  changed: () => void;
  store: { read(): Seen; write(s: Seen): void };
  enabled: () => boolean;
  toChat?: (text: string) => Promise<void>;
  /** the window shows a set: its pull requests come from the set, not from the single-repository status bar */
  isSet?: () => boolean;
  now?: () => number;
}

interface Shown {
  target: Target;
  t: PrThread;
  at: Placement;
}

const pathKey = (p: string) => {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
};

/**
 * The review comments of the pull requests of a set (or of the one repository) in the editor and the Explorer. Reading is
 * one `aihub comments threads` for all pull requests, only when the pull request status is read anyway (a set opens, the
 * overview opens, focus back after 5 minutes, a refresh); opening a file starts nothing, it only places what was read.
 */
export class PrCommentsController implements vscode.Disposable, vscode.FileDecorationProvider {
  private targets: Target[] = [];
  private data: ThreadsRead = { prs: [], failed: [] };
  private at = 0;
  private running?: Promise<boolean>;
  private seen: Seen;
  private notified = new Set<string>();
  private controller?: vscode.CommentController;
  private byDoc = new Map<string, vscode.CommentThread[]>();
  private shown = new Map<vscode.CommentThread, Shown>();
  private suggestionOf = new WeakMap<vscode.Comment, { thread: vscode.CommentThread; index: number[] }>();
  private counts = new Map<string, { open: number; unread: number; pr: number }>();
  private deco = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.deco.event;
  private subs: vscode.Disposable[] = [];

  constructor(private deps: CommentsDeps) {
    this.seen = deps.store.read();
  }

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  register(ctx: vscode.ExtensionContext): this {
    const reg = (id: string, f: (...a: any[]) => unknown) =>
      this.subs.push(
        vscode.commands.registerCommand(id, (...a: unknown[]) =>
          Promise.resolve(f(...a)).catch((e) => void vscode.window.showErrorMessage(`AI Context Hub: ${(e as Error).message}`)),
        ),
      );
    this.subs.push(
      vscode.window.registerFileDecorationProvider(this),
      // opening a file places the threads that were read; no process, no network
      vscode.workspace.onDidOpenTextDocument((d) => this.placeDoc(d, true)),
      vscode.workspace.onDidCloseTextDocument((d) => this.unplace(d.uri)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration("aiContextHub.prComments")) return;
        if (this.deps.enabled()) void this.refresh(true);
        else this.clear();
      }),
    );
    reg("aihub.thread.reply", (r: vscode.CommentReply) => this.post(r.thread, "", r.text));
    // Resolve with text in the reply box sends both in one call
    reg("aihub.thread.resolve", (a: vscode.CommentThread | vscode.CommentReply) => this.post(threadOfArg(a), "fixed", textOfArg(a)));
    reg("aihub.thread.wontFix", (a: vscode.CommentThread | vscode.CommentReply) => this.post(threadOfArg(a), "wontFix", textOfArg(a)));
    reg("aihub.thread.reactivate", (a: vscode.CommentThread | vscode.CommentReply) => this.post(threadOfArg(a), "active", textOfArg(a)));
    reg("aihub.thread.applySuggestion", (c: vscode.Comment) => this.apply(c));
    reg("aihub.thread.fixInChat", async (a: vscode.CommentThread | vscode.CommentReply) => {
      const s = this.shown.get(threadOfArg(a));
      if (s && this.deps.toChat) await this.deps.toChat(fixPrompt(s.target.pr, { threadId: s.t.threadId, status: s.t.status, file: s.t.file, line: s.t.line, comments: s.t.comments }));
    });
    ctx.subscriptions.push(this);
    return this;
  }

  // ---- reading -------------------------------------------------------------------------------------------------

  /** The pull requests to read (repositories with an active pull request). A different set reads again at the next moment. */
  setTargets(targets: Target[]): void {
    const key = (ts: Target[]) => ts.map((t) => `${t.repo}:${t.pr}:${pathKey(t.path)}`).sort().join("|");
    if (key(targets) === key(this.targets)) return;
    this.targets = targets;
    if (!targets.length) return this.clear();
    // a branch switch that only drops a pull request (or brings back one that was read) reads nothing: the next read is at the usual moment
    const known = new Set(this.data.prs.map((p) => `${p.repo.toLowerCase()}:${p.pr}`));
    if (targets.some((t) => !t.repo || !known.has(`${t.repo.toLowerCase()}:${t.pr}`))) this.at = 0;
    this.redraw();
  }

  /** What was read for the pull requests that are targets now. */
  private current(): ThreadsRead {
    const want = new Set(this.targets.map((t) => `${t.repo.toLowerCase()}:${t.pr}`));
    return { ...this.data, prs: this.data.prs.filter((p) => want.has(`${p.repo.toLowerCase()}:${p.pr}`)) };
  }

  /** A window with one repository (no set): its pull request as the status bar read it; undefined: none or not active. */
  single(path: string | undefined, pr: number | undefined, url?: string): void {
    if (this.deps.isSet?.()) return;
    const t = this.targets[0];
    if (!(path && pr && t && this.targets.length === 1 && t.pr === pr && pathKey(t.path) === pathKey(path))) this.setTargets(path && pr ? [{ repo: "", path, pr, url }] : []);
    void this.refresh();
  }

  hasTargets(): boolean {
    return this.targets.length > 0;
  }

  /** Reads again unless read less than 5 minutes ago (`force`: the overview, a refresh). Never throws; true when it read. */
  refresh(force = false): Promise<boolean> {
    if (!this.deps.enabled() || !this.targets.length) return Promise.resolve(false);
    if (this.running) return this.running.then(() => false);
    if (!force && this.at && this.now() - this.at < COMMENTS_TTL_MS) return Promise.resolve(false);
    const targets = this.targets;
    const t0 = this.now();
    this.running = this.deps
      .cli(threadsArgs(targets), targets[0].path)
      .then((out) => {
        this.take(parseThreadsRead(out));
        this.deps.log(`pr comments: ${this.data.prs.length} pull request(s), ${this.data.prs.reduce((n, p) => n + p.threads.length, 0)} thread(s) in ${this.now() - t0} ms${this.data.failed.length ? `, failed: ${this.data.failed.map((f) => `${f.repo}:${f.pr}`).join(", ")}` : ""}`);
        return true;
      })
      .catch((e) => {
        this.deps.log(`pr comments: ${(e as Error).message}`);
        return false;
      })
      .finally(() => {
        // a failed read is remembered as long as a good one: no retry on every event
        this.at = this.now();
        this.running = undefined;
      });
    return this.running;
  }

  /** The window has the focus again: read when the last read is over 5 minutes old. */
  focusBack(): void {
    if (this.targets.length && this.now() - this.at >= COMMENTS_TTL_MS) void this.refresh();
  }

  private take(read: ThreadsRead) {
    // a single repository is read by number: its name comes back with the answer
    for (const t of this.targets) if (!t.repo) t.repo = read.prs.find((p) => p.pr === t.pr)?.repo ?? "";
    const { fresh, seen } = newSince(this.seen, read, this.notified);
    this.data = read;
    this.save(seen);
    this.redraw();
    const n = notice(fresh);
    if (n) {
      void vscode.window.showInformationMessage(n.message, { detail: n.detail }, "Show", "Later").then((pick) => {
        if (pick !== "Show") return;
        if (fresh.length === 1) void this.showComment({ repo: fresh[0].repo, threadId: fresh[0].threadId });
        else void this.pickComment();
      });
    }
  }

  private save(seen: Seen) {
    this.seen = seen;
    try {
      this.deps.store.write(seen);
    } catch {
      /* not kept: the same comment may count as new once more */
    }
  }

  private redraw() {
    this.counts = fileCounts(this.targets, this.data, this.seen, pathKey);
    this.deco.fire(undefined);
    for (const d of vscode.workspace.textDocuments) this.placeDoc(d, false);
    this.deps.changed();
  }

  // ---- what the title bar reads ----------------------------------------------------------------------------------

  countsOf(repo: string, pr: number): { open: number; unread: number } | undefined {
    return this.deps.enabled() ? prCounts(this.data, this.seen, repo, pr) : undefined;
  }

  list(): OpenComment[] | undefined {
    const read = this.current();
    if (!this.deps.enabled() || !read.prs.length) return undefined;
    return openComments(read, this.seen);
  }

  // ---- the Explorer --------------------------------------------------------------------------------------------

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== "file") return undefined;
    const c = this.counts.get(pathKey(uri.fsPath));
    if (!c?.open) return undefined;
    const tip = `${c.open} open comment${c.open === 1 ? "" : "s"} on pull request ${c.pr}${c.unread ? ` (${c.unread} new)` : ""}`;
    // no colour for the usual case: a colour would also paint the file name over the git colour; only new comments stand out
    return c.unread ? { badge: badgeOf(c.open), tooltip: tip, color: new vscode.ThemeColor("aiContextHub.prComments.unreadForeground") } : { badge: badgeOf(c.open), tooltip: tip };
  }

  // ---- the editor ------------------------------------------------------------------------------------------------

  private where(uri: vscode.Uri): { target: Target; rel: string } | undefined {
    if (uri.scheme !== "file") return undefined;
    const p = pathKey(uri.fsPath);
    for (const target of this.targets) {
      const root = pathKey(target.path);
      if (p.startsWith(`${root}/`)) return { target, rel: uri.fsPath.replace(/\\/g, "/").slice(root.length + 1) };
    }
    return undefined;
  }

  private threadsFor(target: Target, rel: string): PrThread[] {
    const p = this.data.prs.find((x) => x.repo.toLowerCase() === target.repo.toLowerCase() && x.pr === target.pr);
    const r = process.platform === "win32" ? rel.toLowerCase() : rel;
    return (p?.threads ?? []).filter((t) => t.file && (process.platform === "win32" ? repoRel(t.file).toLowerCase() : repoRel(t.file)) === r);
  }

  /** Puts the read threads of one document in place. `opened`: the user opened it now, so what is shown counts as read. */
  private placeDoc(doc: vscode.TextDocument, opened: boolean) {
    if (!this.deps.enabled()) return;
    const w = this.where(doc.uri);
    if (!w) return;
    const threads = this.threadsFor(w.target, w.rel);
    this.unplace(doc.uri);
    if (!threads.length) return;
    this.controller ??= this.makeController();
    const lines = doc.getText().split(/\r?\n/);
    const made: vscode.CommentThread[] = [];
    let seen = this.seen;
    for (const t of threads) {
      const at = placeThread(t, lines);
      if (!at) continue;
      const now = at.top || !t.anchor ? undefined : lines.slice(at.line, at.line + ((t.endLine ?? t.line ?? 0) - (t.line ?? 0) + 1));
      const th = this.controller.createCommentThread(doc.uri, new vscode.Range(at.line, 0, at.line, 0), []);
      th.comments = this.commentsOf(th, w.target, t, at, now);
      th.label = `${statusLabel(t, at.outdated)} · pull request ${w.target.pr}`;
      th.contextValue = t.open ? "aihubOpen" : "aihubResolved";
      th.canReply = t.open;
      th.collapsibleState = t.open ? vscode.CommentThreadCollapsibleState.Expanded : vscode.CommentThreadCollapsibleState.Collapsed;
      if ("state" in th && vscode.CommentThreadState) th.state = t.open ? vscode.CommentThreadState.Unresolved : vscode.CommentThreadState.Resolved;
      this.shown.set(th, { target: w.target, t, at });
      made.push(th);
      if (opened && t.open) seen = markSeen(seen, w.target.repo, w.target.pr, t);
    }
    this.byDoc.set(pathKey(doc.uri.fsPath), made);
    if (seen !== this.seen) {
      this.save(seen);
      this.counts = fileCounts(this.targets, this.data, this.seen, pathKey);
      this.deco.fire(undefined);
      this.deps.changed();
    }
  }

  private commentsOf(th: vscode.CommentThread, target: Target, t: PrThread, at: Placement, now: string[] | undefined): vscode.Comment[] {
    let s = 0;
    return t.comments.map((c, i) => {
      const own = t.suggestions.map((x, k) => (x.commentId === c.id ? k : -1)).filter((k) => k >= 0);
      const head = i === 0 && at.outdated ? `${outdatedMarkdown(t.original, now, t.side)}\n\n` : "";
      const body = new vscode.MarkdownString(head + commentMarkdown(c.text, t.suggestions[s]?.old ?? t.original ?? []));
      s += own.length;
      const comment: vscode.Comment = {
        body,
        mode: vscode.CommentMode.Preview,
        author: { name: c.author },
        ...(c.when ? { timestamp: new Date(c.when) } : {}),
        // a suggestion on a line that is still there can be applied; an outdated one not
        ...(own.length && t.open && !at.top ? { contextValue: "aihubSuggestion" } : {}),
      };
      if (own.length) this.suggestionOf.set(comment, { thread: th, index: own });
      return comment;
    });
  }

  private unplace(uri: vscode.Uri) {
    const k = pathKey(uri.fsPath);
    for (const th of this.byDoc.get(k) ?? []) {
      this.shown.delete(th);
      th.dispose();
    }
    this.byDoc.delete(k);
  }

  private makeController(): vscode.CommentController {
    const c = vscode.comments.createCommentController("aihub", "Pull request comments");
    c.options = { placeHolder: "Reply...", prompt: "Reply" };
    this.subs.push(c);
    return c;
  }

  private clear() {
    for (const th of this.shown.keys()) th.dispose();
    this.shown.clear();
    this.byDoc.clear();
    this.data = { prs: [], failed: [] };
    this.counts.clear();
    this.deco.fire(undefined);
    this.deps.changed();
  }

  // ---- writing -------------------------------------------------------------------------------------------------

  /** One `aihub comments reply` that posts and gives the changed thread back: no second read. */
  private async post(th: vscode.CommentThread | undefined, status: "" | "fixed" | "wontFix" | "active", text: string) {
    const s = th && this.shown.get(th);
    if (!s) return;
    if (!status && !text.trim()) return;
    const file = join(tmpdir(), `aihub-reply-${process.pid}-${Date.now()}.yaml`);
    // YAML reads JSON: the text goes as it was typed, new lines included
    writeFileSync(file, JSON.stringify([{ threadId: s.t.threadId, ...(text.trim() ? { text: text.trim() } : {}), ...(status ? { status } : {}) }]), "utf8");
    try {
      const out = await this.deps.cli(["comments", "reply", "--pr", String(s.target.pr), "--replies-file", file, "--return-threads", "--json"], s.target.path);
      const j = JSON.parse(out.slice(out.indexOf("{"))) as { threads?: PrThread[] };
      const p = this.data.prs.find((x) => x.repo.toLowerCase() === s.target.repo.toLowerCase() && x.pr === s.target.pr);
      if (p) for (const nt of j.threads ?? []) p.threads = p.threads.map((x) => (x.threadId === nt.threadId ? nt : x));
      const fresh = j.threads?.find((x) => x.threadId === s.t.threadId);
      if (fresh) this.save(markSeen(this.seen, s.target.repo, s.target.pr, fresh));
      this.deps.log(`pr comments: ${status || "reply"} on thread ${s.t.threadId} of pull request ${s.target.pr}`);
      this.redraw();
    } finally {
      try {
        unlinkSync(file);
      } catch {
        /* gone already */
      }
    }
  }

  /** The suggestion of a comment into the open file: a plain edit (Ctrl+Z undoes it), nothing saved or committed. */
  private async apply(c: vscode.Comment) {
    const m = this.suggestionOf.get(c);
    const s = m && this.shown.get(m.thread);
    if (!m || !s) return;
    let k = m.index[0];
    if (m.index.length > 1) {
      const pick = await vscode.window.showQuickPick(
        m.index.map((i, n) => ({ label: `Suggestion ${n + 1}`, detail: s.t.suggestions[i].new.join(" ⏎ ").slice(0, 200), i })),
        { placeHolder: "Which suggestion?" },
      );
      if (!pick) return;
      k = pick.i;
    }
    const sug = s.t.suggestions[k];
    const editor = await vscode.window.showTextDocument(m.thread.uri, { preserveFocus: false });
    const doc = editor.document;
    const r = suggestionRange(doc.getText().split(/\r?\n/), m.thread.range?.start.line ?? s.at.line, sug);
    if ("error" in r) {
      void vscode.window.showWarningMessage(`AI Context Hub: ${r.error}`);
      return;
    }
    const eol = doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    const range = r.end > r.start ? new vscode.Range(r.start, 0, r.end - 1, doc.lineAt(r.end - 1).text.length) : new vscode.Range(r.start, 0, r.start, 0);
    await editor.edit((b) => b.replace(range, sug.new.join(eol) + (r.end > r.start ? "" : eol)));
  }

  // ---- the title bar's commands ----------------------------------------------------------------------------------

  /** Opens the file on the line and unfolds the thread; a general comment shows its text with Open Pull Request. */
  async showComment(arg: { repo?: string; threadId?: number } | undefined): Promise<void> {
    const repo = arg?.repo?.toLowerCase();
    for (const p of this.data.prs) {
      if (repo && p.repo.toLowerCase() !== repo) continue;
      const t = p.threads.find((x) => x.threadId === arg?.threadId);
      const target = t && this.targets.find((x) => x.repo.toLowerCase() === p.repo.toLowerCase() && x.pr === p.pr);
      if (!t || !target) continue;
      this.save(markSeen(this.seen, p.repo, p.pr, t));
      if (t.file && !t.fileDeleted) {
        const uri = vscode.Uri.file(join(target.path, repoRel(t.file)));
        const doc = await vscode.workspace.openTextDocument(uri);
        this.placeDoc(doc, true);
        const th = (this.byDoc.get(pathKey(uri.fsPath)) ?? []).find((x) => this.shown.get(x)?.t.threadId === t.threadId);
        const line = th?.range?.start.line ?? 0;
        await vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0) });
        if (th) th.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      } else {
        const text = t.comments.map((c) => `${c.author}: ${c.text}`).join("\n\n");
        const open = "Open Pull Request";
        const pick = await vscode.window.showInformationMessage(`Comment on pull request ${p.pr}${t.fileDeleted && t.file ? ` (${repoRel(t.file)}, removed)` : ""}`, { modal: true, detail: text }, ...(target.url ? [open] : []));
        if (pick === open && target.url) await vscode.env.openExternal(vscode.Uri.parse(target.url));
      }
      this.redraw();
      return;
    }
    void vscode.window.showInformationMessage("AI Context Hub: that comment is not there any more; refresh the comments.");
  }

  /** The open comments as a list (Show on a notification of several new ones). */
  async pickComment(): Promise<void> {
    const list = this.list() ?? [];
    const pick = await vscode.window.showQuickPick(
      list.map((c) => ({ label: `${c.unread ? "$(circle-filled) " : ""}${c.file ? `${c.file}${c.line ? `:${c.line}` : ""}` : "General comment"}`, description: `${c.repo} · pull request ${c.pr} · ${c.author}`, detail: c.firstLine, c })),
      { placeHolder: "Open comments", matchOnDescription: true, matchOnDetail: true },
    );
    if (pick) await this.showComment({ repo: pick.c.repo, threadId: pick.c.threadId });
  }

  dispose(): void {
    for (const th of this.shown.keys()) th.dispose();
    this.shown.clear();
    this.subs.forEach((s) => s.dispose());
    this.deco.dispose();
  }
}

const threadOfArg = (a: vscode.CommentThread | vscode.CommentReply): vscode.CommentThread => ("thread" in a && a.thread ? a.thread : (a as vscode.CommentThread));
const textOfArg = (a: vscode.CommentThread | vscode.CommentReply): string => ("text" in a && typeof a.text === "string" ? a.text : "");

