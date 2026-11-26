import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { forgetScan, headBranchOf, setById } from "../../../cli/src/lib/machineScan";
import { forgetUse, pathKey } from "../../../cli/src/lib/recentUse";
import { AIHUB_SET, MAKER_SET, readJsonText, readSetFile, setRepoBranchInPlace, type SetMeta } from "../../../cli/src/lib/setFile";
import { refSha } from "./behind";
import { targetOf } from "./repoStatus";
import { localBranches } from "./undo";
import type { OpenResultJson } from "../repoSetModel";
import { answerExisting, showOpened } from "../repoSetUi";
import { openFacts } from "./engine";
import { cli, jsonOf } from "./runner";
import { syncRepoName } from "../../../cli/src/lib/workspaceNames";
import { checkMeta, parseSetFile, planSetFile, snapshotOf, summarizePlan } from "./setFilePlan";
import type { StoryHooks } from "./storyUi";
import { withUndo } from "./undoUi";

/**
 * Remove a set, and the set file of this window changed by hand. Both do what the CLI does (`worktree remove --folder`,
 * `branch switch`, `worktree repair`), so the checks are the CLI's: work in a worktree is never thrown away.
 */
/** The one sentence after Remove Set: what is kept, else the last line the CLI said that has words in it, else a plain sentence (never empty). */
export function removedText(r: { lines?: string[]; kept?: string[] }): string {
  if (r.kept?.length) return `the set stays, ${r.kept.join(", ")} hold work`;
  return [...(r.lines ?? [])].reverse().map((l) => l.trim()).find(Boolean) ?? "the set is removed";
}

/** Does git have this branch, here or as the remote's branch? Read from the refs, no process. */
export function branchExists(repoPath: string, branch: string): boolean {
  return localBranches(repoPath).has(branch) || !!refSha(repoPath, `refs/remotes/origin/${branch}`);
}

export function registerSetOps(h: StoryHooks): void {
  h.reg("aihub.bar.removeSet", (arg?: unknown) => removeSet(h, arg));
}

const idOf = (a: unknown): string | undefined => (typeof a === "string" ? a : a && typeof a === "object" && "id" in a ? String((a as { id: unknown }).id) : undefined);

async function removeSet(h: StoryHooks, arg: unknown): Promise<void> {
  const id = idOf(arg);
  const set = id ? setById(h.engine.scan({ refresh: true }), id) : undefined;
  if (!set) return void vscode.window.showWarningMessage("AI Context Hub: that set is not on this PC (any more); look again.");
  const here = openFacts(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath).set;
  if (here && pathKey(here.folder) === pathKey(set.folder) && here.branch === set.branch) {
    return void vscode.window.showInformationMessage("AI Context Hub: this window shows that set. Open something else first, then remove it.");
  }
  const existing = set.repos.filter((r) => r.exists);
  // work in a worktree is named before anything is asked: it stays where it is
  const work = await Promise.all(existing.map(async (r) => [r.name, await h.engine.changedFiles(r.path)] as const));
  const dirty = work.filter(([, n]) => (n ?? 0) > 0);
  const detail = [
    `${existing.length} ${existing.length === 1 ? "worktree" : "worktrees"} in ${set.folder}: ${existing.map((r) => r.name).join(", ")}.`,
    "The branches stay; nothing on a remote is touched.",
    dirty.length ? `Kept, because they hold work: ${dirty.map(([n, c]) => `${n} (${c} changed ${c === 1 ? "file" : "files"})`).join(", ")}.` : "A worktree with uncommitted work or commits that are on no remote is kept and named.",
  ].join("\n");
  const label = set.story ? `story #${set.story}` : set.group ?? set.branch;
  const go = await vscode.window.showWarningMessage(`Remove the set of ${label}?`, { modal: true, detail }, "Remove Set");
  if (go !== "Remove Set") return;
  const file = readSetFile(set.folder);
  const meta = file && [file.top, ...(file.top.others ?? [])].find((m) => m.branch === set.branch);
  // run in a source clone: never in a worktree that is about to go (Windows cannot remove a folder a process runs in)
  const cwd = meta?.repos.map((r) => r.source).find((s) => existsSync(s)) ?? set.folder;
  const out = await withUndo(h, `Remove the set of ${label}`, set.folder, async () => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Removing the set of ${label}...` }, () => cli(["worktree", "remove", "--folder", set.folder, "--branch", set.branch, ...(set.story ? ["--story", String(set.story)] : []), "--json"], cwd)), { backup: true, message: (o) => (o ? removedText(jsonOf<{ lines: string[]; kept: string[] }>(o)) : ""), warn: (o) => !!o && jsonOf<{ kept: string[] }>(o).kept.length > 0 });
  const res = jsonOf<{ lines: string[]; kept: string[] }>(out);
  h.log(`remove set ${set.id}: ${res.lines.join(" | ")}`);
  forgetScan(process.env);
  forgetUse(process.env, set.id);
  h.changed();
  const text = res.lines.join("\n");
  // the one message (with Undo) came from withUndo; the lines are in the log
  h.log(text);
}

// ---- the set file of this window, changed by hand ---------------------------------------------------------------

/**
 * One narrow watcher on the set file of the set this window shows. A change is read, planned (a branch changed in the
 * file is switched, a repository without a worktree is made) and the result is one line; a file that cannot be read gives
 * one line and nothing is applied. Our own writes make no change: the plan is empty when file and folders agree.
 */
export class SetFileWatcher implements vscode.Disposable {
  private watcher?: vscode.Disposable;
  private timer?: NodeJS.Timeout;
  private busy = false;
  /** the file changed while an apply was running */
  private again = false;
  private key = "";
  private lastSaid = "";
  /** what the file said at the last read: only a change against it is an order */
  private previous?: Map<string, string>;
  /** the set file as it was at the last read: Undo puts a hand edit back too */
  private prevBytes?: Buffer;

  constructor(private h: { log: (line: string) => void; changed: () => void; afterGit?: () => void }) {}

  /** (Re)aimed at the set this window shows; nothing for a window without a set. */
  aim(): void {
    const folder = openFacts(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath).set?.folder;
    // a set file that cannot be read hides the set from findSet: keep watching the folder until the file is mended
    if (!folder && this.key && [AIHUB_SET, MAKER_SET].some((n) => existsSync(join(this.key, n)))) return;
    if ((folder ?? "") === this.key) return;
    this.key = folder ?? "";
    this.previous = undefined;
    this.prevBytes = undefined;
    if (folder) {
      const f = readSetFile(folder);
      const m = f && [f.top, ...(f.top.others ?? [])].find((x) => x.branch === openFacts(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath).set?.branch);
      if (f) this.previous = snapshotOf(m ?? f.top);
      const rawNow = [AIHUB_SET, MAKER_SET].map((n) => join(folder, n)).find((q) => existsSync(q));
      if (rawNow) this.prevBytes = readFileSync(rawNow);
    }
    this.watcher?.dispose();
    this.watcher = undefined;
    if (!folder) return;
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(folder), `{${AIHUB_SET},${MAKER_SET}}`));
    const fire = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.apply().catch((e: Error) => this.say(`Set file: ${e.message}`)), 800);
    };
    w.onDidChange(fire);
    w.onDidCreate(fire);
    this.watcher = w;
  }

  private say(line: string, warn = false): void {
    this.h.log(line);
    // the same line twice in a row is not shown twice
    if (line === this.lastSaid) return;
    this.lastSaid = line;
    void (warn ? vscode.window.showWarningMessage(`AI Context Hub: ${line}`) : vscode.window.showInformationMessage(`AI Context Hub: ${line}`));
  }

  async apply(): Promise<void> {
    // a change that arrives while an apply is running is not lost: it is read again when this one is done
    if (this.busy) {
      this.again = true;
      return;
    }
    if (!this.key) return;
    this.busy = true;
    try {
      // a file that cannot be read makes this window "no set" for findSet, so the folder is the one aimed at, not looked up again
      const raw = [AIHUB_SET, MAKER_SET].map((n) => join(this.key, n)).find((p) => existsSync(p));
      if (!raw) return;
      const startBytes = readFileSync(raw);
      const parsed = parseSetFile(readJsonText(raw));
      if (parsed.problem) {
        // the state shows the problem (the set stays as it was); a state event goes out when the file is readable again
        forgetScan(process.env);
        this.h.changed();
        return this.say(`Set file: ${parsed.problem}; nothing was applied.`, true);
      }
      const here = openFacts(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath).set;
      if (!here) return;
      // a readable file ends the "same line twice" rule: the next problem is new
      this.lastSaid = "";
      const file = readSetFile(here.folder);
      const metas: SetMeta[] = file ? [file.top, ...(file.top.others ?? [])] : [];
      const meta = metas.find((m) => m.story === here.story && (m.branch === here.branch || metas.length === 1)) ?? metas[0];
      const problem = checkMeta(meta ?? (parsed.json as Partial<SetMeta>));
      if (problem || !meta) return this.say(`Set file: ${problem ?? "the set file holds no set"}; nothing was applied.`, true);
      const actual = meta.repos.map((r) => ({ name: r.name, exists: existsSync(join(r.path, ".git")), branch: headBranchOf(r.path) }));
      // repositories that left the file but are still on disk are told about too
      const plan = planSetFile(meta, [...actual, ...here.repos.filter((r) => !meta.repos.some((m) => m.name === r.name)).map((r) => ({ name: r.name, exists: true, branch: r.branch }))], this.previous);
      if (plan.problem) return this.say(`Set file: ${plan.problem}; nothing was applied.`, true);
      const done: string[] = [];
      const putBack: string[] = [];
      const inside = here.repos[0]?.path ?? here.folder;
      // what was asked in the file can be undone: the file as it was at the last read, and the branches (one message with Undo)
      const runActions = async (): Promise<string | undefined> => {
        for (const a of plan.actions) {
          if (a.kind === "repair") {
            const args = ["worktree", "repair", "--json"];
            const first = await cli(args, inside);
            const out = await answerExisting(first, (extra) => cli([...args, ...extra], inside));
            if (out === undefined) return `Set file: repair of ${a.repos.join(", ")} was cancelled.`;
            await showOpened(jsonOf<OpenResultJson>(out), "this", this.h.log);
            done.push(`made the worktree of ${a.repos.join(", ")}`);
          } else {
            const path = meta.repos.find((r) => r.name === a.repo)?.path ?? inside;
            // a branch that git does not have (a typo): never made silently, never ignored silently; one question
            if (!branchExists(path, a.branch)) {
              const target = targetOf(path, a.repo, { setFolder: here.folder });
              const create = `Create It from ${target}`;
              const back = "Put the File Back";
              const pick = await vscode.window.showWarningMessage(`AI Context Hub: ${a.branch} does not exist in ${a.repo}`, { modal: true, detail: `Neither here nor on the remote. ${a.repo} stays on ${headBranchOf(path) ?? "its branch"} until you choose.` }, create, back);
              if (pick !== create) {
                setRepoBranchInPlace(here.folder, path, headBranchOf(path) || a.branch);
                putBack.push(a.repo);
                done.push(`${a.repo} stays on ${headBranchOf(path) ?? "its branch"} (${a.branch} does not exist)`);
                continue;
              }
            }
            const args = ["branch", "switch", "--repo", a.repo, "--branch", a.branch, "--json"];
            const first = await cli(args, path);
            const out = await answerExisting(first, (extra) => cli([...args, ...extra], path));
            if (out === undefined) return `Set file: the switch of ${a.repo} to ${a.branch} was cancelled.`;
            await showOpened(jsonOf<OpenResultJson>(out), "this", this.h.log);
            done.push(`${a.repo} switched to ${a.branch}`);
          }
        }
        return undefined;
      };
      const label = `Set file: ${plan.actions.map((x) => (x.kind === "repair" ? `made ${x.repos.join(", ")}` : `${x.repo} to ${x.branch}`)).join("; ")}`;
      const raw0 = [AIHUB_SET, MAKER_SET].map((n) => join(this.key, n)).find((q) => existsSync(q));
      const cancelled = plan.actions.length ? await withUndo(this.h, label, here.folder, runActions, { files: raw0 && this.prevBytes ? [{ path: raw0, bytes: this.prevBytes }] : undefined, message: (c) => (c ? "" : summarizePlan(done, plan.notes)) }) : undefined;
      if (cancelled) return this.say(cancelled, true);
      // HEAD moved outside aihub in a repository the file did not change: HEAD wins, the file and the folder name follow (one write each, only when they differ)
      const wsFile = vscode.workspace.workspaceFile;
      for (const name of plan.follow ?? []) {
        const p = meta.repos.find((r) => r.name === name)?.path;
        if (p) syncRepoName({ setFolder: here.folder, workspaceFile: wsFile?.scheme === "file" ? wsFile.fsPath : undefined, repoPath: p });
      }
      // what the file said when this apply read it (not what it says now: an edit made while this ran is read next time),
      // with the repositories that follow their HEAD at the value they now have
      const next = snapshotOf(meta);
      for (const name of plan.follow ?? []) {
        const p = meta.repos.find((r) => r.name === name)?.path;
        if (p) next.set(name, headBranchOf(p) || next.get(name) || "");
      }
      // a line put back after the question is what the file says now: the same typo typed again is a new order
      for (const name of putBack) {
        const p = meta.repos.find((r) => r.name === name)?.path;
        if (p) next.set(name, headBranchOf(p) || next.get(name) || "");
      }
      this.previous = next;
      this.prevBytes = startBytes ?? this.prevBytes;
      forgetScan(process.env);
      this.h.changed();
      // a file that already matches the folders (our own write) is silent
      // (when actions ran, withUndo said it already, once)
      if (!plan.actions.length && (done.length || plan.notes.length)) this.say(summarizePlan(done, plan.notes));
    } finally {
      this.busy = false;
      if (this.again) {
        this.again = false;
        void this.apply().catch((e: Error) => this.say(`Set file: ${e.message}`));
      }
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.watcher?.dispose();
  }
}
