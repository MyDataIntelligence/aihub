import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { configHome } from "../../../cli/src/lib/configHome";
import { browseErrorOf, type BrowseError } from "./browse";
import { addPending, externalTerminal, opencodeLine, parseChangeStart, progressLines, startArgs, takePending, verifyArgs, workingCopyTask, type ChangeStartArg, type ChangeWhere } from "./change";
import { cli, jsonOf } from "./runner";
import { BAR_COMMANDS } from "./types";
import { openPath } from "./window";
import { wikiUpdateStartArgs, type WikiUpdateStartArg, type WikiUpdateStartJson } from "./wiki";

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

  // Run Checks (temporary copy): lint and tests of a remote change; progress to the hub's notification and to the caller's command
  h.reg(BAR_COMMANDS.changeVerify, async (a?: { id?: string; lint?: boolean; tests?: boolean; onProgress?: string }) => {
    let args: string[];
    try {
      args = verifyArgs(a ?? {});
    } catch (e) {
      return fail("badInput", (e as Error).message);
    }
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Checking the change in a temporary copy" }, (progress) =>
      streamCli(args, cwdOf(), (line) => {
        for (const e of progressLines(line)) {
          progress.report({ message: `${e.n}/${e.total} ${e.message}` });
          if (a?.onProgress) void vscode.commands.executeCommand(a.onProgress, e).then(undefined, () => undefined);
        }
      }).then((r) => {
        h.changed();
        if (r.code === 0) return jsonOf<unknown>(r.stdout);
        return browseErrorOf(new Error(`${r.stderr}\n${r.stdout}`));
      }),
    );
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

  h.reg(BAR_COMMANDS.changePush, async (a?: { id?: string; message?: string; pr?: boolean; anyway?: boolean; target?: string; story?: number; prTitle?: string; draft?: boolean; rebase?: boolean; branch?: string }) => {
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
          ...(a.pr ? ["--pr", ...(a.target ? ["--target", a.target] : []), ...(a.story ? ["--story", String(a.story)] : []), ...(a.prTitle ? ["--pr-title", a.prTitle] : []), ...(a.draft ? ["--draft"] : []), ...(a.anyway ? ["--anyway"] : [])] : []),
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

  // ---- Ask Agent about Selected: read only, a report per repository; Apply makes a change per repository ----
  h.reg(BAR_COMMANDS.askStart, async (raw?: { scope?: { project?: string; repo?: string }[]; prompt?: string; where?: ChangeWhere; story?: number; limit?: number }) => {
    const scope = (raw?.scope ?? []).filter((x) => typeof x?.project === "string" && x.project.trim()).map((x) => (x.repo ? `${x.project}/${x.repo}` : x.project!));
    if (!scope.length) return fail("badInput", "which repositories or projects? ({ scope: [{ project, repo? }] })");
    if (!raw?.prompt?.trim()) return fail("badInput", "what is the question? ({ prompt })");
    const where: ChangeWhere = raw.where === "newWindow" || raw.where === "terminal" ? raw.where : "panel";
    try {
      const s = await withFile("question.txt", raw.prompt, (f) => json<{ id: string; dir: string; agentPrompt: string; limit: number }>(["browse", "ask", "start", "--scope", scope.join(","), "--prompt-file", f, ...(raw.story ? ["--story", String(raw.story)] : []), ...(raw.limit ? ["--limit", String(raw.limit)] : [])], cwdOf()));
      const agent = await startAgent(where, s.dir, s.agentPrompt, `${scope.length} repositories`, h.log);
      track(s.id, agent.terminal);
      return { id: s.id, where, dir: s.dir, limit: s.limit, agent: agent.how, ...(agent.terminal ? { terminal: { name: agent.terminal.name } } : {}) };
    } catch (e) {
      return browseErrorOf(e);
    }
  });
  h.reg(BAR_COMMANDS.askState, async (a?: { id?: string }) => {
    if (!a?.id) return fail("badInput", "which question? ({ id })");
    try {
      return { ...(await json<Record<string, unknown>>(["browse", "ask", "state", "--id", a.id], cwdOf())), agent: agentOf(a.id) };
    } catch (e) {
      return browseErrorOf(e);
    }
  });
  h.reg(BAR_COMMANDS.askAllow, async (a?: { id?: string; more?: number }) => {
    if (!a?.id) return fail("badInput", "which question? ({ id })");
    try {
      return await json<unknown>(["browse", "ask", "allow", "--id", a.id, ...(a.more ? ["--more", String(a.more)] : [])], cwdOf());
    } catch (e) {
      return browseErrorOf(e);
    }
  });
  h.reg(BAR_COMMANDS.askApply, async (a?: { id?: string; project?: string; repo?: string; branch?: string; story?: number }) => {
    if (!a?.id || !a.project || !a.repo) return fail("badInput", "which question and repository? ({ id, project, repo })");
    try {
      const out = await json<unknown>(["browse", "ask", "apply", "--id", a.id, "--project", a.project, "--repo", a.repo, ...(a.branch ? ["--branch", a.branch] : []), ...(a.story ? ["--story", String(a.story)] : [])], cwdOf());
      h.changed();
      return out;
    } catch (e) {
      return browseErrorOf(e);
    }
  });
  // Open These Repos as Set: the repositories of the report on the question's branch (one branch, the story), cloned when needed
  h.reg(BAR_COMMANDS.askOpenAsSet, async (a?: { id?: string; story?: number; branch?: string; window?: "new" | "this" }) => {
    if (!a?.id) return fail("badInput", "which question? ({ id })");
    try {
      const st = await json<{ branch: string | null; repos: { project: string; repo: string }[] }>(["browse", "ask", "state", "--id", a.id], cwdOf());
      if (!st.repos.length) return fail("badInput", "the question has no repositories in its report yet");
      const branch = a.branch ?? st.branch ?? undefined;
      const p = await json<{ projects: { name: string; repos: { repo: string; remoteUrl: string }[] }[] }>(["browse", "projects"], cwdOf()).catch(() => undefined);
      const urlOf = (project: string, repo: string) => p?.projects.find((x) => x.name === project)?.repos.find((r) => r.repo === repo)?.remoteUrl;
      if (!branch) return fail("badInput", "which branch for the set? ({ branch }, or apply a repository first)");
      return await vscode.commands.executeCommand(BAR_COMMANDS.openReposAsSet, { repos: st.repos.map((r) => ({ name: r.repo, project: r.project, remoteUrl: urlOf(r.project, r.repo) })), newBranch: branch, story: a.story, window: a.window });
    } catch (e) {
      return browseErrorOf(e);
    }
  });
  h.reg(BAR_COMMANDS.askDiscard, async (a?: { id?: string }) => {
    if (!a?.id) return fail("badInput", "which question? ({ id })");
    try {
      return await json<unknown>(["browse", "ask", "discard", "--id", a.id], cwdOf());
    } catch (e) {
      return browseErrorOf(e);
    }
  });

  // ---- Update Wiki with Context from…: an `aihub wiki update` workspace; nothing reaches the wiki until wikiUpdateApply ----
  h.reg(BAR_COMMANDS.wikiUpdateStart, async (raw?: WikiUpdateStartArg) => {
    let a: ReturnType<typeof wikiUpdateStartArgs>;
    try {
      a = wikiUpdateStartArgs(raw);
    } catch (e) {
      return fail("badInput", (e as Error).message);
    }
    try {
      const s = await withFile("sources.json", JSON.stringify(a.sources), (sf) =>
        withFile("prompt.txt", a.prompt ?? "", (pf) =>
          vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Preparing the wiki update in ${a.wiki}...` }, () => json<WikiUpdateStartJson>([...a.args, "--sources-file", sf, ...(a.prompt ? ["--prompt-file", pf] : [])], cwdOf())) as Promise<WikiUpdateStartJson>,
        ),
      );
      const agent = await startAgent(a.where, s.dir, s.agentPrompt, a.wiki, h.log);
      track(s.id, agent.terminal);
      return { ...s, where: a.where, agent: agent.how, ...(agent.terminal ? { terminal: { name: agent.terminal.name } } : {}) };
    } catch (e) {
      return browseErrorOf(e);
    }
  });
  h.reg(BAR_COMMANDS.wikiUpdateState, async (a?: { id?: string }) => {
    if (!a?.id) return fail("badInput", "which wiki update? ({ id })");
    try {
      return { ...(await json<Record<string, unknown>>(["wiki", "update", "diff", "--id", a.id], cwdOf())), agent: agentOf(a.id) };
    } catch (e) {
      return browseErrorOf(e);
    }
  });
  h.reg(BAR_COMMANDS.wikiUpdateApply, async (a?: { id?: string; paths?: string[]; comment?: string }) => {
    if (!a?.id) return fail("badInput", "which wiki update? ({ id })");
    const args = ["wiki", "update", "apply", "--id", a.id, ...(a.paths ?? []).flatMap((p) => ["--path", p])];
    try {
      const out = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Publishing to the wiki..." }, () => (a.comment?.trim() ? withFile("comment.txt", a.comment, (f) => json<unknown>([...args, "--comment-file", f], cwdOf())) : json<unknown>(args, cwdOf())) as Promise<unknown>);
      h.changed();
      return out;
    } catch (e) {
      return browseErrorOf(e);
    }
  });
  h.reg(BAR_COMMANDS.wikiUpdateDiscard, async (a?: { id?: string; path?: string }) => {
    if (!a?.id) return fail("badInput", "which wiki update? ({ id })");
    try {
      return await json<unknown>(["wiki", "update", "discard", "--id", a.id, ...(a.path ? ["--path", a.path] : [])], cwdOf());
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

/**
 * One aihub process whose stderr is read while it runs (the progress of change verify): the same command as the other calls
 * (aihub.cliPath; through a shell on Windows for the npm .cmd shim), never a sign-in window.
 */
function streamCli(args: string[], cwd: string, onErr: (chunk: string) => void): Promise<{ code: number; stdout: string; stderr: string }> {
  const command = String(vscode.workspace.getConfiguration("aihub").get("cliPath", "aihub")) || "aihub";
  const shell = process.platform === "win32" && !/\.(exe|com)$/i.test(command);
  const q = (x: string) => (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(x) ? x : `"${x.replace(/"/g, '\\"')}"`);
  return new Promise((resolve) => {
    const p = spawn(shell ? q(command) : command, shell ? args.map(q) : args, { cwd, shell, windowsHide: true, env: { ...process.env, GCM_INTERACTIVE: "never", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" } });
    let stdout = "";
    let stderr = "";
    let pending = "";
    p.stdout.on("data", (b: Buffer) => (stdout += b.toString()));
    p.stderr.on("data", (b: Buffer) => {
      const text = pending + b.toString();
      const cut = text.lastIndexOf("\n");
      pending = cut >= 0 ? text.slice(cut + 1) : text;
      if (cut >= 0) onErr(text.slice(0, cut));
      stderr += b.toString();
    });
    p.on("error", (e) => resolve({ code: 1, stdout, stderr: `${stderr}\n${e.message}` }));
    p.on("close", (code) => {
      if (pending) onErr(pending);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
