import { homedir } from "node:os";
import { dirname } from "node:path";
import * as vscode from "vscode";
import { cli, jsonOf } from "./runner";
import { BrowseMemo, type BrowseError } from "./browse";
import { storyErrorOf } from "./storiesUi";
import { checkStoryAction, e2eArgs, idOf, needsStart, promptSaveCall, removeDir, runStateOf, setOf, slashCommand, takePending, writePending } from "./e2e";
import { BAR_COMMANDS } from "./types";

/** The CLI runs in this window's first folder, else in the home folder. */
const cwdOf = (): string => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir();
const bad = (e: unknown): BrowseError => ({ error: { kind: "badInput", message: (e as Error).message } });
const same = (a: string, b: string) => a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();

/** Is this window the set? Its workspace file, or a first folder inside the set folder. */
export function windowIsSet(set: { folder: string; workspace?: string }): boolean {
  const wsFile = vscode.workspace.workspaceFile?.fsPath;
  if (wsFile && set.workspace && same(wsFile, set.workspace)) return true;
  return (vscode.workspace.workspaceFolders ?? []).some((f) => same(f.uri.fsPath, set.folder) || same(dirname(f.uri.fsPath), set.folder));
}

/**
 * Registers the Run End to End commands. `toOpencode` starts (or finds) the opencode tab of this window and sends the
 * slash command with Enter. Nothing runs at activation except one read of the pending-action file (see runPending).
 */
export function registerE2eCommands(reg: (id: string, f: (...a: any[]) => unknown) => void, toOpencode: (text: string) => Promise<boolean>): void {
  const memo = new BrowseMemo();
  const json = async (args: string[]) => jsonOf<unknown>(await cli(args, cwdOf()));
  const read = <A>(build: (a: A) => string[]) => async (a: A) => {
    let args: string[];
    try {
      args = build(a ?? ({} as A));
    } catch (e) {
      return bad(e);
    }
    const r = await memo.read(args.join("\u0000"), `e2e|${(a as { project?: string })?.project ?? ""}`, () => json(args));
    return "error" in (r as object) && (r as BrowseError).error.kind === "failed" ? storyErrorOf((r as BrowseError).error.message) : r;
  };
  const write = <A>(build: (a: A) => string[]) => async (a: A) => {
    let args: string[];
    try {
      args = build(a ?? ({} as A));
    } catch (e) {
      return bad(e);
    }
    try {
      return await json(args);
    } catch (e) {
      return storyErrorOf(e);
    }
  };

  reg(BAR_COMMANDS.storyPrompt, read(e2eArgs.prompt));
  reg(BAR_COMMANDS.storyPrompts, read(e2eArgs.prompts));
  reg(BAR_COMMANDS.storyPromptReset, write(e2eArgs.promptReset));
  reg(BAR_COMMANDS.storyPromptSave, async (a: Parameters<typeof promptSaveCall>[0]) => {
    let call: ReturnType<typeof promptSaveCall>;
    try {
      call = promptSaveCall(a);
    } catch (e) {
      return bad(e);
    }
    try {
      return await json(call.args);
    } catch (e) {
      return storyErrorOf(e);
    } finally {
      removeDir(call.dir);
    }
  });
  // the badge reads the run state fresh every time (a small file; the bar may watch `stateFile` instead of asking)
  reg(BAR_COMMANDS.storyRunState, async (a: { id?: unknown; project?: string }) => {
    let args: string[];
    try {
      args = e2eArgs.runState(a);
    } catch (e) {
      return bad(e);
    }
    try {
      return runStateOf(await json(args));
    } catch (e) {
      return storyErrorOf(e);
    }
  });
  reg(BAR_COMMANDS.criteriaStatus, write(e2eArgs.criteriaStatus));
  reg(BAR_COMMANDS.criteriaProposal, write(e2eArgs.criteriaProposal));
  reg(BAR_COMMANDS.criteriaApply, write(e2eArgs.criteriaApply));

  reg(BAR_COMMANDS.storyAction, async (a: { id?: unknown; action?: unknown; repos?: unknown; yolo?: unknown; window?: unknown; org?: string; project?: string }) => {
    let id: number;
    let action: ReturnType<typeof checkStoryAction>;
    try {
      id = idOf(a);
      action = checkStoryAction(a?.action);
    } catch (e) {
      return bad(e);
    }
    const command = slashCommand(action, id);
    try {
      // the story's set: reused when it is on this PC; a story without branches is started first (branches, set)
      let set: { folder: string; workspace?: string } | undefined;
      try {
        set = setOf(await json(e2eArgs.open({ id })));
      } catch (e) {
        if (!needsStart(String((e as Error).message))) throw e;
        set = setOf(await json(e2eArgs.start({ id, repos: a?.repos, org: a?.org, project: a?.project })));
      }
      if (!set) return { error: { kind: "failed", message: `no set was made for ${id}` } };
      if (a?.yolo !== undefined) await json(e2eArgs.yolo(set.folder, a.yolo === true));
      if (windowIsSet(set)) {
        const started = await toOpencode(command);
        return { id, action, command, folder: set.folder, window: "this", started };
      }
      // another window: it starts the command itself when it opens (one small file, at most 2 minutes old)
      writePending(set.folder, { id, action, command, at: Date.now() });
      const target = vscode.Uri.file(set.workspace ?? set.folder);
      const newWindow = a?.window !== "this";
      await vscode.commands.executeCommand("vscode.openFolder", target, { forceNewWindow: newWindow });
      return { id, action, command, folder: set.folder, window: newWindow ? "new" : "this", started: false };
    } catch (e) {
      return storyErrorOf(e);
    }
  });
}

/** A window that opened for a set with a pending action starts that action in opencode, once. */
export async function runPending(toOpencode: (text: string) => Promise<boolean>, log: (l: string) => void): Promise<void> {
  const ws = vscode.workspace.workspaceFile?.fsPath;
  const folder = ws ? dirname(ws) : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const candidates = [folder, folder ? dirname(folder) : undefined];
  for (const f of candidates) {
    const p = takePending(f, Date.now());
    if (p) {
      log(`pending story action ${p.command} in ${f}`);
      await toOpencode(p.command);
      return;
    }
  }
}
