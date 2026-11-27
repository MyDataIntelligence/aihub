import { homedir } from "node:os";
import * as vscode from "vscode";
import { cli, jsonOf } from "./runner";
import { BROWSE_UPDATE_COMMAND, BrowseMemo, browseErrorOf, type BrowseError } from "./browse";
import { removeStoryFiles, storyArgs, storyCommandId, storyScope, STORY_READS, STORY_SUBS, type StoryCall, type StoryCommand } from "./stories";
import { BAR_COMMANDS } from "./types";

/** The CLI runs in this window's first folder (its clone tells the organisation, team.yaml and the templates), else in the home folder. */
const cwdOf = (): string => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir();

const bad = (e: unknown): BrowseError => ({ error: { kind: "badInput", message: (e as Error).message } });

/** A CLI without `aihub stories` says so in plain words. */
export function storyErrorOf(e: unknown): BrowseError {
  const raw = String((e as { message?: string })?.message ?? e);
  if (/unknown command 'stories'|usage: aihub stories/i.test(raw) && !raw.includes('{"error":'))
    return { error: { kind: "cliTooOld", message: `This needs a newer aihub CLI with the story browser. Update it with: ${BROWSE_UPDATE_COMMAND}` } };
  return browseErrorOf(e);
}

/** Registers the aihub.bar.story* commands; `reg` is the bar's registration (one error path for all). */
export function registerStoryBrowserCommands(reg: (id: string, f: (...a: any[]) => unknown) => void): void {
  const memo = new BrowseMemo();
  const run = async (call: StoryCall) => {
    try {
      return jsonOf<unknown>(await cli(call.args, cwdOf()));
    } finally {
      removeStoryFiles(call.dir);
    }
  };
  for (const cmd of Object.keys(STORY_SUBS) as StoryCommand[]) {
    const read = STORY_READS.includes(cmd);
    reg(storyCommandId(cmd), async (a?: Record<string, unknown>) => {
      let call: StoryCall;
      try {
        call = storyArgs(cmd, a ?? {});
      } catch (e) {
        return bad(e);
      }
      // a read: one process, shared while it runs; lasting failures remembered per organisation/project
      if (read) {
        const r = await memo.read(call.args.join("\u0000"), storyScope(a as { org?: string; project?: string }), () => run(call));
        return "error" in (r as object) && (r as BrowseError).error.kind === "failed" ? storyErrorOf((r as BrowseError).error.message) : r;
      }
      // a write: never shared, never remembered
      try {
        return await run(call);
      } catch (e) {
        return storyErrorOf(e);
      }
    });
  }
  // after az login or an update of the CLI: the remembered failures go
  reg(BAR_COMMANDS.storyRetryNow, () => {
    memo.forget();
    return { ok: true };
  });
}
