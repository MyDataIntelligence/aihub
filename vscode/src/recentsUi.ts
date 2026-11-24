import * as fs from "fs";
import * as vscode from "vscode";
import { addSet, addStory, idArg, openMenu, publicRecents, readRecents, recentSetItems, recentStoryItems, RECENTS_KEY, removeSet, setFromOpen, type MenuValue, type Recents } from "./recents";
import type { OpenResultJson } from "./repoSetModel";
import { pick, setOpenRecorder, type RepoSetController } from "./repoSetUi";

/**
 * Recent worktree sets and stories, and the public commands another extension (the PyCharm-style File menu of the
 * PyCharm Git extension) calls: aihub.newWorktreeSet, aihub.openRepoSet, aihub.openStory, aihub.openRecentSet {id},
 * aihub.openRecentStory {id}, aihub.getRecents. The list lives in globalState (memory): nothing is read at activation.
 */
export class RecentStore {
  constructor(private state: vscode.Memento) {}

  get(): Recents {
    return readRecents(this.state.get(RECENTS_KEY));
  }

  /** Awaited before a window reloads ("this window"), so the entry is stored first. */
  async update(change: (r: Recents) => Recents): Promise<void> {
    await this.state.update(RECENTS_KEY, change(this.get()));
  }
}

export function registerRecents(ctx: vscode.ExtensionContext, store: RecentStore, reposet: RepoSetController, log: (l: string) => void): void {
  setOpenRecorder(async (res: OpenResultJson & { story?: number }) => {
    const s = setFromOpen(res, Date.now());
    if (s) await store.update((r) => addSet(r, s));
  });
  const reg = (id: string, f: (...a: any[]) => unknown) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, (...a) => Promise.resolve(f(...a)).catch((e: Error) => void vscode.window.showErrorMessage(`AI Context Hub: ${e.message}`))));
  const run = (v: MenuValue | undefined) => v && vscode.commands.executeCommand(v.command, v.args);

  reg("aihub.openRepoSet", () => reposet.open());
  reg("aihub.newWorktreeSet", () => reposet.open(undefined, undefined, { newBranch: true }));
  reg("aihub.openStory", (a?: unknown) => vscode.commands.executeCommand("aihub.stories.open", a));
  reg("aihub.getRecents", () => publicRecents(store.get()));
  reg("aihub.openRecentSet", async (a?: unknown) => {
    const id = idArg<string>(a);
    const set = store.get().sets.find((s) => s.id === id);
    if (!id || !set) return void vscode.window.showWarningMessage("AI Context Hub: that worktree set is not in the recent list.");
    if (!fs.existsSync(set.id)) {
      await store.update((r) => removeSet(r, set.id));
      return void vscode.window.showWarningMessage(`AI Context Hub: ${set.label} on ${set.branch} is gone (its workspace file ${set.id} no longer exists); it was taken off the list.`);
    }
    await store.update((r) => addSet(r, { ...set, lastOpened: new Date().toISOString() }));
    // an empty window is reused, like PyCharm opening a recent project from the welcome screen
    const empty = !vscode.workspace.workspaceFolders?.length;
    log(`open recent set ${set.id}`);
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(set.id), empty ? { forceReuseWindow: true } : { forceNewWindow: true });
  });
  reg("aihub.openRecentStory", async (a?: unknown) => {
    const id = Number(idArg<number>(a));
    if (!id) return;
    const title = store.get().stories.find((s) => s.id === id)?.title ?? `Story ${id}`;
    await vscode.commands.executeCommand("aihub.stories.open", { kind: "story", story: { id, title, state: "", branches: [] } });
  });
  reg("aihub.recentSets", async () => {
    const items = recentSetItems(store.get(), Date.now());
    await run(await pick(items.length ? items : [{ label: "No recent worktree sets yet", value: undefined }], "Recent Worktree Sets", "Opens in a new window (an empty window is reused)"));
  });
  reg("aihub.recentStories", async () => {
    const items = recentStoryItems(store.get(), Date.now());
    await run(await pick(items.length ? items : [{ label: "No recent stories yet", value: undefined }], "Recent Stories", "Opens the ★ branches of the story"));
  });
  reg("aihub.reposet.menu", async () => run(await pick(openMenu(store.get(), Date.now()), "Open Repo Set", "Open, create, or pick a recent set or story")));
}

/** Called by "Open Story..." before the window changes. */
export const rememberStory = (store: RecentStore, s: { id: number; title: string }) => store.update((r) => addStory(r, s, Date.now()));
