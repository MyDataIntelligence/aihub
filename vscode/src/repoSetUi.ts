import * as fs from "fs";
import { notice } from "./bar/notice";
import { plainPath } from "./bar/paths";
import { offerSaveGroup, pickRepos } from "./repoPickerUi";
import { plainWorkspace } from "./repoPickerModel";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { openPath } from "./bar/window";
import { makeRunner, readJson, type Runner } from "./cli";
import { findRepos, type Repo } from "./worktrees/core";
import { cloneItem, readPreferredClones, uniqueRepos } from "./worktrees/clones";
import { listGroups as listLocalGroups } from "./worktrees/extras";
import {
  branchItems,
  choiceArgs,
  needsChoiceOf,
  branchesArgs,
  groupItems,
  openArgs,
  openTarget,
  openWays,
  storyBranchSuggestion,
  preferredBranch,
  prItems,
  setFromMeta,
  stepTitle,
  summarizeOpen,
  type BranchChoice,
  type BranchesJson,
  type GroupJson,
  type OpenResultJson,
  type OpenWay,
  type PickItem,
  type PrJson,
  type SetModel,
  existingFacts,
  existingOptions,
  existingTitle,
} from "./repoSetModel";
import { showFailure } from "./bar/failureUi";

/**
 * "Open Repo Set": group or repositories -> branch -> how. It is a local action: the quick pick runs
 * `aihub worktree open ... --json` itself (it never goes to the chat). All git work is in the CLI.
 */

const cfg = () => vscode.workspace.getConfiguration("aihub");

/**
 * The set this folder belongs to, read from `.aihub-set.json` above it. Only for the status bar item when
 * `aihub status` has no answer (no Azure DevOps remote, offline): a set is local and stays visible then.
 * Asynchronous, and read once per folder (the cache lives as long as the window: a window becomes a set by reopening).
 */
const localSets = new Map<string, Promise<SetModel | null>>();
export function readLocalSet(cwd: string | undefined): Promise<SetModel | null> {
  if (!cwd) return Promise.resolve(null);
  const key = path.resolve(cwd);
  let hit = localSets.get(key);
  if (!hit) localSets.set(key, (hit = findLocalSet(key)));
  return hit;
}

const exists = (p: string) => fs.promises.access(p).then(() => true, () => false);

async function findLocalSet(start: string): Promise<SetModel | null> {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    const meta = path.join(dir, ".aihub-set.json");
    if (await exists(meta)) {
      try {
        const m = JSON.parse(await fs.promises.readFile(meta, "utf8")) as { repos?: { path: string }[] };
        const there = new Set<string>();
        for (const r of m.repos ?? []) if (await exists(r.path)) there.add(r.path);
        return setFromMeta(m, (p) => there.has(p));
      } catch {
        return null;
      }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** A runner with room for several `git fetch`es; the status reads keep their short limit. */
const slowRunner = (): Runner => makeRunner({ command: String(cfg().get("cliPath", "aihub")) || "aihub", timeoutMs: 180_000 });

type Row<T> = vscode.QuickPickItem & { value?: T };

/**
 * One step of the flow. `items` may still be loading: the pick opens at once with its title and a busy bar and is
 * filled when the list is there, so no "Reading..." toast hangs between two steps. The first row is focused.
 */
export const pick = <T>(items: PickItem<T>[] | Promise<PickItem<T>[]>, title: string, placeHolder: string): Promise<T | undefined> =>
  new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<Row<T>>();
    let done = false;
    const finish = (v: T | undefined) => {
      if (done) return;
      done = true;
      resolve(v);
      qp.hide();
      qp.dispose();
    };
    Object.assign(qp, { title, placeholder: placeHolder, matchOnDescription: true, matchOnDetail: true, ignoreFocusOut: true, busy: true });
    qp.onDidAccept(() => finish(qp.selectedItems[0]?.value ?? qp.activeItems[0]?.value));
    qp.onDidHide(() => finish(undefined));
    qp.show();
    void Promise.resolve(items).then((list) => {
      const rows = list.map((i) => (i.separator ? ({ label: i.label, kind: vscode.QuickPickItemKind.Separator } as Row<T>) : ({ label: i.label, description: i.description, detail: i.detail, value: i.value } as Row<T>)));
      qp.items = rows;
      const first = rows.find((r) => r.kind !== vscode.QuickPickItemKind.Separator);
      if (first) qp.activeItems = [first];
      qp.busy = false;
    });
  });

/** How long a read of the branches of one group or repository list is reused (a picker opened twice in a row). */
const BRANCH_CACHE_MS = 60_000;

/**
 * After `aihub worktree open|story open --window none`: report the repositories that need attention, then open the
 * workspace file in this window or a new one (vscode.openFolder; the CLI never starts VS Code itself).
 */
type OpenMeta = { storyTitle?: string };
let openRecorder: ((res: OpenResultJson, meta?: OpenMeta) => Promise<void>) | undefined;
/** Called with every set that is about to open (the recent list), awaited: "this window" reloads right after. */
export function setOpenRecorder(f: (res: OpenResultJson, meta?: OpenMeta) => Promise<void>): void {
  openRecorder = f;
}

/**
 * The CLI stopped because a branch already has a worktree elsewhere: the same three choices as a dialog (move first),
 * then the command runs again with the chosen one. Undefined when the user cancels; else the final output.
 */
export async function answerExisting(text: string, rerun: (extra: string[]) => Promise<string>, o: { ownWindow?: boolean } = {}): Promise<string | undefined> {
  for (let i = 0; i < 3; i++) {
    const q = needsChoiceOf(text);
    if (!q) return text;
    const options = existingOptions(q, !!o.ownWindow);
    const detail = [...existingFacts(q), "", ...options.map((x) => x.line)].join("\n");
    const go = await vscode.window.showWarningMessage(`AI Context Hub: ${existingTitle(q)}`, { modal: true, detail }, ...options.map((x) => x.button));
    const picked = options.find((x) => x.button === go);
    if (!picked) return undefined;
    if (picked.key === "own") {
      // nothing changes: no CLI call, the set file and this window stay; that worktree opens in a window of its own
      await openPath(q.existing[0].path, "new");
      return undefined;
    }
    text = await rerun(choiceArgs(picked.choice!));
  }
  return text;
}

/**
 * The branch is checked out in a CLONE (not a worktree): it cannot be moved into the set or made again. One short question with
 * what can be done; no command line in it. True when that folder was opened in a window of its own.
 */
export async function askCloneCheckedOut(branch: string, path: string): Promise<boolean> {
  const open = "Open That Folder in Its Own Window";
  const detail = [plainPath(path), `A clone cannot be moved into a set; switch that clone to another branch first if you want ${branch} here.`].join(String.fromCharCode(10));
  const go = await vscode.window.showWarningMessage(`AI Context Hub: ${branch} is checked out in the clone`, { modal: true, detail }, open);
  if (go !== open) return false;
  await openPath(path, "new");
  return true;
}

/** The question PyCharm asks when local changes are in the way of a checkout: which files, Smart Checkout or not. */
export async function askSmartCheckout(branch: string, files: string[], fileList: (f: string[]) => string): Promise<boolean> {
  const smart = "Smart Checkout";
  const go = await vscode.window.showWarningMessage(`AI Context Hub: your local changes would be in the way of ${branch}`, { modal: true, detail: `${fileList(files)}

Smart Checkout carries them along to ${branch}; when they do not fit there, everything goes back as it was.` }, smart, "Don't Checkout");
  return go === smart;
}

export async function showOpened(res: OpenResultJson, window: "new" | "this", log: (l: string) => void, meta?: OpenMeta): Promise<boolean> {
  const sum = summarizeOpen(res);
  const detail = sum.lines.join("\n");
  log(`${sum.title}\n${detail}`);
  const to = openTarget(res, window);
  // some repositories of the set this window shows switched in place: nothing to open, the window stays
  if ("stays" in to) {
    // inside an action with Undo the sentence only goes to the log: the action says one thing
    if (sum.ok) notice(to.stays, (t) => void vscode.window.showInformationMessage(`AI Context Hub: ${t}`));
    else void vscode.window.showWarningMessage(`AI Context Hub: ${to.stays}\n${detail}`, { modal: true });
    return sum.ok;
  }
  if ("error" in to) {
    void vscode.window.showErrorMessage(`AI Context Hub: ${to.error}\n${detail}`, { modal: true });
    return false;
  }
  // repositories that need attention are reported before the window changes (a reload would drop the message)
  if (!sum.ok) {
    const go = await vscode.window.showWarningMessage(`${sum.title}\n${detail}`, { modal: true }, "Open the others");
    if (go !== "Open the others") return false;
  }
  log(`open ${to.file} ${window === "this" ? "in this window" : "in a new window"}`);
  await openRecorder?.(res, meta).catch((e: Error) => log(`recent list not updated: ${e.message}`));
  try {
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(to.file), to.options);
  } catch (e) {
    void showFailure(e, `the set is ready, but VS Code could not open ${to.file}`);
    return false;
  }
  if (window === "new") void vscode.window.showInformationMessage(sum.title);
  return true;
}

export interface RepoSetDeps {
  cwd: () => string | undefined;
  log: (line: string) => void;
  /** after a set was opened: refresh views */
  refresh: () => void;
}

export class RepoSetController {
  private branchCache = new Map<string, { at: number; rows: Promise<BranchesJson> }>();

  constructor(
    private ctx: vscode.ExtensionContext,
    private deps: RepoSetDeps,
  ) {}

  private cwd(): string {
    return this.deps.cwd() ?? os.homedir();
  }

  /** The groups of `aihub worktree groups`; groups the older Worktree Sets view kept in the extension are moved there once. */
  async groups(): Promise<GroupJson[]> {
    const run = slowRunner();
    const cwd = this.cwd();
    let known = await readJson<GroupJson[]>(run, ["worktree", "groups", "list"], cwd).catch(() => [] as GroupJson[]);
    const names = new Set(known.map((g) => g.name.toLowerCase()));
    let moved = false;
    for (const g of listLocalGroups(this.ctx.globalState)) {
      if (names.has(g.name.toLowerCase()) || !g.repoPaths.length) continue;
      try {
        await run(["worktree", "groups", "save", g.name, "--repos", g.repoPaths.join(","), "--json"], cwd);
        moved = true;
      } catch (e) {
        this.deps.log(`group ${g.name} could not be moved to the aihub config: ${(e as Error).message}`);
      }
    }
    if (moved) known = await readJson<GroupJson[]>(run, ["worktree", "groups", "list"], cwd).catch(() => known);
    return known;
  }

  private async tickRepos(): Promise<{ repos: Repo[]; group?: string } | undefined> {
    const roots = (cfg().get<string[]>("worktrees.repoRoots", []) ?? []).filter(Boolean);
    const search = roots.length ? roots : [...new Set((vscode.workspace.workspaceFolders ?? []).map((f) => path.dirname(f.uri.fsPath)))];
    if (!search.length) return void vscode.window.showWarningMessage("Open a folder, or set aihub.worktrees.repoRoots, so repositories can be found.");
    // one line per repository, however often it is cloned
    const found = await uniqueRepos(await findRepos(search, Number(cfg().get("worktrees.scanDepth", 2))), readPreferredClones());
    if (!found.length) return void vscode.window.showWarningMessage(`No git repositories found in ${search.join(", ")}.`);
    const picks = await vscode.window.showQuickPick(
      found.map((r) => ({ ...cloneItem(r), repo: r as Repo })),
      { canPickMany: true, title: stepTitle(1, [], this.flow), placeHolder: "Tick the repositories" },
    );
    if (!picks?.length) return;
    const repos = picks.map((p) => p.repo);
    const name = await vscode.window.showInputBox({ title: "Save as a group?", prompt: "Name of the group, so next time one click opens all of them (Enter without a name skips)", ignoreFocusOut: true, validateInput: (v) => (v && !/^[\w.-]+$/.test(v) ? "Letters, digits, . - _ only" : undefined) });
    if (name === undefined) return;
    if (name.trim()) {
      await slowRunner()(["worktree", "groups", "save", name.trim(), "--repos", repos.map((r) => r.path).join(","), "--json"], this.cwd());
      return { repos, group: name.trim() };
    }
    return { repos };
  }

  /** The branches of a group or repository list: read only when that group is chosen, then kept a minute. */
  private branches(target: { group?: string; repos?: string[] }): Promise<BranchesJson> {
    const key = JSON.stringify(target);
    const hit = this.branchCache.get(key);
    if (hit && Date.now() - hit.at < BRANCH_CACHE_MS) return hit.rows;
    const rows = readJson<BranchesJson>(slowRunner(), branchesArgs(target), this.cwd());
    this.branchCache.set(key, { at: Date.now(), rows });
    rows.catch(() => this.branchCache.delete(key));
    return rows;
  }

  /** "Open as they are": the folders in one window, on the branches they are on (no worktree, no switch). */
  private async openPlain(paths: string[], label: string): Promise<void> {
    const where = await pick<"new" | "this">(
      [
        { label: "$(multiple-windows) New window", value: "new" },
        { label: "$(window) This window", value: "this" },
      ],
      stepTitle(3, [label, "as they are"], this.flow),
      "Where?",
    );
    if (!where) return;
    const dir = vscode.Uri.joinPath(this.ctx.globalStorageUri, "workspaces").fsPath;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${label.replace(/[^\w.-]+/g, "-").slice(0, 60) || "repos"}.code-workspace`);
    fs.writeFileSync(file, plainWorkspace(paths, label), "utf8");
    const res: OpenResultJson = { branch: "", mode: "switch", folder: dir, workspace: file, opened: false, repos: paths.map((p) => ({ repo: path.basename(p), ok: true, state: "already-on", branch: "", note: "as it is", path: p })), group: label };
    await showOpened(res, where, this.deps.log);
  }

  private async chooseBranch(target: { group?: string; repos?: string[] }, total: number, chosen: string[], plain = false): Promise<{ branch: string; from?: string } | { plain: true } | undefined> {
    const here = path.basename(this.cwd());
    const items = this.branches(target).then(
      (rows) => withPlain(branchItems(rows.branches, rows.repos.length || total, preferredBranch(rows.branches, rows.current, here)), plain),
      (e: Error) => {
        void showFailure(e, "could not read the branches", "warning");
        return withPlain(branchItems([], total), plain);
      },
    );
    const choice = await pick<BranchChoice>(items, stepTitle(2, chosen, this.flow), "Choose the branch (Enter takes the first one)");
    if (!choice) return;
    if (choice.kind === "plain") return { plain: true };
    if (choice.kind === "existing") return { branch: choice.branch };
    if (choice.kind === "new-story" || choice.kind === "typed") {
      const branch = await vscode.window.showInputBox({
        title: choice.kind === "new-story" ? "New branch for a story" : "Branch name",
        prompt: choice.kind === "new-story" ? "Branch name, for example feature/1234-search" : "Branch name (a missing branch is created from each repository's target branch)",
        value: choice.kind === "new-story" ? "feature/" : "",
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim().length < 3 || /\s/.test(v) ? "Enter a branch name without spaces" : undefined),
      });
      return branch ? { branch: branch.trim() } : undefined;
    }
    const prs = readJson<PrJson[]>(slowRunner(), ["pr", "list", "--mine"], this.cwd()).catch((e: Error) => {
      void showFailure(e, "could not read your pull requests", "warning");
      return [] as PrJson[];
    });
    const p = await pick(
      prs.then((list) => (list.length ? prItems(list) : [{ label: "No active pull requests of yours", value: undefined }])),
      "Branch of a pull request",
      "Choose the pull request",
    );
    return p ? { branch: p.source, from: p.target } : undefined;
  }

  private async linkToStory(id: number, res: OpenResultJson): Promise<void> {
    const ok = res.repos.filter((r) => r.ok);
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Linking the branches to story ${id}...` }, () =>
      Promise.all(ok.map((r) => slowRunner()(["story", "branches", "link", "--id", String(id), "--branch", r.branch, "--repo", r.repo, "--json"], this.cwd()).catch((e: Error) => this.deps.log(`story ${id}: ${r.repo} not linked in Azure DevOps: ${e.message}`)))),
    );
  }

  private async newBranchName(label: string, story?: { id: number; title?: string }): Promise<{ branch: string; from?: string } | undefined> {
    const branch = await vscode.window.showInputBox({
      title: stepTitle(2, [label], this.flow),
      prompt: "Name of the new branch, for example feature/1234-search (created in every repository from its target branch)",
      value: storyBranchSuggestion(story),
      // the cursor after the suggestion: typing adds to feature/<id>- instead of replacing it
      valueSelection: [storyBranchSuggestion(story).length, storyBranchSuggestion(story).length],
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim().length < 3 || /\s/.test(v) ? "Enter a branch name without spaces" : undefined),
    });
    return branch ? { branch: branch.trim() } : undefined;
  }

  /**
   * The whole flow: 1 group or repositories, 2 branch, 3 how and where. `group` skips step 1 (the Worktree Sets
   * view's "Open on branch..." button); `branch` (a story or a set that already knows its branch) skips step 2.
   */
  /** the name in the step titles: "Open Repo Set" or "New Worktree Set" */
  private flow = "Open Repo Set";

  async open(group?: string, branch?: string, o: { newBranch?: boolean; story?: { id: number; title: string } } = {}): Promise<void> {
    this.flow = o.newBranch ? (o.story ? `New Worktree Set · #${o.story.id}` : "New Worktree Set") : "Open Repo Set";
    let target: { group?: string; repos?: string[] };
    let total = 0;
    let label: string;
    let plainPaths: string[] | undefined;
    if (group) {
      target = { group };
      label = group;
      if (!branch) total = (await this.groups()).find((g) => g.name === group)?.repos.length ?? 0;
    } else {
      // the repo opener: any repositories, local or in Azure DevOps (cloned first), groups and recent ones on top
      const picked = await pickRepos({ run: slowRunner(), cwd: this.cwd(), state: this.ctx.globalState, groups: () => this.groups(), title: stepTitle(1, [], this.flow), log: this.deps.log });
      if (!picked) return;
      const saved = await offerSaveGroup(slowRunner(), this.cwd(), picked);
      if (saved === undefined) return;
      target = saved ? { group: saved } : { repos: picked.paths };
      label = saved || picked.label;
      total = picked.paths.length;
      plainPaths = picked.paths;
    }
    // "New Worktree Set...": step 2 is the name of the new branch, step 3 only the worktree ways
    const b = branch ? { branch } : o.newBranch ? await this.newBranchName(label, o.story) : await this.chooseBranch(target, total, [label], !!plainPaths);
    if (!b) return;
    if ("plain" in b) return this.openPlain(plainPaths!, label);
    const way = await pick<OpenWay>(o.newBranch ? openWays().filter((w) => w.value?.mode === "worktree") : openWays(), stepTitle(3, [label, b.branch], this.flow), `How should ${b.branch} be opened?`);
    if (!way) return;
    const args = openArgs({ ...target, branch: b.branch, from: b.from, mode: way.mode, story: o.story?.id });
    this.deps.log(`aihub ${args.join(" ")}`);
    let out: string;
    try {
      out = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Opening ${b.branch} (${way.mode === "worktree" ? "worktrees" : "switching the checkouts"})...` }, () => slowRunner()([...args, "--json"], this.cwd()));
    } catch (e) {
      return void showFailure(e);
    }
    // a branch with a worktree elsewhere: ask move / reuse / recreate, then run again with the answer
    const answered = await answerExisting(out, (extra) => slowRunner()([...args, ...extra, "--json"], this.cwd()));
    if (answered === undefined) return;
    const text = answered.trim();
    let res: OpenResultJson;
    try {
      res = JSON.parse(text.slice(Math.max(0, text.search(/[{]/)))) as OpenResultJson;
    } catch {
      return void vscode.window.showErrorMessage("AI Context Hub: aihub worktree open did not print JSON. Update the CLI: npm i -g @ferronhooi/aihub");
    }
    this.branchCache.clear();
    // a set for a story: its branches get the Development link in Azure DevOps (the CLI linked them locally already)
    if (o.story) await this.linkToStory(o.story.id, res);
    await showOpened(res, way.window, this.deps.log, { storyTitle: o.story?.title });
    this.deps.refresh();
  }

  register(): void {
    this.ctx.subscriptions.push(
      vscode.commands.registerCommand("aihub.reposet.open", (branch?: unknown) => this.open(undefined, typeof branch === "string" ? branch : undefined).catch((e) => showFailure(e))),
      vscode.commands.registerCommand("aihub.reposet.openGroup", (n?: { group?: GroupJson }) => this.open(n?.group?.name).catch((e) => showFailure(e))),
    );
  }
}

/** Step 2 of a free pick of repositories also offers to open them as they are. */
function withPlain(items: PickItem<BranchChoice>[], plain: boolean): PickItem<BranchChoice>[] {
  // last, so the current branch stays the first row (one Enter)
  return plain ? [...items, { label: "", separator: true }, { label: "$(folder-opened) Open as they are", description: "the branches they are on now: no worktree, no switch", value: { kind: "plain" } }] : items;
}
