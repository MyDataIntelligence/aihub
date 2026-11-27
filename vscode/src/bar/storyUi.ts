import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";
import { gitEnvironment } from "../../../cli/src/lib/gitEnv";
import { forgetScan, headBranchOf, setOfStory } from "../../../cli/src/lib/machineScan";
import { pathKey, readRecentUse } from "../../../cli/src/lib/recentUse";
import { divergenceKey, divergenceMessage, divergences, markDivergenceSeen, seenDivergence, type Divergence } from "../../../cli/src/lib/setDivergence";
import { readSetFile, stampStoryTitle } from "../../../cli/src/lib/setFile";
import { readSeenStories } from "../../../cli/src/lib/storyCache";
import { readJson } from "../cli";
import { cli, runner } from "./runner";
import type { OpenResultJson } from "../repoSetModel";
import { answerExisting, askCloneCheckedOut, askSmartCheckout, showOpened } from "../repoSetUi";
import { showFailure } from "./failureUi";
import { dirtyFiles, fileList, smartCheckout } from "./smartCheckout";
import type { StoryJson } from "../storyModel";
import { BarEngine, openFacts, storyBranchesOf, titleFromFiles } from "./engine";
import { nextStoryBranch, openStoryArgs, rowDescription, storyNumberOf, storyPickRows, storyRepoRows, type StoryRef, type StoryRepoRow } from "./storyModel";
import { windowChoice, openPath } from "./window";
import { withUndo } from "./undoUi";
import { addable, branchChoices, singleToSetArgs, validBranchName, type RepoPick } from "./singleToSet";
import { notOnThisPc, openReposArgOf, preTicked, type NewSetRepo } from "./newSet";
import { BAR_COMMANDS } from "./types";
import { targetInfo } from "./repoStatus";
import { branchesOf, copyName, gitRun, openOwn, ownWindowItems, worktreesOf } from "./ownWindow";

/**
 * Open Story, and the branch commands of a story set. The flows are quick picks (no webviews); every action is an
 * `aihub` command, run when the user asks. Azure DevOps is read only here, on request: one `aihub story branches`.
 */

/** What links were read last, per story: `<story>|<repo>|<branch>` -> linked in Azure DevOps. Fed by the reads here; the state shows it. */
const linkedMemo = new Map<string, boolean>();
export const linkedOf = (story: number, repo: string, branch: string): boolean | undefined => linkedMemo.get(`${story}|${repo}|${branch}`);
function remember(story: number, setRepos: { name: string; branch: string }[], rows: StoryJson["branches"]): void {
  for (const r of setRepos) linkedMemo.set(`${story}|${r.name}|${r.branch}`, rows.some((x) => x.repo === r.name && x.branch === r.branch && (x.linked === "ado" || x.linked === "both")));
}

export interface StoryHooks {
  engine: BarEngine;
  log: (line: string) => void;
  changed: () => void;
  reg: (id: string, f: (...a: any[]) => unknown) => void;
  /** a command ran git in the set's repositories: what was remembered about their HEAD is stale */
  afterGit?: () => void;
  /** read the pull requests again, with their build policies */
  refreshPrs?: () => Promise<void>;
}

const idArg = (a: unknown): number | undefined => {
  const v = a && typeof a === "object" && "id" in a ? (a as { id: unknown }).id : a;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

/** A folder with a git repository to run `aihub` in: the window's own, else one that was used, else any on this PC. */
function cliCwd(engine: BarEngine): string | undefined {
  const f = openFacts(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
  const own = f.set?.repos[0]?.path ?? f.repo?.path;
  if (own) return own;
  const recent = readRecentUse(process.env).find((r) => r.kind === "repo" && existsSync(r.id))?.id;
  return recent ?? engine.scan().repos[0]?.path;
}

// ---- the story picker ----------------------------------------------------------------------------------------

interface Picked {
  story: StoryRef;
  /** the branches of the story when the fresh list already had them */
  rows?: StoryJson["branches"];
}

/** Seen stories at once, your active stories when Azure DevOps answers; typing a number offers that story. */
function pickStory(engine: BarEngine, cwd: string | undefined): Promise<Picked | undefined> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { story?: StoryRef }>();
    let fresh: StoryJson[] | undefined;
    let done = false;
    const finish = (p: Picked | undefined) => {
      if (done) return;
      done = true;
      resolve(p);
      qp.hide();
      qp.dispose();
    };
    const rowsFor = () => {
      const base = storyPickRows(Object.values(readSeenStories(process.env)), fresh?.map((s) => ({ id: s.id, title: s.title, state: s.state })));
      const typed = storyNumberOf(qp.value);
      const items: (vscode.QuickPickItem & { story?: StoryRef })[] = base.map((s) => ({ label: `#${s.id} ${s.title}`, description: s.state, story: s }));
      if (typed && !base.some((s) => s.id === typed)) items.unshift({ label: `$(search) Open story #${typed}`, description: "by number", story: { id: typed, title: "" } });
      return items;
    };
    Object.assign(qp, { title: "Open Story", placeholder: "Story number or words", matchOnDescription: true, ignoreFocusOut: true, busy: !!cwd });
    const refill = () => {
      qp.items = rowsFor();
    };
    refill();
    qp.onDidChangeValue(refill);
    qp.onDidAccept(() => {
      const it = qp.selectedItems[0] ?? qp.activeItems[0];
      if (!it?.story) return;
      const row = fresh?.find((s) => s.id === it.story!.id);
      finish({ story: it.story, rows: row?.branches });
    });
    qp.onDidHide(() => finish(undefined));
    qp.show();
    if (!cwd) return void (qp.busy = false);
    void readJson<{ stories: StoryJson[] }>(runner(), ["story", "branches"], cwd).then(
      (r) => {
        fresh = r.stories;
        qp.busy = false;
        refill();
      },
      (e: Error) => {
        qp.busy = false;
        qp.placeholder = `Story number or words (your stories could not be read: ${e.message.slice(0, 80)})`;
      },
    );
  });
}

// ---- Open Story ----------------------------------------------------------------------------------------------

/** The branches of the story and its title (the one read that Open Story by number needs before it names anything). */
async function storyRead(story: StoryRef, picked: Picked, cwd: string): Promise<{ branches: StoryJson["branches"]; title?: string }> {
  if (picked.rows && story.title) return { branches: picked.rows };
  const r = await readJson<{ stories: StoryJson[] }>(runner(), ["story", "branches", "--id", String(story.id)], cwd);
  return { branches: picked.rows ?? r.stories[0]?.branches ?? [], title: r.stories[0]?.title || undefined };
}

async function storyRows(story: StoryRef, picked: Picked, cwd: string): Promise<StoryJson["branches"]> {
  return (await storyRead(story, picked, cwd)).branches;
}

/** Tick the repositories: the story's linked branches ticked, the others (all on this PC) unticked with "new branch". */
async function pickRepos(story: StoryRef, rows: StoryRepoRow[], notOnThisPc: string[]): Promise<StoryRepoRow[] | undefined> {
  type Item = vscode.QuickPickItem & { row: StoryRepoRow };
  const items: Item[] = rows.map((r) => ({ label: r.repo, description: rowDescription(r), detail: r.branch ? (r.linked === false ? "exists, not linked to the story yet: it is linked after opening" : "linked to the story in Azure DevOps") : undefined, picked: r.picked, row: r }));
  const qp = vscode.window.createQuickPick<Item>();
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: StoryRepoRow[] | undefined) => {
      if (done) return;
      done = true;
      resolve(v);
      qp.hide();
      qp.dispose();
    };
    const hint = () => `Enter opens ${qp.selectedItems.length} ${qp.selectedItems.length === 1 ? "repository" : "repositories"}`;
    Object.assign(qp, { title: `Open Story #${story.id} ${story.title}`.trim(), canSelectMany: true, ignoreFocusOut: true, matchOnDescription: true, items });
    qp.selectedItems = items.filter((i) => i.picked);
    qp.placeholder = notOnThisPc.length ? `${hint()}  (not cloned on this PC: ${notOnThisPc.join(", ")})` : hint();
    qp.onDidChangeSelection(() => (qp.placeholder = notOnThisPc.length ? `${hint()}  (not cloned on this PC: ${notOnThisPc.join(", ")})` : hint()));
    qp.onDidAccept(() => finish(qp.selectedItems.length ? qp.selectedItems.map((i) => i.row) : undefined));
    qp.onDidHide(() => finish(undefined));
    qp.show();
  });
}

async function openStory(h: StoryHooks, arg: unknown): Promise<void> {
  const cwd = cliCwd(h.engine);
  const given = idArg(arg);
  const picked: Picked | undefined = given ? { story: { id: given, title: readSeenStories(process.env)[given]?.title ?? "" } } : await pickStory(h.engine, cwd);
  if (!picked) return;
  let story = picked.story;
  // the story of this window: nothing to open, one quiet line
  const here = openFacts(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath).set;
  if (here && here.story === story.id) return void vscode.window.showInformationMessage(`AI Context Hub: #${story.id} is already open in this window.`);
  const scan = h.engine.scan({ refresh: true });
  const have = setOfStory(scan, story.id);
  const repositories = await h.engine.repositories();
  if (have && have.repos.some((r) => r.exists)) {
    // a story has one set: that set opens, nothing is asked. The links are compared first (one read), and told once when they differ.
    h.log(`open story ${story.id}: its set ${have.id}`);
    if (cwd) await checkDivergence(h, story.id, have.repos.filter((r) => r.exists).map((r) => ({ name: r.name, branch: r.branch, path: r.path })), picked, cwd, windowChoice() === "this");
    if (story.title) stampStoryTitle(have.folder, story.id, story.title);
    await vscode.commands.executeCommand("aihub.bar.openSet", { id: have.id });
    return;
  }
  if (!cwd) return void vscode.window.showWarningMessage("AI Context Hub: no repository is known on this PC yet. Add a folder with Folders to Look In...");
  const read = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Reading story ${story.id}...` }, () => storyRead(story, picked, cwd));
  const rows = read.branches;
  // by number the title is not known yet: it comes with this read, before the branch and the folder are named
  if (!story.title && read.title) story = { ...story, title: read.title };
  const { rows: repoRows, notOnThisPc } = storyRepoRows(rows, repositories);
  if (!repoRows.length) return void vscode.window.showWarningMessage("AI Context Hub: there are no repositories on this PC. Add a folder with Folders to Look In...");
  const ticked = await pickRepos(story, repoRows, notOnThisPc);
  if (!ticked) return;
  // the set this makes (worktrees, branches, set file) can be undone while nothing is changed in it
  await withUndo(
    h,
    `Open story #${story.id}`,
    "",
    async () => {
    const args = [...openStoryArgs(story, ticked), "--json"];
    const first = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Opening story ${story.id}...` }, () => cli(args, ticked[0].path));
    const out = await answerExisting(first, (extra) => cli([...args, ...extra], ticked[0].path), { ownWindow: true });
    if (out === undefined) return undefined;
    const res = JSON.parse(out.slice(out.indexOf("{"))) as OpenResultJson;
    // the branches made new for the story are linked to it in Azure DevOps (the ones that were linked already are left alone)
    for (const r of ticked.filter((t) => !t.branch || t.linked === false)) {
      const made = res.repos.find((x) => x.repo === r.repo && x.ok);
      if (made) void cli(["story", "branches", "link", "--id", String(story.id), "--branch", made.branch, "--repo", r.repo], r.path).catch((e: Error) => h.log(`story ${story.id}: Azure DevOps link for ${made.branch} not made: ${e.message}`));
    }
    forgetScan(process.env);
    if (story.title && res.folder) stampStoryTitle(res.folder, story.id, story.title);
    await showOpened(res, windowChoice(), h.log, { storyTitle: story.title });
    h.changed();
    return res;
    },
    { sources: ticked.map((t) => t.path), created: (r) => r?.folder, message: (r) => (r ? `Story #${story.id} is open` : "") },
  );
}

// ---- the story links another branch ----------------------------------------------------------------------------

/** One read of the story's links; when the set is on another branch than the story links, one notification with three choices. */
async function checkDivergence(h: StoryHooks, story: number, repos: { name: string; branch: string; path: string }[], picked: Picked | undefined, cwd: string, wait: boolean): Promise<void> {
  let rows: StoryJson["branches"];
  try {
    rows = picked?.rows ?? (await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Checking the links of story ${story}...` }, () => storyRows({ id: story, title: "" }, picked ?? { story: { id: story, title: "" } }, cwd)));
  } catch (e) {
    return h.log(`story ${story}: links not read: ${(e as Error).message}`);
  }
  remember(story, repos, rows);
  h.changed();
  const d = divergences(repos, rows);
  if (!d.length) return;
  const key = divergenceKey(story, d);
  if (seenDivergence(process.env, key)) return;
  markDivergenceSeen(process.env, key);
  const link = "Link this branch";
  const sw = "Switch to the linked one";
  const keep = "Keep both";
  const ask = wait
    ? vscode.window.showWarningMessage(divergenceMessage(story, d), { modal: true }, link, sw, keep)
    : vscode.window.showInformationMessage(divergenceMessage(story, d), link, sw, keep);
  const act = async (choice: string | undefined) => {
    if (choice === link) await linkAll(h, story, d, repos);
    else if (choice === sw) await switchAll(h, d, repos);
  };
  if (wait) await act(await ask);
  else void ask.then(act, (e: Error) => h.log(`story ${story}: ${e.message}`));
}

async function linkAll(h: StoryHooks, story: number, d: Divergence[], repos: { name: string; path: string }[]): Promise<void> {
  for (const x of d) {
    const path = repos.find((r) => r.name === x.repo)?.path;
    if (path) await cli(["story", "branches", "link", "--id", String(story), "--branch", x.current, "--repo", x.repo], path);
    linkedMemo.set(`${story}|${x.repo}|${x.current}`, true);
  }
  h.changed();
}

async function switchAll(h: StoryHooks, d: Divergence[], repos: { name: string; path: string }[]): Promise<void> {
  for (const x of d) {
    const path = repos.find((r) => r.name === x.repo)?.path;
    if (path) await switchIn(h, x.repo, x.linked, path);
  }
}

// ---- branches of the open set ----------------------------------------------------------------------------------

/** One repository of the set on another branch; the window stays. A branch with a worktree elsewhere asks move / reuse / recreate. */
async function switchIn(h: StoryHooks, repo: string, branch: string, path: string, from?: string): Promise<boolean> {
  const folder = openFacts(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath).set?.folder;
  return withUndo(h, `Switch ${repo} to ${branch}`, folder, () => switchInRun(h, repo, branch, path, from), { only: [repo], message: (ok) => (ok ? `${repo} is now on ${branch}` : "") });
}

async function switchInRun(h: StoryHooks, repo: string, branch: string, path: string, from?: string): Promise<boolean> {
  const args = ["branch", "switch", "--repo", repo, "--branch", branch, ...(from ? ["--from", from] : []), "--json"];
  const first = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${repo}: switching to ${branch}...` }, () => cli(args, path));
  const out = await answerExisting(first, (extra) => cli([...args, ...extra], path), { ownWindow: true });
  if (out === undefined) return false;
  let res = JSON.parse(out.slice(out.indexOf("{"))) as OpenResultJson;
  // local changes in the way: the question PyCharm asks (which files, Smart Checkout or not), never a command line
  const blocked = res.repos.find((r) => r.state === "skipped" && /uncommitted/.test(r.note));
  if (blocked) {
    const files = await dirtyFiles(gitRun, path);
    if (!(await askSmartCheckout(branch, files, fileList))) return false;
    const done = await smartCheckout(gitRun, {
      path,
      oldBranch: headBranchOf(path) ?? "",
      run: async () => {
        const again = await cli(args, path);
        res = JSON.parse(again.slice(again.indexOf("{"))) as OpenResultJson;
        return res.repos.every((r) => r.ok);
      },
    }).catch((e: Error) => ({ ok: false, problem: e.message }));
    if (!done.ok) {
      void vscode.window.showWarningMessage(`AI Context Hub: ${done.problem ?? "the switch did not happen"}.`);
      return false;
    }
  }
  // the branch is checked out in the clone itself: nothing changed; a short question, never a command line
  const clone = res.repos.find((r) => r.checkedOutIn);
  if (clone?.checkedOutIn) {
    h.log(`switch ${repo} to ${branch}: checked out in ${clone.checkedOutIn}`);
    await askCloneCheckedOut(branch, clone.checkedOutIn);
    return false;
  }
  const ok = await showOpened(res, "this", h.log);
  forgetScan(process.env);
  h.changed();
  return ok;
}

interface SetContext {
  folder: string;
  story: number;
  branch: string;
  repos: { name: string; path: string; branch: string }[];
  source: (repo: string) => string | undefined;
}

function setContext(): SetContext | undefined {
  const f = openFacts(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
  if (!f.set) return undefined;
  const file = readSetFile(f.set.folder);
  const metas = file ? [file.top, ...(file.top.others ?? [])] : [];
  const meta = metas.find((m) => m.branch === f.set!.branch) ?? metas[0];
  return { folder: f.set.folder, story: f.set.story, branch: f.set.branch, repos: f.set.repos, source: (repo) => meta?.repos.find((r) => r.name === repo)?.source };
}

const nameOf = (a: unknown): string | undefined => (typeof a === "string" ? a : a && typeof a === "object" && "repo" in a ? String((a as { repo: unknown }).repo) : undefined);

function need(a: unknown): { set: SetContext; repo: SetContext["repos"][number] } | undefined {
  const set = setContext();
  if (!set) return void vscode.window.showInformationMessage("AI Context Hub: this window does not show a worktree set.");
  const name = nameOf(a) ?? (set.repos.length === 1 ? set.repos[0].name : undefined);
  const repo = set.repos.find((r) => r.name === name);
  if (!repo) return void vscode.window.showWarningMessage(`AI Context Hub: ${name ? `${name} is not in this set` : "say which repository"}.`);
  return { set, repo };
}

const gitBranch = (dir: string, args: string[]) =>
  new Promise<void>((resolve, reject) => execFile("git", args, { cwd: dir, timeout: 30_000, windowsHide: true, env: gitEnvironment() }, (err, _o, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve())));

export function registerStoryCommands(h: StoryHooks): void {
  h.reg("aihub.bar.openStory", (arg?: unknown) => openStory(h, arg));

  h.reg("aihub.bar.switchBranch", async (arg?: { repo?: string; branch?: string }) => {
    const n = need(arg);
    if (!n || !arg?.branch) return;
    await switchIn(h, n.repo.name, arg.branch, n.repo.path);
  });

  h.reg("aihub.bar.otherBranch", async (arg?: unknown) => {
    const n = need(arg);
    if (!n) return;
    const src = n.set.source(n.repo.name) ?? n.repo.path;
    const r = await readJson<{ branches: { name: string }[] }>(runner(), ["worktree", "branches", "--repos", src], n.repo.path);
    const pick = await vscode.window.showQuickPick(
      r.branches.map((b) => b.name).filter((b) => b !== n.repo.branch).map((b) => ({ label: b })),
      { title: `${n.repo.name}: other branch`, placeHolder: `Now on ${n.repo.branch}`, matchOnDescription: true },
    );
    if (pick) await switchIn(h, n.repo.name, pick.label, n.repo.path);
  });

  h.reg("aihub.bar.linkBranch", async (arg?: unknown) => {
    const n = need(arg);
    if (!n) return;
    if (!n.set.story) return void vscode.window.showInformationMessage("AI Context Hub: this set has no story to link to.");
    const star = (storyBranchesOf(n.repo.path, n.set.story) ?? []).some((b) => b.status === "current");
    await cli(["story", "branches", "link", "--id", String(n.set.story), "--branch", n.repo.branch, "--repo", n.repo.name, ...(star ? [] : ["--current"])], n.repo.path);
    linkedMemo.set(`${n.set.story}|${n.repo.name}|${n.repo.branch}`, true);
    void vscode.window.showInformationMessage(`AI Context Hub: ${n.repo.branch} is linked to story #${n.set.story}.`);
    h.changed();
  });

  h.reg("aihub.bar.newStoryBranch", async (arg?: unknown) => {
    const n = need(arg);
    if (!n) return;
    const story = n.set.story;
    if (!story) return void vscode.window.showInformationMessage("AI Context Hub: this set has no story; use New Branch instead.");
    const title = readSeenStories(process.env)[story]?.title || titleFromFiles(story, n.set.repos.map((r) => r.path)) || "";
    const mine = storyBranchesOf(n.repo.path, story) ?? [];
    const name = await vscode.window.showInputBox({ title: `Create New Branch in ${n.repo.name}`, prompt: "New branch name", value: nextStoryBranch({ id: story, title }, mine.map((b) => b.name)), validateInput: (v) => (/^[^\s~^:?*[\\]+$/.test(v.trim()) && v.trim() ? undefined : "Not a valid branch name") });
    if (!name) return;
    type Opt = vscode.QuickPickItem & { key: "checkout" | "link" | "old" };
    const prev = mine.find((b) => b.name === n.repo.branch && b.status !== "old");
    const opts: Opt[] = [
      { label: "Checkout branch", key: "checkout", picked: true },
      { label: `Link to story #${story}`, key: "link", picked: true },
      ...(prev ? [{ label: `Mark ${prev.name} as old`, key: "old" as const, picked: true }] : []),
    ];
    const chosen = await vscode.window.showQuickPick(opts, { title: `New branch ${name.trim()}`, canPickMany: true, placeHolder: "Tick what should happen; Enter creates the branch" });
    if (!chosen) return;
    const keys = new Set(chosen.map((c) => c.key));
    // from the target branch, or from the one that is checked out: asked only when they differ in meaning (a branch of the story)
    const from = await vscode.window.showQuickPick(
      [
        { label: "From the target branch", description: "where pull requests go", from: undefined as string | undefined },
        { label: `From ${n.repo.branch}`, description: "the branch checked out now", from: n.repo.branch },
      ],
      { title: `New branch ${name.trim()}`, placeHolder: "Where does it start?" },
    );
    if (!from) return;
    const branch = name.trim();
    if (keys.has("checkout")) {
      if (!(await switchIn(h, n.repo.name, branch, n.repo.path, from.from))) return;
    } else {
      await gitBranch(n.repo.path, ["branch", branch, from.from ?? `origin/${await defaultTarget(n.set.source(n.repo.name) ?? n.repo.path)}`]);
    }
    // each step on its own: when Azure DevOps cannot be reached the local steps still happen, and one line says what did not
    const problems: string[] = [];
    const step = async (what: string, run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (e) {
        problems.push(`${what}: ${(e as Error).message.slice(0, 120)}`);
      }
    };
    if (keys.has("link")) {
      await step("link in Azure DevOps", async () => {
        await cli(["story", "branches", "link", "--id", String(story), "--branch", branch, "--repo", n.repo.name, ...(keys.has("checkout") ? ["--current"] : [])], n.repo.path);
        linkedMemo.set(`${story}|${n.repo.name}|${branch}`, true);
      });
      // the star follows the new branch locally, linked or not
      if (keys.has("checkout")) await step("star", () => cli(["story", "branches", "mark", "--branch", branch, "--status", "current", "--id", String(story), "--repo", n.repo.name], n.repo.path));
    }
    if (keys.has("old") && prev) await step("mark old", () => cli(["story", "branches", "mark", "--branch", prev.name, "--status", "old", "--id", String(story), "--repo", n.repo.name], n.repo.path));
    if (problems.length) void vscode.window.showWarningMessage(`AI Context Hub: ${branch} was created. Not done: ${problems.join("; ")}`);
    forgetScan(process.env);
    h.changed();
  });

  // One repository of the set in a window of its own, as a separate copy: the set (set file, workspace file, branch of the
  // repository in the set, this window) is never changed. Nothing is changed before the user has chosen.
  h.reg("aihub.bar.openInOwnWindow", async (arg?: { repo?: string; path?: string; branch?: string }) => {
    const set = setContext();
    const repo = set?.repos.find((r) => r.name === arg?.repo) ?? set?.repos.find((r) => arg?.path && pathKey(r.path) === pathKey(arg.path));
    const facts = openFacts(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
    const one = repo ?? (!set && facts.repo ? facts.repo : undefined);
    if (!one) return void vscode.window.showWarningMessage(`AI Context Hub: ${arg?.repo ?? "that repository"} is not in this window.`);
    const source = set?.source(one.name) ?? one.path;
    const worktreeRoot = String(vscode.workspace.getConfiguration("worktreeMaker").get("worktreeRoot", "") ?? "");
    const story = set?.story ?? 0;
    let branch = arg?.branch;
    let newBranch: string | undefined;
    if (!branch) {
      const [known, wts, dirty] = await Promise.all([branchesOf(gitRun, existsSync(source) ? source : one.path), worktreesOf(gitRun, existsSync(source) ? source : one.path), h.engine.changedFiles(one.path)]);
      const mine = story ? (storyBranchesOf(one.path, story) ?? []).map((b) => b.name) : [];
      const items = ownWindowItems({ current: one.branch, storyBranches: mine, branches: known.all, worktrees: wts, uncommitted: dirty });
      type Row = vscode.QuickPickItem & { model?: (typeof items)[number] };
      const rows: Row[] = items.map((m) => (m.separator ? { label: m.separator, kind: vscode.QuickPickItemKind.Separator } : { label: m.label, description: m.description, model: m }));
      const picked = await vscode.window.showQuickPick(rows, { title: `Open ${one.name} in Own Window`, placeHolder: `Now on ${one.branch}`, matchOnDescription: true });
      if (!picked?.model) return;
      if (picked.model.kind === "branch") branch = picked.model.branch;
      else if (picked.model.kind === "new") {
        const title = story ? readSeenStories(process.env)[story]?.title || titleFromFiles(story, set!.repos.map((r) => r.path)) || "" : "";
        const next = story && title ? nextStoryBranch({ id: story, title }, mine) : undefined;
        const name = await vscode.window.showInputBox({
          title: `New branch from ${one.branch} in its own window`,
          prompt: "A separate copy to play with: not linked to the story, not pushed",
          value: copyName(one.branch, next, known.local),
          validateInput: (v) => (/^[^\s~^:?*[\\]+$/.test(v.trim()) && v.trim() ? (known.local.has(v.trim()) ? "That branch exists already" : undefined) : "Not a valid branch name"),
        });
        if (!name) return;
        newBranch = name.trim();
      }
    }
    try {
      const res = await openOwn({ git: gitRun, source, setPath: one.path, current: one.branch, branch, newBranch, worktreeRoot });
      h.log(`open in own window: ${res.note}`);
      forgetScan(process.env);
      await openPath(res.path, "new");
    } catch (e) {
      showFailure(e, `could not open ${one.name} in its own window (nothing in the set was changed)`);
    }
  });

  h.reg("aihub.bar.newSet", (arg?: unknown) => newSet(h, arg));

  h.reg("aihub.bar.addRepository", async (arg?: unknown) => {
    const set = setContext();
    // the window of a single repository: it becomes a set with the added repositories
    if (!set) return addToSingleRepository(h);
    let name = nameOf(arg);
    if (!name) {
      const inSet = new Set(set.repos.map((r) => r.name.toLowerCase()));
      const rows = (await h.engine.repositories()).filter((r) => !inSet.has(r.name.toLowerCase())).map((r) => ({ label: r.name, description: r.branch, detail: r.path }));
      name = (await vscode.window.showQuickPick(rows, { title: `Add Repository to ${set.story ? `#${set.story}` : "the set"}`, placeHolder: `It joins on ${set.branch}`, matchOnDetail: true }))?.label;
    }
    if (!name) return;
    // the clone the list shows is the clone that is added (a folder, not a name looked up next to the set)
    const known = (await h.engine.repositories()).find((r) => r.name.toLowerCase() === name!.toLowerCase());
    const args = ["worktree", "add", "--repos", known?.path ?? name, "--json"];
    await withUndo(
      h,
      `Add ${name} to the set`,
      set.folder,
      async () => {
        const first = await cli(args, set.repos[0].path);
        const out = await answerExisting(first, (extra) => cli([...args, ...extra], set.repos[0].path));
        if (out === undefined) return false;
        const ok = await showOpened(JSON.parse(out.slice(out.indexOf("{"))) as OpenResultJson, "this", h.log);
        forgetScan(process.env);
        h.changed();
        return ok;
      },
      { message: (ok) => (ok ? `${name} is now in the set` : "") },
    );
  });

  h.reg("aihub.bar.removeRepository", async (arg?: unknown) => {
    const n = need(arg);
    if (!n) return;
    const go = await vscode.window.showWarningMessage(`Remove ${n.repo.name} from the set?`, { modal: true, detail: "Its worktree is removed only when nothing is lost: uncommitted work and commits that are on no remote keep it. The branch stays." }, "Remove from Set");
    if (go !== "Remove from Set") return;
    await withUndo(
      h,
      `Take ${n.repo.name} out of the set`,
      n.set.folder,
      async () => {
        const out = await cli(["worktree", "drop", "--repos", n.repo.name, "--json"], n.set.repos.find((r) => r.name !== n.repo.name)?.path ?? n.repo.path);
        const res = JSON.parse(out.slice(out.indexOf("{"))) as OpenResultJson;
        const ok = await showOpened(res, "this", h.log);
        forgetScan(process.env);
        h.changed();
        // "nothing was changed" (the worktree holds work and stays) is said as it is, never as "taken out"
        return ok ? (/^nothing was changed/.test(res.stays ?? "") ? `${n.repo.name} stays in the set: ${res.stays}` : `${n.repo.name} is out of the set`) : "";
      },
      { backup: true, only: [n.repo.name], message: (m) => m },
    );
  });
}

/**
 * Add Repository… in the window of a single repository: pick repositories (several), a branch for each, then one question
 * "Link to a story?". The window becomes a set: this repository stays on its branch in its folder, the added ones get a
 * worktree each, the set opens in this window, with Undo. Everything through `aihub worktree open`.
 */
async function addToSingleRepository(h: StoryHooks): Promise<void> {
  const here = openFacts(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath).repo;
  if (!here) return void vscode.window.showInformationMessage("AI Context Hub: open a repository first.");
  const current: RepoPick = { name: here.name, path: here.path, branch: here.branch };
  if (!current.branch) return void vscode.window.showWarningMessage(`AI Context Hub: ${current.name} is not on a branch (detached HEAD); check out a branch first.`);
  const candidates = addable(await h.engine.repositories(), current);
  if (!candidates.length) return void vscode.window.showInformationMessage("AI Context Hub: no other repository is known on this PC. Add a folder with Folders to Look In..., or clone one from the search of the project menu.");
  type Row = vscode.QuickPickItem & { repo: RepoPick };
  const chosen = await vscode.window.showQuickPick<Row>(
    candidates.map((r) => ({ label: r.name, description: r.branch, detail: r.path, repo: { name: r.name, path: r.path, branch: r.branch } })),
    { title: `Add Repository to ${current.name}`, placeHolder: "Tick the repositories; this window becomes a set with them", canPickMany: true, matchOnDetail: true },
  );
  if (!chosen) return;
  if (!chosen.length) return void vscode.window.showInformationMessage("AI Context Hub: no repository was ticked, so nothing was added.");
  const added: { name: string; path: string; branch: string }[] = [];
  for (const c of chosen) {
    const target = targetInfo(c.repo.path, c.repo.name).target;
    type B = vscode.QuickPickItem & { choice: ReturnType<typeof branchChoices>[number] };
    const pick = await vscode.window.showQuickPick<B>(
      branchChoices(current.branch, c.repo, target).map((b) => ({ label: b.label, description: b.description, choice: b })),
      { title: `Branch for ${c.repo.name}`, placeHolder: `${c.repo.name} joins the set on this branch` },
    );
    if (!pick) return;
    let branch = pick.choice.branch;
    if (pick.choice.kind === "new") {
      branch = (await vscode.window.showInputBox({ title: `New branch in ${c.repo.name}`, prompt: `Made from ${target}`, value: current.branch, validateInput: (v) => (validBranchName(v) ? undefined : "Not a valid branch name") }))?.trim();
      if (!branch) return;
    }
    added.push({ name: c.repo.name, path: c.repo.path, branch: branch! });
  }
  // one question: a story for the set, or none
  const linkQ = await vscode.window.showQuickPick([{ label: "No story", description: "a set of repositories without a story", story: false }, { label: "Link to a Story…", description: "search by number or words", story: true }], { title: "Link to a story?", placeHolder: "The set can belong to a story" });
  if (!linkQ) return;
  let story: StoryRef | undefined;
  if (linkQ.story) {
    const picked = await pickStory(h.engine, current.path);
    if (!picked) return;
    story = picked.story;
    if (!story.title) story = { ...story, title: (await storyRead(story, picked, current.path).catch(() => ({ title: undefined }))).title ?? "" };
  }
  const args = singleToSetArgs(current, added, story?.id);
  h.log(`add repository: ${current.name} becomes a set with ${added.map((a) => `${a.name} (${a.branch})`).join(", ")}${story ? ` for story #${story.id}` : ""}`);
  const made = await withUndo(
    h,
    `Add ${added.map((a) => a.name).join(", ")} to ${current.name}`,
    "",
    async () => {
      const first = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Making a set of ${current.name} and ${added.length === 1 ? added[0].name : `${added.length} repositories`}...` }, () => cli(args, current.path));
      const out = await answerExisting(first, (extra) => cli([...args, ...extra], current.path));
      if (out === undefined) return undefined;
      const res = JSON.parse(out.slice(out.indexOf("{"))) as OpenResultJson;
      if (story) {
        // the branches of the set are linked to the story in Azure DevOps; a failure only goes to the log
        for (const r of res.repos.filter((x) => x.ok)) void cli(["story", "branches", "link", "--id", String(story.id), "--branch", r.branch, "--repo", r.repo], r.path ?? current.path).catch((e: Error) => h.log(`story ${story!.id}: Azure DevOps link for ${r.branch} not made: ${e.message}`));
        if (story.title && res.folder) stampStoryTitle(res.folder, story.id, story.title);
      }
      forgetScan(process.env);
      h.changed();
      return res;
    },
    { sources: [current.path, ...added.map((a) => a.path)], created: (r) => r?.folder, message: (r) => (r ? `${current.name} is now a set with ${added.map((a) => a.name).join(", ")}` : "") },
  );
  // only now this window becomes the set (the workspace file opens here, no new window): the Undo is saved before the reload and stays in the project menu
  if (made) await showOpened(made, "this", h.log, story ? { storyTitle: story.title } : undefined);
}

/** "Clone from Azure DevOps…" in New Set: the repositories of the organisation that are not on this PC; the ticked ones join the set and are cloned by aihub.bar.openReposAsSet. */
async function remoteForNewSet(h: StoryHooks): Promise<NewSetRepo[]> {
  const cwd = h.engine.scan().repos.find((r) => /dev\.azure\.com|visualstudio\.com/i.test(r.remote ?? ""))?.path;
  if (!cwd) return void vscode.window.showInformationMessage("AI Context Hub: no clone of Azure DevOps on this PC yet, so its repositories are not known."), [];
  const list = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Reading the repositories of Azure DevOps..." }, () => cli(["repos", "ado", "--json"], cwd)).then(
    (out) => (JSON.parse(out.slice(out.indexOf("{"))) as { repos?: { name: string; project: string; remoteUrl: string }[] }).repos ?? [],
    (e: Error) => (showFailure(e, "the repositories of Azure DevOps could not be read"), [] as { name: string; project: string; remoteUrl: string }[]),
  );
  const rows = notOnThisPc(list, await h.engine.repositories()).map((r) => ({ label: r.name, description: r.project, r }));
  if (!rows.length) return [];
  const picked = await vscode.window.showQuickPick(rows, { title: "Clone from Azure DevOps", placeHolder: "Tick the repositories; they are cloned when the set is made", canPickMany: true, matchOnDescription: true });
  return (picked ?? []).map((p) => ({ name: p.r.name, project: p.r.project, remoteUrl: p.r.remoteUrl }));
}

/**
 * New Set… (left menu) and Open as Set… (several repositories ticked in the left menu): the questions — the repositories, a
 * new feature branch for all of them or an existing branch per repository, "Link to a story?". The work is
 * aihub.bar.openReposAsSet: it clones what is not on this PC, opens the set of a story that has one, else makes the set and
 * opens it in a new window, with Undo.
 */
async function newSet(h: StoryHooks, arg: unknown): Promise<void> {
  const ticked = preTicked(arg);
  const key = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
  const remote: NewSetRepo[] = [];
  type Row = vscode.QuickPickItem & { repo: NewSetRepo & { branch?: string } };
  let chosen: Row[] | undefined;
  for (;;) {
    const repos = await h.engine.repositories();
    const qp = vscode.window.createQuickPick<Row>();
    qp.title = "New Set";
    qp.placeholder = "Tick the repositories of the set (type to search)";
    qp.canSelectMany = true;
    qp.matchOnDetail = true;
    qp.items = [
      ...repos.map((r) => ({ label: r.name, description: r.branch, detail: r.path, repo: { name: r.name, path: r.path, branch: r.branch } })),
      ...remote.map((r) => ({ label: r.name, description: `clone from Azure DevOps${r.project ? ` · ${r.project}` : ""}`, repo: r })),
    ];
    qp.selectedItems = qp.items.filter((i) => (i.repo.path ? ticked.has(key(i.repo.path)) : true));
    qp.buttons = [{ iconPath: new vscode.ThemeIcon("cloud-download"), tooltip: "Clone from Azure DevOps…" }];
    const answer = await new Promise<Row[] | "clone" | undefined>((resolve) => {
      qp.onDidAccept(() => resolve([...qp.selectedItems]));
      qp.onDidTriggerButton(() => resolve("clone"));
      qp.onDidHide(() => resolve(undefined));
      qp.show();
    });
    for (const s of qp.selectedItems) if (s.repo.path) ticked.add(key(s.repo.path));
    qp.dispose();
    if (answer === "clone") {
      for (const r of await remoteForNewSet(h)) if (!remote.some((x) => x.name === r.name)) remote.push(r);
      continue;
    }
    chosen = answer;
    break;
  }
  if (!chosen) return;
  if (!chosen.length) return void vscode.window.showInformationMessage("AI Context Hub: no repository was ticked, so no set was made.");
  const how = await vscode.window.showQuickPick(
    [
      { label: "New Branch for All Repositories…", description: "one new feature branch, made from each repository's target branch", all: true },
      { label: "An Existing Branch per Repository…", description: "choose for each repository", all: false },
    ],
    { title: "Branch of the set", placeHolder: `${chosen.length} ${chosen.length === 1 ? "repository" : "repositories"}` },
  );
  if (!how) return;
  let choice: { all: string } | { branches: Record<string, string> };
  if (how.all) {
    const name = (await vscode.window.showInputBox({ title: "New feature branch for all repositories", value: "feature/", valueSelection: [8, 8], validateInput: (v) => (validBranchName(v) && v.trim() !== "feature/" ? undefined : "Not a valid branch name") }))?.trim();
    if (!name) return;
    choice = { all: name };
  } else {
    const branches: Record<string, string> = {};
    for (const c of chosen) {
      let b: string | undefined;
      if (c.repo.path) {
        const known = await branchesOf(gitRun, c.repo.path).catch(() => ({ all: [] as string[], local: new Set<string>(), remote: new Set<string>() }));
        const current = c.repo.branch ?? "";
        const names = [current, ...known.all.filter((x) => x !== current)].filter(Boolean);
        b = (await vscode.window.showQuickPick(names.map((n) => ({ label: n, description: n === current ? "where its clone is now (used as it is)" : known.local.has(n) ? "local" : "on the remote" })), { title: `Branch for ${c.repo.name}`, placeHolder: "An existing branch" }))?.label;
      } else {
        // not on this PC yet: the branch is typed (it is checked out after the clone)
        b = (await vscode.window.showInputBox({ title: `Branch for ${c.repo.name}`, prompt: "An existing branch on Azure DevOps", value: "main", validateInput: (v) => (validBranchName(v) ? undefined : "Not a valid branch name") }))?.trim();
      }
      if (!b) return;
      branches[c.repo.name] = b;
    }
    choice = { branches };
  }
  const linkQ = await vscode.window.showQuickPick([{ label: "No story", description: "a set of repositories without a story", story: false }, { label: "Link to a Story…", description: "search by number or words", story: true }], { title: "Link to a story?", placeHolder: "The set can belong to a story" });
  if (!linkQ) return;
  let story: number | undefined;
  if (linkQ.story) {
    const pickedStory = await pickStory(h.engine, chosen.find((c) => c.repo.path)?.repo.path ?? cliCwd(h.engine));
    if (!pickedStory) return;
    story = pickedStory.story.id;
  }
  const arg2 = openReposArgOf(chosen.map((c) => c.repo), choice, story);
  h.log(`new set: ${arg2.repos.map((r) => r.name).join(", ")}${story ? ` for story #${story}` : ""} -> aihub.bar.openReposAsSet`);
  // one engine for every "repositories as a set": clone, one story one set, the set in a new window, Undo
  const res = (await vscode.commands.executeCommand(BAR_COMMANDS.openReposAsSet, arg2)) as { error?: { kind: string; message: string } } | undefined;
  if (res?.error && res.error.kind !== "cancelled") void vscode.window.showWarningMessage(`AI Context Hub: no set was made: ${res.error.message}`);
}

async function defaultTarget(dir: string): Promise<string> {
  try {
    const head = await readFile(join(dir, ".git", "refs", "remotes", "origin", "HEAD"), "utf8");
    return /refs\/remotes\/origin\/(.+)/.exec(head)?.[1].trim() ?? "main";
  } catch {
    return "main";
  }
}
