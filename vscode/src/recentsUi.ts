import * as fs from "fs";
import * as vscode from "vscode";
import {
  addSet,
  addStory,
  idArg,
  mergedMenu,
  mergedRecents,
  publicRecents,
  readRecents,
  recentItemRows,
  recentSetItems,
  recentStoryItems,
  RECENTS_KEY,
  removeSet,
  setFromOpen,
  type MenuValue,
  type Recents,
} from "./recents";
import type { OpenResultJson, PickItem } from "./repoSetModel";
import { pick, setOpenRecorder, type RepoSetController } from "./repoSetUi";
import { showFailure } from "./bar/failureUi";

/**
 * Worktree sets and stories as one thing (a story set is a worktree set with a story link), recent ones first, and
 * the public commands another extension (the PyCharm-style File menu of the PyCharm Git extension) calls:
 * aihub.newWorktreeSet, aihub.openRepoSet ("Open Worktree Set..."), aihub.getRecents({merged:true}),
 * aihub.openRecent({kind,id}); the older aihub.openStory / openRecentSet / openRecentStory / getRecents() keep working.
 * The list lives in globalState (memory): nothing is read at activation.
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

/** A story of "My Stories" (only what the pickers need). */
export interface StoryRef {
  id: number;
  title: string;
  repos?: number;
}

type Row<T> = vscode.QuickPickItem & { value?: T };

/** A pick list that shows `now` at once and appends `later` (the stories, read by the CLI) when it is there. */
export function pickGrowing<T>(title: string, placeholder: string, now: PickItem<T>[], later: Promise<PickItem<T>[]>): Promise<T | undefined> {
  const toRows = (items: PickItem<T>[]): Row<T>[] => items.map((i) => (i.separator ? ({ label: i.label, kind: vscode.QuickPickItemKind.Separator } as Row<T>) : { label: i.label, description: i.description, detail: i.detail, value: i.value }));
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<Row<T>>();
    let done = false;
    const finish = (v: T | undefined) => {
      if (done) return;
      done = true;
      resolve(v);
      qp.hide();
      qp.dispose();
    };
    Object.assign(qp, { title, placeholder, matchOnDescription: true, matchOnDetail: true, ignoreFocusOut: true, busy: true });
    qp.items = toRows(now);
    qp.onDidAccept(() => finish(qp.selectedItems[0]?.value ?? qp.activeItems[0]?.value));
    qp.onDidHide(() => finish(undefined));
    qp.show();
    void later.then(
      (more) => {
        if (done) return;
        const active = qp.activeItems;
        qp.items = [...qp.items, ...toRows(more)];
        if (active.length) qp.activeItems = active.filter((a) => qp.items.includes(a));
        qp.busy = false;
      },
      () => (qp.busy = false),
    );
  });
}

type Choice = MenuValue | { story: StoryRef } | { none: true } | { byNumber: true };

const storyRows = (stories: StoryRef[], skip: Set<number>): PickItem<Choice>[] => {
  const rest = stories.filter((s) => !skip.has(s.id));
  return rest.length ? [{ label: "My stories", separator: true }, ...rest.map((s) => ({ label: `$(book) #${s.id} ${s.title}`, description: s.repos ? `${s.repos} repo${s.repos === 1 ? "" : "s"}` : undefined, value: { story: s } }))] : [];
};

export function registerRecents(ctx: vscode.ExtensionContext, store: RecentStore, reposet: RepoSetController, log: (l: string) => void, myStories: () => Promise<StoryRef[]> = async () => []): void {
  setOpenRecorder(async (res: OpenResultJson & { story?: number }, meta?: { storyTitle?: string }) => {
    const s = setFromOpen(res, Date.now());
    if (s) await store.update((r) => addSet(r, s));
    if (res.story) await store.update((r) => addStory(r, { id: res.story!, title: meta?.storyTitle ?? "" }, Date.now()));
  });
  const reg = (id: string, f: (...a: any[]) => unknown) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, (...a) => Promise.resolve(f(...a)).catch((e: Error) => void showFailure(e))));
  const run = (v: MenuValue | undefined) => v && vscode.commands.executeCommand(v.command, v.args);
  const openStory = (s: StoryRef) => vscode.commands.executeCommand("aihub.stories.open", { kind: "story", story: { id: s.id, title: s.title, state: "", branches: [] } });

  /** "Open Worktree Set...": stories and sets in one list, recent ones first; a story opens its ★ branches. */
  reg("aihub.openRepoSet", async () => {
    const recent = mergedRecents(store.get());
    const now: PickItem<Choice>[] = [{ label: "$(repo-forked) Repositories on a branch...", description: "a group or repositories, then a branch", value: { command: "aihub.reposet.open" } }];
    if (recent.length) now.push({ label: "Recent", separator: true }, ...recentItemRows(recent, Date.now()));
    const seen = new Set(recent.filter((r) => r.kind === "story").map((r) => Number(r.id)));
    const c = await pickGrowing<Choice>("Open Worktree Set", "A story opens its ★ branches; a set opens its folders", now, myStories().then((s) => storyRows(s, seen)));
    if (!c) return;
    if ("story" in c) return void (await openStory(c.story));
    if ("command" in c) await run(c);
  });

  /** "New Worktree Set...": first "for which story?" (none, one of mine, or a number), then the repositories and the new branch. */
  reg("aihub.newWorktreeSet", async () => {
    const now: PickItem<Choice>[] = [
      { label: "$(circle-slash) No story", description: "a plain worktree set", value: { none: true } },
      { label: "$(search) Story by number...", value: { byNumber: true } },
    ];
    const c = await pickGrowing<Choice>("New Worktree Set · for which story?", "Optional: a story links the branches, gives the ★ and its story folder", now, myStories().then((s) => storyRows(s, new Set())));
    if (!c) return;
    let story: StoryRef | undefined;
    if ("story" in c) story = c.story;
    else if ("byNumber" in c) {
      const n = await vscode.window.showInputBox({ title: "New Worktree Set · story number", prompt: "The work item number of the story", validateInput: (v) => (/^\d+$/.test(v.trim()) ? undefined : "A number") });
      if (!n) return;
      story = { id: Number(n), title: "" };
    }
    await reposet.open(undefined, undefined, { newBranch: true, story });
  });

  reg("aihub.openStory", (a?: unknown) => vscode.commands.executeCommand("aihub.stories.open", a));
  reg("aihub.getRecents", (a?: { merged?: boolean }) => (a?.merged ? mergedRecents(store.get()) : publicRecents(store.get())));
  reg("aihub.openRecent", async (a?: { kind?: string; id?: unknown }) => {
    if (a?.kind === "story") return vscode.commands.executeCommand("aihub.openRecentStory", { id: a.id });
    if (a?.kind === "set") return vscode.commands.executeCommand("aihub.openRecentSet", { id: a.id });
    void vscode.window.showWarningMessage("AI Context Hub: aihub.openRecent needs { kind: 'story' | 'set', id }.");
  });
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
    const title = store.get().stories.find((s) => s.id === id)?.title || `Story ${id}`;
    await openStory({ id, title });
  });
  reg("aihub.recent", async () => {
    const rows = recentItemRows(mergedRecents(store.get()), Date.now());
    await run(await pick(rows.length ? rows : [{ label: "Nothing opened yet", value: undefined }], "Recent", "Stories and worktree sets, newest first"));
  });
  reg("aihub.recentSets", async () => {
    const items = recentSetItems(store.get(), Date.now());
    await run(await pick(items.length ? items : [{ label: "No recent worktree sets yet", value: undefined }], "Recent Worktree Sets", "Opens in a new window (an empty window is reused)"));
  });
  reg("aihub.recentStories", async () => {
    const items = recentStoryItems(store.get(), Date.now());
    await run(await pick(items.length ? items : [{ label: "No recent stories yet", value: undefined }], "Recent Stories", "Opens the ★ branches of the story"));
  });
  reg("aihub.reposet.menu", async () => run(await pick(mergedMenu(store.get(), Date.now()), "Worktree Sets", "New, open, or a recent story or set")));
}

/** Called by "Open Story..." before the window changes. */
export const rememberStory = (store: RecentStore, s: { id: number; title: string }) => store.update((r) => addStory(r, s, Date.now()));
