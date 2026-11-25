import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { forgetScan, headBranchOf, setById } from "../../../cli/src/lib/machineScan";
import { forgetUse, pathKey } from "../../../cli/src/lib/recentUse";
import { AIHUB_SET, MAKER_SET, readSetFile, type SetMeta } from "../../../cli/src/lib/setFile";
import type { OpenResultJson } from "../repoSetModel";
import { answerExisting, showOpened } from "../repoSetUi";
import { openFacts } from "./engine";
import { cli, jsonOf } from "./runner";
import { checkMeta, parseSetFile, planSetFile, summarizePlan } from "./setFilePlan";
import type { StoryHooks } from "./storyUi";

/**
 * Remove a set, and the set file of this window changed by hand. Both do what the CLI does (`worktree remove --folder`,
 * `branch switch`, `worktree repair`), so the checks are the CLI's: work in a worktree is never thrown away.
 */
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
  const out = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Removing the set of ${label}...` }, () => cli(["worktree", "remove", "--folder", set.folder, "--branch", set.branch, ...(set.story ? ["--story", String(set.story)] : []), "--json"], cwd));
  const res = jsonOf<{ lines: string[]; kept: string[] }>(out);
  h.log(`remove set ${set.id}: ${res.lines.join(" | ")}`);
  forgetScan(process.env);
  forgetUse(process.env, set.id);
  h.changed();
  const text = res.lines.join("\n");
  void (res.kept.length ? vscode.window.showWarningMessage(`AI Context Hub: the set stays, ${res.kept.join(", ")} hold work.\n${text}`) : vscode.window.showInformationMessage(`AI Context Hub: ${res.lines[res.lines.length - 1] ?? "set removed"}`));
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
  private key = "";
  private lastSaid = "";

  constructor(private h: { log: (line: string) => void; changed: () => void }) {}

  /** (Re)aimed at the set this window shows; nothing for a window without a set. */
  aim(): void {
    const folder = openFacts(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath).set?.folder;
    if ((folder ?? "") === this.key) return;
    this.key = folder ?? "";
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
    if (this.busy) return;
    const here = openFacts(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath).set;
    if (!here) return;
    this.busy = true;
    try {
      const raw = [AIHUB_SET, MAKER_SET].map((n) => join(here.folder, n)).find((p) => existsSync(p));
      if (!raw) return;
      const parsed = parseSetFile(readFileSync(raw, "utf8"));
      if (parsed.problem) return this.say(`Set file: ${parsed.problem}; nothing was applied.`, true);
      const file = readSetFile(here.folder);
      const metas: SetMeta[] = file ? [file.top, ...(file.top.others ?? [])] : [];
      const meta = metas.find((m) => m.story === here.story && (m.branch === here.branch || metas.length === 1)) ?? metas[0];
      const problem = checkMeta(meta ?? (parsed.json as Partial<SetMeta>));
      if (problem || !meta) return this.say(`Set file: ${problem ?? "the set file holds no set"}; nothing was applied.`, true);
      const actual = meta.repos.map((r) => ({ name: r.name, exists: existsSync(join(r.path, ".git")), branch: headBranchOf(r.path) }));
      // repositories that left the file but are still on disk are told about too
      const plan = planSetFile(meta, [...actual, ...here.repos.filter((r) => !meta.repos.some((m) => m.name === r.name)).map((r) => ({ name: r.name, exists: true, branch: r.branch }))]);
      if (plan.problem) return this.say(`Set file: ${plan.problem}; nothing was applied.`, true);
      const done: string[] = [];
      const inside = here.repos[0]?.path ?? here.folder;
      for (const a of plan.actions) {
        if (a.kind === "repair") {
          const args = ["worktree", "repair", "--json"];
          const first = await cli(args, inside);
          const out = await answerExisting(first, (extra) => cli([...args, ...extra], inside));
          if (out === undefined) return this.say(`Set file: repair of ${a.repos.join(", ")} was cancelled.`, true);
          await showOpened(jsonOf<OpenResultJson>(out), "this", this.h.log);
          done.push(`made the worktree of ${a.repos.join(", ")}`);
        } else {
          const path = meta.repos.find((r) => r.name === a.repo)?.path ?? inside;
          const args = ["branch", "switch", "--repo", a.repo, "--branch", a.branch, "--json"];
          const first = await cli(args, path);
          const out = await answerExisting(first, (extra) => cli([...args, ...extra], path));
          if (out === undefined) return this.say(`Set file: the switch of ${a.repo} to ${a.branch} was cancelled.`, true);
          await showOpened(jsonOf<OpenResultJson>(out), "this", this.h.log);
          done.push(`${a.repo} switched to ${a.branch}`);
        }
      }
      forgetScan(process.env);
      this.h.changed();
      // a file that already matches the folders (our own write) is silent
      if (done.length || plan.notes.length) this.say(summarizePlan(done, plan.notes));
    } finally {
      this.busy = false;
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.watcher?.dispose();
  }
}
