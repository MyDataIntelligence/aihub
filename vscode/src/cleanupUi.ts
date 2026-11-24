import * as vscode from "vscode";
import { CliError, makeRunner, readJson, type Runner } from "./cli";
import { mayCheck, pickItems, shouldAsk, size, type CleanupRow, type ReminderState } from "./cleanupModel";
import { clearTrackedInterval, trackedInterval, trackedTimeout } from "./perf/probe";

/**
 * Clean Up Worktrees: the list of `aihub worktree cleanup --json` (PR, story, local work, merged, size) as a pick list
 * with the finished, clean worktrees ticked; removal through the CLI (links first, never --force, never local work).
 * A reminder at most once a day, normally once a week, sooner when three or more can go; never a series of toasts.
 */

const cfg = () => vscode.workspace.getConfiguration("aihub");
const STATE_KEY = "aihub.worktrees.cleanupReminder";

export class CleanupController implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  constructor(
    private ctx: vscode.ExtensionContext,
    private cwd: () => string | undefined,
    private refreshViews: () => void,
  ) {}

  private runner(): Runner {
    // sizes and one request per branch: give it room
    return makeRunner({ command: String(cfg().get("cliPath", "aihub")) || "aihub", timeoutMs: 180_000, env: { GCM_INTERACTIVE: "never", GIT_TERMINAL_PROMPT: "0" } });
  }

  private folder() {
    return this.cwd() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /** false when the CLI has no `worktree cleanup` yet (the caller falls back to the git-only clean-up). */
  async show(): Promise<boolean> {
    const cwd = this.folder();
    if (!cwd) return false;
    let rows: CleanupRow[];
    try {
      rows = (await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Reading worktrees, pull requests and stories..." }, () => readJson<{ worktrees: CleanupRow[] }>(this.runner(), ["worktree", "cleanup"], cwd))).worktrees;
    } catch (e) {
      if (e instanceof CliError && /unknown command|usage: aihub worktree/i.test(e.message)) return false;
      void vscode.window.showErrorMessage(`AI Context Hub: ${(e as Error).message}`);
      return true;
    }
    if (!rows.length) {
      void vscode.window.showInformationMessage("No worktrees found in this repository or your repo groups.");
      return true;
    }
    const items = pickItems(rows, Date.now());
    const pre = rows.filter((r) => r.preselected);
    const picks = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: `Clean up worktrees: ${pre.length} of ${rows.length} can go${pre.length ? ` (${size(pre.reduce((n, r) => n + (r.sizeBytes ?? 0), 0))})` : ""}`,
      placeHolder: "Ticked: PR completed or abandoned, story done or merged, and no local work. A warning sign = local work, never ticked.",
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picks?.length) return true;
    const chosen = rows.filter((r) => picks.some((p) => p.path === r.path));
    const local = chosen.filter((r) => r.warning);
    const bytes = chosen.reduce((n, r) => n + (r.sizeBytes ?? 0), 0);
    const go = await vscode.window.showWarningMessage(
      `Remove ${chosen.length} worktree(s)${bytes ? ` (${size(bytes)})` : ""}?`,
      {
        modal: true,
        detail: `${chosen.map((r) => `${r.repo}: ${r.branch}`).join("\n")}${local.length ? `\n\n${local.length} with local work are kept (aihub never removes uncommitted or unpushed work).` : ""}\n\nFolder links (a linked node_modules) are taken out first, so what they point to stays.`,
      },
      "Remove and delete merged branches",
      "Remove, keep branches",
    );
    if (!go) return true;
    try {
      const out = await this.runner()(["worktree", "cleanup", "--json", "--remove", chosen.map((r) => r.path).join(","), ...(go.startsWith("Remove and") ? ["--delete-branch"] : [])], cwd);
      const r = JSON.parse(out.slice(out.search(/[[{]/))) as { removed: { branch: string; removed: boolean; note: string }[]; freedBytes: number };
      const kept = r.removed.filter((x) => !x.removed);
      void vscode.window.showInformationMessage(
        `Removed ${r.removed.length - kept.length} worktree(s), ${size(r.freedBytes) || "0 MB"} freed.${kept.length ? ` Kept: ${kept.map((k) => `${k.branch} (${k.note})`).join("; ")}` : ""}`,
      );
    } catch (e) {
      void vscode.window.showErrorMessage(`AI Context Hub: ${(e as Error).message}`);
    }
    this.refreshViews();
    return true;
  }

  register() {
    this.ctx.subscriptions.push(this);
    if (cfg().get<string>("worktrees.cleanupReminder", "weekly") === "off") return;
    // 15 minutes after the start, then daily; the read only runs when a question could be asked at all
    trackedTimeout("cleanup.firstCheck", () => void this.check(), 15 * 60_000).unref?.();
    this.timer = trackedInterval("cleanup.dailyCheck", () => void this.check(), 24 * 3_600_000);
    this.timer.unref?.();
  }

  private state(): ReminderState {
    return this.ctx.globalState.get<ReminderState>(STATE_KEY) ?? {};
  }

  async check(): Promise<void> {
    const now = Date.now();
    const cwd = this.folder();
    if (!cwd || !mayCheck(this.state(), now)) return;
    let rows: CleanupRow[] = [];
    try {
      rows = (await readJson<{ worktrees: CleanupRow[] }>(this.runner(), ["worktree", "cleanup", "--no-size"], cwd)).worktrees;
    } catch {
      return;
    }
    const n = rows.filter((r) => r.preselected).length;
    if (!shouldAsk(this.state(), n, now)) return;
    await this.ctx.globalState.update(STATE_KEY, { ...this.state(), lastAsked: now });
    const stories = rows.filter((r) => r.preselected && r.story?.done).length;
    const pick = await vscode.window.showInformationMessage(`AI Context Hub: ${n} worktree(s) can go${stories ? ` (${stories} with a finished story)` : ""}.`, "Review", "Later", "Don't ask again");
    if (pick === "Review") await this.show();
    else if (pick === "Later") await this.ctx.globalState.update(STATE_KEY, { ...this.state(), snoozeUntil: now + 7 * 86_400_000 });
    else if (pick === "Don't ask again") await this.ctx.globalState.update(STATE_KEY, { ...this.state(), never: true });
  }

  dispose() {
    clearTrackedInterval(this.timer);
  }
}
