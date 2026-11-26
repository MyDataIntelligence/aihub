import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  currentOf,
  linkBranch,
  markStatus,
  readStoryWorktrees,
  recordActivity,
  storyIdFromBranch,
  storyWorktreesFileFor,
  suggestCurrent,
  updateStoryWorktrees,
  type ActivityKind,
  type BranchStatus,
  type StoryBranch,
  type StoryWorktrees,
} from "../../cli/src/lib/storyWorktrees";
import { makeRunner, readJson, type Runner } from "./cli";
import { openWays, type OpenResultJson, type OpenWay } from "./repoSetModel";
import { answerExisting, pick, showOpened } from "./repoSetUi";
import { itemView, lastReflog, overlay, starQuestion, storyChildren, STAR_ANSWERS, type AutoMark, type BranchRowJson, type StoryJson, type StoryNode } from "./storyModel";
import { showFailure } from "./bar/failureUi";

/**
 * "My Stories" (Explorer view) and the star that follows where you work. The view reads `aihub story branches --json`
 * only when it is shown (and on Refresh); the star, old/parked and the label come from each repository's
 * story-worktrees.json, which the Worktree Maker writes too: a change there is shown at once (file watcher, no CLI).
 * Activity is counted from editor events only (save, edit, focus, commit and checkout from the git reflog): no timer
 * polls, the counts are written at most once a minute.
 */

const cfg = () => vscode.workspace.getConfiguration("aihub");
const slowRunner = (): Runner => makeRunner({ command: String(cfg().get("cliPath", "aihub")) || "aihub", timeoutMs: 120_000, env: { GCM_INTERACTIVE: "never", GIT_TERMINAL_PROMPT: "0" } });

export interface StoryDeps {
  cwd: () => string | undefined;
  log: (line: string) => void;
  /** the recent list: called before the window changes */
  opened?: (story: { id: number; title: string }) => Promise<void>;
}

/** The git dir of a checkout or linked worktree (where HEAD and logs/HEAD are), read from `.git` without git. */
export function gitDirOf(dir: string): string | undefined {
  const dotGit = path.join(dir, ".git");
  try {
    if (fs.statSync(dotGit).isDirectory()) return dotGit;
    const m = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(dotGit, "utf8"));
    return m ? path.resolve(dir, m[1].trim()) : undefined;
  } catch {
    return undefined;
  }
}

/** The branch checked out in `dir` (from HEAD), "" when detached or unknown. */
export function headBranch(dir: string): string {
  const g = gitDirOf(dir);
  if (!g) return "";
  try {
    const m = /^ref: refs\/heads\/(.+)$/m.exec(fs.readFileSync(path.join(g, "HEAD"), "utf8"));
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
}

// ---- the view ----------------------------------------------------------------------------------------------

export class StoriesView implements vscode.TreeDataProvider<StoryNode> {
  private emitter = new vscode.EventEmitter<StoryNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private data?: Promise<StoryJson[]>;

  constructor(private deps: StoryDeps) {}

  /** Read again from Azure DevOps (Refresh button). */
  reload(): void {
    this.data = undefined;
    this.emitter.fire(undefined);
  }

  /** Only the local star/label changed: redraw from the cached read, no process. */
  redraw(): void {
    this.emitter.fire(undefined);
  }

  /** `quiet`: a picker that only adds the stories when they come (no warning when Azure DevOps cannot be read) */
  stories(quiet = false): Promise<StoryJson[]> {
    const cwd = this.deps.cwd();
    if (!cwd) return Promise.resolve([]);
    this.data ??= readJson<{ stories: StoryJson[] }>(slowRunner(), ["story", "branches"], cwd).then(
      (r) => r.stories,
      (e: Error) => {
        this.deps.log(`story branches: ${e.message}`);
        if (!quiet) void showFailure(e, "could not read your stories", "warning");
        this.data = undefined;
        return [];
      },
    );
    return this.data.then((s) => overlay(s, localFiles(this.deps.cwd())));
  }

  async getChildren(n?: StoryNode): Promise<StoryNode[]> {
    const stories = await this.stories();
    if (!n && !stories.length) return [];
    const fresh = n ? stories.find((s) => s.id === n.story.id) : undefined;
    return storyChildren(n && fresh ? ({ ...n, story: fresh, ...(n.kind === "repo" ? { rows: fresh.branches.filter((b) => b.repo === n.repo) } : {}) } as StoryNode) : n, stories);
  }

  getTreeItem(n: StoryNode): vscode.TreeItem {
    const v = itemView(n);
    // a story without branches has nothing to open: no arrow, no empty expanded row
    const leaf = n.kind === "branch" || (n.kind === "story" && !n.story.branches.length);
    const it = new vscode.TreeItem(v.label, leaf ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Expanded);
    it.description = v.description;
    it.tooltip = v.tooltip;
    it.iconPath = new vscode.ThemeIcon(v.icon, v.dim ? new vscode.ThemeColor("disabledForeground") : undefined);
    it.contextValue = v.contextValue;
    it.id = n.kind === "story" ? `s${n.story.id}` : n.kind === "repo" ? `s${n.story.id}/${n.repo}` : `s${n.story.id}/${n.row.repo}/${n.row.branch}`;
    return it;
  }
}

/** repo name -> its story-worktrees.json branches, for the repositories next to the current one. */
function localFiles(cwd: string | undefined): Record<string, Record<string, StoryBranch>> {
  const out: Record<string, Record<string, StoryBranch>> = {};
  if (!cwd) return out;
  const parent = path.dirname(mainCheckout(cwd));
  for (const name of safeReaddir(parent)) {
    const file = storyWorktreesFileFor(path.join(parent, name));
    if (!file || !fs.existsSync(file)) continue;
    try {
      out[name] = readStoryWorktrees(file).branches;
    } catch {
      /* a newer schema: shown by the CLI, not overlaid */
    }
  }
  return out;
}

const safeReaddir = (d: string) => {
  try {
    return fs.readdirSync(d).filter((n) => fs.existsSync(path.join(d, n, ".git")));
  } catch {
    return [];
  }
};

/** The main checkout of the repository `dir` is in (a worktree's common dir is `<main>/.git`). */
function mainCheckout(dir: string): string {
  const file = storyWorktreesFileFor(dir);
  return file ? path.dirname(path.dirname(path.dirname(file))) : dir;
}

// ---- activity and the star ---------------------------------------------------------------------------------

interface Folder {
  dir: string;
  file: string;
  branch: string;
}

/**
 * Counts what you do per worktree and writes it to story-worktrees.json, then asks (or, with
 * aihub.storyWorktrees.autoMarkCurrent = auto, moves the star itself) when you clearly work in another branch.
 */
export class StarTracker implements vscode.Disposable {
  private folders = new Map<string, Folder>();
  private pending = new Map<string, { branch: string; kind: ActivityKind; amount: number; at: number }[]>();
  private flushTimer?: ReturnType<typeof setTimeout>;
  private focusStart?: { at: number; folder: string };
  private lastEdit = new Map<string, number>();
  private asked = new Set<number>();
  private subs: vscode.Disposable[] = [];
  /** called after the file changed (by us or another extension): the view redraws */
  onChange?: () => void;

  constructor(private deps: StoryDeps, private now: () => number = Date.now) {}

  start(): void {
    this.subs.push(
      vscode.workspace.onDidSaveTextDocument((d) => this.add(d.uri, "save")),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (!e.contentChanges.length || e.document.uri.scheme !== "file") return;
        // at most one edit point per document per minute
        const k = e.document.uri.toString();
        const t = this.now();
        if (t - (this.lastEdit.get(k) ?? 0) < 60_000) return;
        this.lastEdit.set(k, t);
        this.add(e.document.uri, "edit");
      }),
      vscode.window.onDidChangeWindowState((s) => (s.focused ? this.focusOn(vscode.window.activeTextEditor?.document.uri) : this.focusOff(true))),
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        if (!vscode.window.state.focused) return;
        this.focusOff(false);
        this.focusOn(ed?.document.uri);
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.watch()),
    );
    this.watch();
    if (vscode.window.state.focused) this.focusOn(vscode.window.activeTextEditor?.document.uri);
  }

  /** One narrow watcher per worktree on its reflog (commit, checkout) and one per repository on story-worktrees.json. */
  private watchers: vscode.Disposable[] = [];
  private watch(): void {
    this.watchers.forEach((w) => w.dispose());
    this.watchers = [];
    this.folders.clear();
    const files = new Set<string>();
    for (const wf of vscode.workspace.workspaceFolders ?? []) {
      const dir = wf.uri.fsPath;
      const file = storyWorktreesFileFor(dir);
      const gitDir = gitDirOf(dir);
      if (!file || !gitDir) continue;
      const folder: Folder = { dir, file, branch: headBranch(dir) };
      this.folders.set(dir, folder);
      // a worktree opened on a story branch belongs to that story
      if (folder.branch) this.autoLink(folder);
      const reflog = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.join(gitDir, "logs")), "HEAD"));
      const onLog = () => void this.onReflog(dir, path.join(gitDir, "logs", "HEAD"));
      reflog.onDidChange(onLog);
      reflog.onDidCreate(onLog);
      this.watchers.push(reflog);
      if (!files.has(file)) {
        files.add(file);
        const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file)));
        const changed = () => this.onChange?.();
        w.onDidChange(changed);
        w.onDidCreate(changed);
        this.watchers.push(w);
      }
    }
  }

  private folderOf(uri: vscode.Uri | undefined): Folder | undefined {
    if (!uri || uri.scheme !== "file") return undefined;
    const wf = vscode.workspace.getWorkspaceFolder(uri);
    return wf ? this.folders.get(wf.uri.fsPath) : undefined;
  }

  private add(uri: vscode.Uri | undefined, kind: ActivityKind, amount = 1, f = this.folderOf(uri)): void {
    if (!f?.branch) return;
    const list = this.pending.get(f.file) ?? [];
    list.push({ branch: f.branch, kind, amount, at: this.now() });
    this.pending.set(f.file, list);
    this.scheduleFlush();
  }

  private focusOn(uri: vscode.Uri | undefined): void {
    const f = this.folderOf(uri) ?? [...this.folders.values()][0];
    if (f) this.focusStart = { at: this.now(), folder: f.dir };
  }

  private focusOff(flush: boolean): void {
    const s = this.focusStart;
    this.focusStart = undefined;
    if (s) {
      const minutes = (this.now() - s.at) / 60_000;
      const f = this.folders.get(s.folder);
      if (f && minutes >= 0.5) this.add(undefined, "focus", Math.min(minutes, 240), f);
    }
    if (flush) this.flush();
  }

  private async onReflog(dir: string, file: string): Promise<void> {
    const f = this.folders.get(dir);
    if (!f) return;
    let tail = "";
    try {
      const h = await fs.promises.open(file, "r");
      const size = (await h.stat()).size;
      const buf = Buffer.alloc(Math.min(4096, size));
      await h.read(buf, 0, buf.length, size - buf.length);
      await h.close();
      tail = buf.toString("utf8").trimEnd().split("\n").pop() ?? "";
    } catch {
      return;
    }
    const r = lastReflog(tail);
    if (r.kind === "commit") return this.add(undefined, "commit", 1, f);
    if (r.kind !== "checkout") return;
    f.branch = headBranch(dir);
    if (!f.branch) return;
    this.autoLink(f);
    this.add(undefined, "checkout", 1, f);
  }

  /** A branch with a story number in its name belongs to that story: linked without a question (locally now, in Azure DevOps by the CLI). */
  private autoLink(f: Folder): void {
    const id = storyIdFromBranch(f.branch);
    if (!id) return;
    let added = false;
    try {
      // read first: an already linked branch costs no write (and no watcher event)
      if (readStoryWorktrees(f.file).branches[f.branch]) return;
      updateStoryWorktrees(f.file, (d) => {
        if (d.branches[f.branch]) return d;
        added = true;
        return linkBranch(d, { storyId: id, branch: f.branch, worktree: f.dir, current: !currentOf(d, id) }, this.now());
      });
    } catch (e) {
      return this.deps.log(`story link ${f.branch}: ${(e as Error).message}`);
    }
    if (!added) return;
    this.deps.log(`story ${id}: linked ${f.branch}`);
    void slowRunner()(["story", "branches", "link", "--id", String(id), "--branch", f.branch, "--json"], f.dir).catch((e: Error) => this.deps.log(`story ${id}: Azure DevOps link for ${f.branch} not made: ${e.message}`));
    this.onChange?.();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), 60_000);
  }

  /** Writes the counted activity and checks the star of the stories it touched. */
  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    const touched: { file: string; storyId: number }[] = [];
    for (const [file, all] of this.pending) {
      try {
        // only branches that belong to a story count; nothing to write is no write
        const linked = readStoryWorktrees(file).branches;
        const events = all.filter((e) => linked[e.branch]);
        if (!events.length) continue;
        const d = updateStoryWorktrees(file, (d0) => events.reduce((d1, e) => recordActivity(d1, e.branch, e.kind, e.at, e.amount), d0));
        for (const e of events) {
          const id = d.branches[e.branch]?.storyId;
          if (id && !touched.some((t) => t.file === file && t.storyId === id)) touched.push({ file, storyId: id });
        }
      } catch (e) {
        this.deps.log(`activity not saved in ${file}: ${(e as Error).message}`);
      }
    }
    this.pending.clear();
    for (const t of touched) void this.check(t.file, t.storyId);
  }

  async check(file: string, storyId: number): Promise<void> {
    const mode = cfg().get<AutoMark>("storyWorktrees.autoMarkCurrent", "ask");
    if (mode === "off" || this.asked.has(storyId)) return;
    let d: StoryWorktrees;
    try {
      d = readStoryWorktrees(file);
    } catch {
      return;
    }
    const s = suggestCurrent(d, storyId, this.now());
    if (!s) return;
    this.asked.add(storyId);
    if (mode === "auto") {
      this.mark(file, s.branch, "current");
      const undo = await vscode.window.showInformationMessage(`★ moved to ${s.branch} for story ${storyId} (you work there most).`, "Undo");
      if (undo === "Undo" && s.current) this.mark(file, s.current, "current");
      return;
    }
    const a = await vscode.window.showInformationMessage(starQuestion(s), STAR_ANSWERS.yes, STAR_ANSWERS.no, STAR_ANSWERS.never);
    if (a === STAR_ANSWERS.yes) this.mark(file, s.branch, "current");
    else if (a === STAR_ANSWERS.no) updateStoryWorktrees(file, (x) => ({ ...x, branches: { ...x.branches, [s.branch]: { ...x.branches[s.branch], declinedScore: s.score } } }));
    else if (a === STAR_ANSWERS.never) updateStoryWorktrees(file, (x) => ({ ...x, stories: { ...x.stories, [String(storyId)]: { ...x.stories[String(storyId)], neverAsk: true } } }));
    // a "No" may be asked again later in this window when the pattern gets clearly stronger
    if (a === STAR_ANSWERS.no) this.asked.delete(storyId);
  }

  mark(file: string, branch: string, status: BranchStatus, label?: string): void {
    updateStoryWorktrees(file, (d) => markStatus(d, branch, status, this.now(), label));
    this.onChange?.();
  }

  dispose(): void {
    this.focusOff(true);
    this.watchers.forEach((w) => w.dispose());
    this.subs.forEach((s) => s.dispose());
  }
}

// ---- commands ----------------------------------------------------------------------------------------------

type BranchNode = Extract<StoryNode, { kind: "branch" }>;

export function registerStories(ctx: vscode.ExtensionContext, deps: StoryDeps): { view: StoriesView; tracker: StarTracker } {
  const view = new StoriesView(deps);
  const tracker = new StarTracker(deps);
  tracker.onChange = () => view.redraw();
  const cwd = () => deps.cwd() ?? "";
  const fail = (e: unknown) => void showFailure(e);
  const cli = (args: string[], dir = cwd()) => slowRunner()([...args, "--json"], dir);
  /** the clone of a repository next to the current one, for local changes */
  const repoDirOf = (repo: string) => path.join(path.dirname(mainCheckout(cwd())), repo);
  const fileOf = (repo: string) => storyWorktreesFileFor(repoDirOf(repo));
  const local = (n: BranchNode, change: (file: string) => void) => {
    const file = fileOf(n.row.repo);
    if (!file) return void vscode.window.showWarningMessage(`AI Context Hub: ${n.row.repo} is not cloned next to this repository.`);
    try {
      // a branch linked only in Azure DevOps is linked locally first
      updateStoryWorktrees(file, (d) => (d.branches[n.row.branch] ? d : linkBranch(d, { storyId: n.story.id, branch: n.row.branch, worktree: n.row.worktree }, Date.now())));
      change(file);
    } catch (e) {
      fail(e);
    }
    view.redraw();
  };
  const reg = (id: string, f: (...a: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, (...a) => Promise.resolve(f(...a)).catch(fail)));

  const view$ = vscode.window.createTreeView("aihub.myStories", { treeDataProvider: view, showCollapseAll: true });
  ctx.subscriptions.push(view$, tracker);
  // nothing at activation: the tracker starts a few seconds after the window is up
  const t = setTimeout(() => tracker.start(), 5000);
  ctx.subscriptions.push({ dispose: () => clearTimeout(t) });

  reg("aihub.stories.refresh", () => view.reload());
  reg("aihub.stories.markCurrent", (n: BranchNode) => local(n, (f) => tracker.mark(f, n.row.branch, "current")));
  reg("aihub.stories.markOld", (n: BranchNode) => local(n, (f) => tracker.mark(f, n.row.branch, "old")));
  reg("aihub.stories.markParked", (n: BranchNode) => local(n, (f) => tracker.mark(f, n.row.branch, "parked")));
  reg("aihub.stories.label", async (n: BranchNode) => {
    const label = await vscode.window.showInputBox({ title: `Label for ${n.row.branch}`, value: n.row.label ?? "", prompt: "A short note, e.g. spike for the demo (empty removes it)" });
    if (label !== undefined) local(n, (f) => tracker.mark(f, n.row.branch, n.row.status, label.trim() || undefined));
  });
  reg("aihub.stories.unlink", async (n: BranchNode) => {
    await cli(["story", "branches", "unlink", "--id", String(n.story.id), "--branch", n.row.branch, "--repo", n.row.repo]);
    view.reload();
  });
  reg("aihub.stories.remove", async (n: BranchNode) => {
    const go = await vscode.window.showWarningMessage(
      `Remove ${n.row.branch} from ${n.row.repo}?`,
      { modal: true, detail: "The worktree and the local branch are removed. Uncommitted work and commits that are on no remote are never thrown away: then nothing is removed and you get the reason. The remote branch stays." },
      "Remove",
    );
    if (go !== "Remove") return;
    const out = await cli(["story", "branches", "remove", "--branch", n.row.branch, "--repo", n.row.repo, "--delete-branch"]);
    const msg = (JSON.parse(out.slice(out.indexOf("{"))) as { messages: string[] }).messages.join("\n");
    void (/kept/.test(msg) ? vscode.window.showWarningMessage(msg) : vscode.window.showInformationMessage(msg));
    view.reload();
  });
  reg("aihub.stories.openWorktree", async (n: BranchNode) => {
    if (n.row.worktree) await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(n.row.worktree), { forceNewWindow: true });
  });
  reg("aihub.stories.link", async (n?: StoryNode) => {
    const story = n?.story ?? (await chooseStory(view));
    if (!story) return;
    const dirs = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath).filter((d) => storyWorktreesFileFor(d));
    if (!dirs.length) return void vscode.window.showWarningMessage("AI Context Hub: open a repository to link its branches.");
    type Row = vscode.QuickPickItem & { dir: string; branch: string };
    const rows: Row[] = [];
    for (const dir of dirs) {
      const here = headBranch(dir);
      const repo = path.basename(mainCheckout(dir));
      const all = (await slowRunner()(["worktree", "branches", "--repos", mainCheckout(dir), "--json"], dir).then((o) => (JSON.parse(o.slice(o.indexOf("{"))) as { branches: { name: string }[] }).branches.map((b) => b.name)).catch(() => [] as string[])).filter((b) => b !== here);
      const linked = new Set(story.branches.filter((b) => b.repo === repo).map((b) => b.branch));
      if (here && !linked.has(here)) rows.push({ label: `$(check) ${here}`, description: `${repo} · current branch`, dir, branch: here, picked: true });
      for (const b of all.filter((x) => !linked.has(x))) rows.push({ label: `$(git-branch) ${b}`, description: repo, dir, branch: b, picked: storyIdFromBranch(b) === story.id });
    }
    const picked = await vscode.window.showQuickPick(rows, { canPickMany: true, title: `Link branches to story ${story.id}`, placeHolder: "Tick the branches (the current one is ticked); Enter links them" });
    if (!picked?.length) return;
    for (const dir of [...new Set(picked.map((p) => p.dir))]) {
      const branches = picked.filter((p) => p.dir === dir).map((p) => p.branch);
      await cli(["story", "branches", "link", "--id", String(story.id), "--branch", branches.join(","), "--repo", path.basename(mainCheckout(dir)), ...(story.branches.some((b) => b.status === "current" && b.repo === path.basename(mainCheckout(dir))) ? [] : ["--current"])], dir);
    }
    view.reload();
  });
  reg("aihub.stories.open", async (n?: StoryNode) => {
    const story = n?.story ?? (await chooseStory(view));
    if (!story) return;
    const way = await pick<OpenWay>(openWays(), `Open Story · #${story.id} ${story.title}`, "How should the ★ branches be opened?");
    if (!way) return;
    const args = ["story", "open", "--id", String(story.id), "--mode", way.mode, "--window", "none"];
    const first = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Opening story ${story.id}...` }, () => cli(args));
    // a ★ branch with a worktree elsewhere: move / reuse / recreate, as the CLI asks
    const out = await answerExisting(first, (extra) => cli([...args, ...extra]));
    if (out === undefined) return;
    await deps.opened?.({ id: story.id, title: story.title }).catch(() => undefined);
    await showOpened(JSON.parse(out.slice(out.indexOf("{"))) as OpenResultJson, way.window, deps.log);
  });
  return { view, tracker };
}

async function chooseStory(view: StoriesView): Promise<StoryJson | undefined> {
  const stories = view.stories();
  return pick(
    stories.then((list) => (list.length ? list.map((s) => ({ label: `#${s.id} ${s.title}`, description: `${s.state} · ${s.branches.length} branches`, detail: s.branches.filter((b) => b.status === "current").map((b) => `★ ${b.repo}: ${b.branch}`).join("   ") || undefined, value: s })) : [{ label: "No active stories assigned to you", value: undefined }])),
    "Open Story · choose the story",
    "Your active stories",
  );
}

export type { BranchRowJson };
