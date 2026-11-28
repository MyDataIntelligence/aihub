import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { configHome } from "../../../cli/src/lib/configHome";
import { browseErrorOf, type BrowseError } from "./browse";
import { addPending, externalTerminal, opencodeLine, parseChangeStart, startArgs, takePending, workingCopyTask, type ChangeStartArg, type ChangeWhere } from "./change";
import { cli, jsonOf } from "./runner";
import { BAR_COMMANDS } from "./types";
import { openPath } from "./window";

/**
 * Change with Agent: the aihub.bar.change* commands. A remote change is an `aihub browse change` workspace (no clone); a
 * working-copy change is a worktree on a new branch (aihub.bar.openReposAsSet noSet, without its window). The agent is opencode:
 * a terminal in this window (panel), a new VS Code window that starts it when it opens (newWindow), or Windows Terminal without a
 * VS Code window (terminal). Nothing is pushed until changePush. Nothing runs at activation except one look for a start that a
 * previous window left for this one (one small file, only when it exists).
 */

const fail = (kind: string, message: string) => ({ error: { kind, message } }) as BrowseError;

/**
 * The agents this window started, per change: its terminal (panel) and what became of it. A terminal of another program
 * (Windows Terminal) or another window cannot be seen from here: its state is "unknown".
 */
export type AgentState = "working" | "stopped" | "closed" | "unknown";
const agents = new Map<string, { terminal?: vscode.Terminal; state: AgentState }>();
let watching: vscode.Disposable | undefined;
function track(key: string, terminal: vscode.Terminal | undefined): void {
  agents.set(key, { terminal, state: terminal ? "working" : "unknown" });
  watching ??= vscode.window.onDidCloseTerminal((t) => {
    for (const a of agents.values()) if (a.terminal === t && a.state === "working") a.state = "closed";
  });
}
const agentOf = (key: string): AgentState => agents.get(key)?.state ?? "unknown";

/** A temp file with private content, removed after the call. */
async function withFile<T>(name: string, text: string, f: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "aihub-change-"));
  const file = join(dir, name);
  writeFileSync(file, text, { encoding: "utf8", mode: 0o600 });
  try {
    return await f(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const json = async <T>(args: string[], cwd: string) => jsonOf<T>(await cli(args, cwd));
const cwdOf = (): string => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? configHome(process.env);

function agentName(): string | undefined {
  const n = String(vscode.workspace.getConfiguration("aihub").get("chatAgentName", "aihub") ?? "");
  return n || undefined;
}

/** Starts opencode where the user asked. `folder` is where it works; `prompt` its first message. */
async function startAgent(where: ChangeWhere, folder: string, prompt: string, label: string, log: (l: string) => void): Promise<{ started: boolean; how: string; terminal?: vscode.Terminal }> {
  const line = opencodeLine(prompt, agentName());
  if (where === "panel") {
    const t = vscode.window.createTerminal({ name: `opencode · ${label}`, cwd: folder });
    t.show(false);
    t.sendText(line, true);
    log(`change: opencode in a terminal of this window (${folder})`);
    return { started: true, how: "panel", terminal: t };
  }
  if (where === "terminal") {
    const hasWt = !!process.env.LOCALAPPDATA && existsSync(join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps", "wt.exe"));
    const ext = externalTerminal(folder, prompt, { hasWt, agent: agentName() });
    if (!ext) {
      // no external terminal known on this system: the panel of this window
      return startAgent("panel", folder, prompt, label, log);
    }
    const p = spawn(ext.command, ext.args, { cwd: folder, detached: true, stdio: "ignore", windowsHide: false });
    p.on("error", (e) => log(`change: the terminal did not start: ${e.message}`));
    p.unref();
    log(`change: opencode in ${hasWt ? "Windows Terminal" : "a console window"} (${folder})`);
    return { started: true, how: hasWt ? "windowsTerminal" : "console" };
  }
  // a new window: it starts opencode itself when it opens this folder
  addPending(process.env, { folder, line, at: Date.now() });
  await openPath(folder, "new");
  log(`change: a new window on ${folder} starts opencode`);
  return { started: true, how: "newWindow" };
}

/** Called once, a moment after the window opened: a change that asked this window to start opencode. */
export function startPendingAgent(log: (l: string) => void): void {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const p = takePending(process.env, folder, Date.now());
  if (!p) return;
  const t = vscode.window.createTerminal({ name: "opencode · change", cwd: p.folder });
  t.show(false);
  t.sendText(p.line, true);
  log(`change: started opencode for ${p.folder}`);
}

interface StartJson {
  id: string;
  dir: string;
  filesDir: string;
  branch: string;
  base: { branch: string; commit: string };
  agentPrompt: string;
}

interface DiffJson {
  id: string;
  project: string;
  repo: string;
  branch: string;
  base: { branch: string; commit: string };
}

export function registerChangeCommands(h: { reg: (id: string, f: (...a: any[]) => unknown) => void; log: (l: string) => void; changed: () => void }): void {
  h.reg(BAR_COMMANDS.changeStart, async (raw?: unknown) => {
    const a = parseChangeStart(raw);
    if ("problem" in a) return fail("badInput", a.problem);
    try {
      if (a.mode === "remote") {
        const s = await withFile("prompt.txt", a.prompt, async (f) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Preparing the change in ${a.repo}...` }, () => json<StartJson>(startArgs(a, f), cwdOf())) as Promise<StartJson>);
        const agent = await startAgent(a.where, s.dir, s.agentPrompt, a.repo, h.log);
        track(s.id, agent.terminal);
        return { id: s.id, mode: a.mode, where: a.where, dir: s.dir, filesDir: s.filesDir, branch: s.branch, base: s.base, agent: agent.how, ...(agent.terminal ? { terminal: { name: agent.terminal.name } } : {}) };
      }
      return await startWorkingCopy(a, h.log);
    } catch (e) {
      return browseErrorOf(e);
    }
  });

  h.reg(BAR_COMMANDS.changeState, async (a?: { id?: string }) => {
    if (!a?.id) return fail("badInput", "which change? ({ id })");
    try {
      const d = await json<Record<string, unknown>>(["browse", "change", "diff", "--id", a.id], cwdOf());
      return { ...d, agent: agentOf(a.id) };
    } catch (e) {
      return browseErrorOf(e);
    }
  });

  // Stop: the agent's terminal in this window goes (opencode ends with it); the workspace and its files stay for the review
  h.reg(BAR_COMMANDS.changeStop, (a?: { id?: string; path?: string }) => {
    const key = a?.id ?? a?.path;
    if (!key) return fail("badInput", "which change? ({ id } or, for a working copy, { path })");
    const ag = agents.get(key);
    if (!ag?.terminal) return { id: key, stopped: false, agent: agentOf(key), reason: "the agent does not run in a terminal of this window (Windows Terminal or another window): stop it there" };
    ag.terminal.dispose();
    ag.state = "stopped";
    h.log(`change: stopped the agent of ${key}`);
    return { id: key, stopped: true, agent: "stopped" as AgentState };
  });

  h.reg(BAR_COMMANDS.changePush, async (a?: { id?: string; message?: string; pr?: boolean; target?: string; story?: number; prTitle?: string; draft?: boolean; rebase?: boolean; branch?: string }) => {
    if (!a?.id) return fail("badInput", "which change? ({ id })");
    const run = (messageFile?: string) =>
      json<unknown>(
        [
          "browse",
          "change",
          "push",
          "--id",
          a.id!,
          ...(messageFile ? ["--message-file", messageFile] : []),
          ...(a.branch ? ["--branch", a.branch] : []),
          ...(a.pr ? ["--pr", ...(a.target ? ["--target", a.target] : []), ...(a.story ? ["--story", String(a.story)] : []), ...(a.prTitle ? ["--pr-title", a.prTitle] : []), ...(a.draft ? ["--draft"] : [])] : []),
          ...(a.rebase ? ["--rebase"] : []),
        ],
        cwdOf(),
      );
    try {
      const out = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Pushing the change..." }, () => (a.message?.trim() ? withFile("message.txt", a.message, run) : run()) as Promise<unknown>);
      h.changed();
      return out;
    } catch (e) {
      return browseErrorOf(e);
    }
  });

  h.reg(BAR_COMMANDS.changeDiscard, async (a?: { id?: string }) => {
    if (!a?.id) return fail("badInput", "which change? ({ id })");
    try {
      return await json<unknown>(["browse", "change", "discard", "--id", a.id], cwdOf());
    } catch (e) {
      return browseErrorOf(e);
    }
  });

  h.reg(BAR_COMMANDS.changeToWorkingCopy, async (a?: { id?: string; where?: ChangeWhere | "here"; remoteUrl?: string }) => {
    if (!a?.id) return fail("badInput", "which change? ({ id })");
    try {
      const d = await json<DiffJson>(["browse", "change", "diff", "--id", a.id], cwdOf());
      const wc = await workingCopyOf({ project: d.project, repo: d.repo, remoteUrl: a.remoteUrl, newBranch: d.branch, from: d.base.branch });
      if ("error" in wc) return wc;
      const applied = await json<{ applied: string[]; skipped: { path: string; why: string }[] }>(["browse", "change", "apply", "--id", a.id, "--dir", wc.path], cwdOf());
      if (a.where === "terminal" || a.where === "panel") await startAgent(a.where, wc.path, "Continue the change in this working copy: review it and run the tests. Do not push.", d.repo, h.log);
      else if (a.where !== "here") await openPath(wc.path, "new");
      h.changed();
      return { id: a.id, path: wc.path, branch: d.branch, cloned: wc.cloned, applied: applied.applied, skipped: applied.skipped };
    } catch (e) {
      return browseErrorOf(e);
    }
  });
}

/** A worktree on a new branch from the base (cloned when needed), without a window: aihub.bar.openReposAsSet noSet. */
async function workingCopyOf(o: { project: string; repo: string; remoteUrl?: string; newBranch: string; from?: string; branch?: string }): Promise<{ path: string; cloned: boolean } | BrowseError> {
  let remoteUrl = o.remoteUrl;
  if (!remoteUrl) {
    // the remote url of the repository (cached list; one process when it is not)
    const p = await json<{ projects: { name: string; repos: { repo: string; remoteUrl: string }[] }[] }>(["browse", "projects"], cwdOf()).catch(() => undefined);
    remoteUrl = p?.projects.find((x) => x.name.toLowerCase() === o.project.toLowerCase())?.repos.find((r) => r.repo.toLowerCase() === o.repo.toLowerCase())?.remoteUrl;
  }
  const res = (await vscode.commands.executeCommand(BAR_COMMANDS.openReposAsSet, {
    repos: [{ name: o.repo, project: o.project, remoteUrl, ...(o.branch ? { branch: o.branch } : { newBranch: o.newBranch, from: o.from }) }],
    noSet: true,
    openWindow: false,
  })) as { repos?: { ok: boolean; path?: string; cloned?: boolean; error?: string }[]; error?: { kind: string; message: string } };
  if (res?.error) return fail(res.error.kind, res.error.message);
  const row = res?.repos?.[0];
  if (!row?.ok || !row.path) return fail("failed", row?.error ?? `no working copy of ${o.repo} could be made`);
  return { path: row.path, cloned: !!row.cloned };
}

/** mode workingCopy: a worktree on the feature branch (cloned when needed), TASK.md outside it, then the agent. */
async function startWorkingCopy(a: ChangeStartArg, log: (l: string) => void) {
  const branch = a.newBranch ?? (await json<{ branch: string }>(["browse", "suggest-branch", ...(a.story ? ["--story", String(a.story)] : []), "--path", a.paths?.[0] ?? a.selection?.path ?? "/change", "--title", a.prompt.slice(0, 80)], cwdOf())).branch;
  const wc = await workingCopyOf({ project: a.project, repo: a.repo, remoteUrl: a.remoteUrl, newBranch: branch, from: a.branch });
  if ("error" in wc) return wc;
  // the task stays outside the working copy (nothing to commit by accident)
  const dir = join(configHome(process.env), "changes");
  mkdirSync(dir, { recursive: true });
  const task = join(dir, `task-${a.repo.replace(/[^\w.-]+/g, "-")}-${Date.now()}.md`);
  writeFileSync(task, workingCopyTask(a, branch, a.branch ?? "the default branch"), "utf8");
  const agent = await startAgent(a.where, wc.path, `Read the task in ${task.replace(/\\/g, "/")} and make the change in this working copy. Do not push.`, a.repo, log);
  track(wc.path, agent.terminal);
  return { mode: a.mode, where: a.where, path: wc.path, branch, cloned: wc.cloned, taskFile: task, agent: agent.how, ...(agent.terminal ? { terminal: { name: agent.terminal.name } } : {}) };
}
