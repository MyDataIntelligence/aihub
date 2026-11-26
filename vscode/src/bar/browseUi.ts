import { homedir } from "node:os";
import * as vscode from "vscode";
import { cli, jsonOf } from "./runner";
import { BrowseMemo, browseArgs, browseErrorOf, pushFiles, removePushFiles, scopeOf, type BrowseError, type PrArg, type PushArg } from "./browse";
import { BAR_COMMANDS } from "./types";

/** The CLI runs in this window's first folder (its clone tells the organisation and the repos root), else in the home folder. */
const cwdOf = (): string => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir();

const bad = (e: unknown): BrowseError => ({ error: { kind: "badInput", message: (e as Error).message } });

/** Registers the aihub.bar.browse* commands; `reg` is the bar's registration (one error path for all). */
export function registerBrowseCommands(reg: (id: string, f: (...a: any[]) => unknown) => void): void {
  const memo = new BrowseMemo();
  const json = async (args: string[]) => jsonOf<unknown>(await cli(args, cwdOf()));

  /** A read: one process, shared while it runs; lasting failures remembered per organisation/repository. */
  const read = <A>(what: string, build: (a: A) => string[]) => (a: A) => {
    let args: string[];
    try {
      args = build(a ?? ({} as A));
    } catch (e) {
      return bad(e);
    }
    return memo.read(args.join("\u0000"), scopeOf(a as { org?: string; project?: string; repo?: string }, what === "find" || what === "search" ? "search" : "repo"), () => json(args));
  };

  reg(BAR_COMMANDS.browseProjects, read("projects", browseArgs.projects));
  reg(BAR_COMMANDS.browseProject, read("project", browseArgs.project));
  reg(BAR_COMMANDS.browseRepo, read("repo", browseArgs.repo));
  reg(BAR_COMMANDS.browseItems, read("items", browseArgs.items));
  reg(BAR_COMMANDS.browseFile, read("file", browseArgs.file));
  reg(BAR_COMMANDS.browseBranches, read("branches", browseArgs.branches));
  reg(BAR_COMMANDS.browseHistory, read("history", browseArgs.history));
  reg(BAR_COMMANDS.browseDiff, read("diff", browseArgs.diff));
  reg(BAR_COMMANDS.browseBlame, read("blame", browseArgs.blame));
  reg(BAR_COMMANDS.browseFind, read("find", browseArgs.find));
  reg(BAR_COMMANDS.browseSearch, read("search", browseArgs.search));
  reg(BAR_COMMANDS.browseSuggestBranch, read("suggest", browseArgs.suggestBranch));
  // a write: never shared, never remembered; the content and message go in private files that are removed right after
  reg(BAR_COMMANDS.browsePush, async (a: PushArg) => {
    let files: ReturnType<typeof pushFiles>;
    try {
      files = pushFiles(a);
    } catch (e) {
      return bad(e);
    }
    try {
      return await json(files.args);
    } catch (e) {
      return browseErrorOf(e);
    } finally {
      removePushFiles(files.dir);
    }
  });
  // a write: never shared, never remembered
  reg(BAR_COMMANDS.browseCreatePr, async (a: PrArg) => {
    let args: string[];
    try {
      args = browseArgs.createPr(a);
    } catch (e) {
      return bad(e);
    }
    try {
      return await json(args);
    } catch (e) {
      return browseErrorOf(e);
    }
  });
  // after az login or an update of the CLI: the remembered failures go
  reg(BAR_COMMANDS.browseRetryNow, () => {
    memo.forget();
    return { ok: true };
  });
}
