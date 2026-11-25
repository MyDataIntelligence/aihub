import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";
import { forgetScan, setOfStory } from "../../../cli/src/lib/machineScan";
import { pathKey, readRecentUse } from "../../../cli/src/lib/recentUse";
import { divergenceKey, divergenceMessage, divergences, markDivergenceSeen, seenDivergence, type Divergence } from "../../../cli/src/lib/setDivergence";
import { readSetFile, stampStoryTitle } from "../../../cli/src/lib/setFile";
import { readSeenStories } from "../../../cli/src/lib/storyCache";
import { readJson } from "../cli";
import { cli, runner } from "./runner";
import type { OpenResultJson } from "../repoSetModel";
import { answerExisting, showOpened } from "../repoSetUi";
import type { StoryJson } from "../storyModel";
import { BarEngine, openFacts, storyBranchesOf, titleFromFiles } from "./engine";
import { nextStoryBranch, openStoryArgs, rowDescription, storyNumberOf, storyPickRows, storyRepoRows, type StoryRef, type StoryRepoRow } from "./storyModel";
import { windowChoice, openPath } from "./window";
import { withUndo } from "./undoUi";
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

async function storyRows(story: StoryRef, picked: Picked, cwd: string): Promise<StoryJson["branches"]> {
  if (picked.rows) return picked.rows;
  const r = await readJson<{ stories: StoryJson[] }>(runner(), ["story", "branches", "--id", String(story.id)], cwd);
  return r.stories[0]?.branches ?? [];
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
  const story = picked.story;
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
  const rows = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Reading story ${story.id}...` }, () => storyRows(story, picked, cwd));
  const { rows: repoRows, notOnThisPc } = storyRepoRows(rows, repositories);
  if (!repoRows.length) return void vscode.window.showWarningMessage("AI Context Hub: there are no repositories on this PC. Add a folder with Folders to Look In...");
  const ticked = await pickRepos(story, repoRows, notOnThisPc);
  if (!ticked) return;
  const args = [...openStoryArgs(story, ticked), "--json"];
  const first = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Opening story ${story.id}...` }, () => cli(args, ticked[0].path));
  const out = await answerExisting(first, (extra) => cli([...args, ...extra], ticked[0].path), { ownWindow: true });
  if (out === undefined) return;
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
  return withUndo(h, `Switch ${repo} to ${branch}`, folder, () => switchInRun(h, repo, branch, path, from));
}

async function switchInRun(h: StoryHooks, repo: string, branch: string, path: string, from?: string): Promise<boolean> {
  const args = ["branch", "switch", "--repo", repo, "--branch", branch, ...(from ? ["--from", from] : []), "--json"];
  const first = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${repo}: switching to ${branch}...` }, () => cli(args, path));
  const out = await answerExisting(first, (extra) => cli([...args, ...extra], path), { ownWindow: true });
  if (out === undefined) return false;
  const res = JSON.parse(out.slice(out.indexOf("{"))) as OpenResultJson;
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
  new Promise<void>((resolve, reject) => execFile("git", args, { cwd: dir, timeout: 30_000, windowsHide: true }, (err, _o, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve())));

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
      void vscode.window.showErrorMessage(`AI Context Hub: could not open ${one.name} in its own window: ${(e as Error).message}. Nothing in the set was changed.`);
    }
  });

  h.reg("aihub.bar.addRepository", async (arg?: unknown) => {
    const set = setContext();
    if (!set) return void vscode.window.showInformationMessage("AI Context Hub: this window does not show a worktree set.");
    let name = nameOf(arg);
    if (!name) {
      const inSet = new Set(set.repos.map((r) => r.name.toLowerCase()));
      const rows = (await h.engine.repositories()).filter((r) => !inSet.has(r.name.toLowerCase())).map((r) => ({ label: r.name, description: r.branch, detail: r.path }));
      name = (await vscode.window.showQuickPick(rows, { title: `Add Repository to ${set.story ? `#${set.story}` : "the set"}`, placeHolder: `It joins on ${set.branch}`, matchOnDetail: true }))?.label;
    }
    if (!name) return;
    const args = ["worktree", "add", "--repos", name, "--json"];
    await withUndo(h, `Add ${name} to the set`, set.folder, async () => {
      const first = await cli(args, set.repos[0].path);
      const out = await answerExisting(first, (extra) => cli([...args, ...extra], set.repos[0].path));
      if (out === undefined) return;
      await showOpened(JSON.parse(out.slice(out.indexOf("{"))) as OpenResultJson, "this", h.log);
      forgetScan(process.env);
      h.changed();
    });
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
        await showOpened(res, "this", h.log);
        forgetScan(process.env);
        h.changed();
      },
      { backup: true },
    );
  });
}

async function defaultTarget(dir: string): Promise<string> {
  try {
    const head = await readFile(join(dir, ".git", "refs", "remotes", "origin", "HEAD"), "utf8");
    return /refs\/remotes\/origin\/(.+)/.exec(head)?.[1].trim() ?? "main";
  } catch {
    return "main";
  }
}
