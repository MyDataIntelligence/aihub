import { homedir } from "node:os";
import * as vscode from "vscode";
import { cli, jsonOf } from "./runner";
import { BrowseMemo, browseErrorOf, removePushFiles, scopeOf, type BrowseError } from "./browse";
import { askText, updateFromBranchText, wikiArgs, wikiWriteFiles, type AskArg, type CreateArg, type MoveArg, type PublishArg, type UpdateFromBranchArg } from "./wiki";
import { BAR_COMMANDS } from "./types";

const cwdOf = (): string => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir();
const bad = (e: unknown): BrowseError => ({ error: { kind: "badInput", message: (e as Error).message } });

/** Registers the aihub.bar.wiki* commands; `reg` is the bar's registration, `toChat` the chat hand-off (as pipelineFix). */
export function registerWikiCommands(reg: (id: string, f: (...a: any[]) => unknown) => void, toChat: (text: string) => Promise<void> | void): void {
  const memo = new BrowseMemo();
  const json = async (args: string[]) => jsonOf<unknown>(await cli(args, cwdOf()));

  /** A read: one process, shared while it runs; lasting failures remembered per organisation and project (search: per organisation). */
  const read = <A>(what: string, build: (a: A) => string[]) => (a: A) => {
    let args: string[];
    try {
      args = build(a ?? ({} as A));
    } catch (e) {
      return bad(e);
    }
    const x = (a ?? {}) as { org?: string; project?: string };
    return memo.read(args.join("\u0000"), scopeOf({ org: x.org, project: what === "search" ? undefined : x.project }, `wiki-${what === "search" ? "search" : "read"}`), () => json(args));
  };
  /** A write: never shared, never remembered; its text goes in private files removed right after. */
  const write = <A>(kind: "publish" | "create" | "move") => async (a: A) => {
    let files: ReturnType<typeof wikiWriteFiles>;
    try {
      files = wikiWriteFiles(kind, (a ?? {}) as unknown as PublishArg | CreateArg | MoveArg);
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
  };
  const once = <A>(build: (a: A) => string[]) => async (a: A) => {
    let args: string[];
    try {
      args = build(a ?? ({} as A));
    } catch (e) {
      return bad(e);
    }
    try {
      return await json(args);
    } catch (e) {
      return browseErrorOf(e);
    }
  };

  reg(BAR_COMMANDS.wikiList, read("list", wikiArgs.list));
  reg(BAR_COMMANDS.wikiTree, read("tree", wikiArgs.tree));
  reg(BAR_COMMANDS.wikiPage, read("page", wikiArgs.page));
  reg(BAR_COMMANDS.wikiTemplates, read("templates", wikiArgs.templates));
  reg(BAR_COMMANDS.wikiMovePlan, read("movePlan", wikiArgs.movePlan));
  reg(BAR_COMMANDS.wikiHistory, read("history", wikiArgs.history));
  reg(BAR_COMMANDS.wikiRevisionDiff, read("diff", wikiArgs.revisionDiff));
  reg(BAR_COMMANDS.wikiSearch, read("search", wikiArgs.search));
  reg(BAR_COMMANDS.wikiAttachment, read("attachment", wikiArgs.attachment));
  reg(BAR_COMMANDS.wikiPublish, write<PublishArg>("publish"));
  reg(BAR_COMMANDS.wikiCreate, write<CreateArg>("create"));
  reg(BAR_COMMANDS.wikiMove, write<MoveArg>("move"));
  reg(BAR_COMMANDS.wikiUpload, once(wikiArgs.upload));
  reg(BAR_COMMANDS.wikiDelete, once(wikiArgs.delete));
  reg(BAR_COMMANDS.wikiAskAgent, async (a?: AskArg) => {
    if (!a?.project || !a.wiki || !a.path) return bad(new Error("wikiAskAgent needs { project, wiki, path }"));
    await toChat(askText(a));
    return { ok: true };
  });
  reg(BAR_COMMANDS.wikiUpdateFromBranch, async (a?: UpdateFromBranchArg) => {
    if (!a?.project || !a.wiki) return bad(new Error("wikiUpdateFromBranch needs { project, wiki }"));
    await toChat(updateFromBranchText(a));
    return { ok: true };
  });
  // after az login or an update of the CLI: the remembered failures go
  reg(BAR_COMMANDS.wikiRetryNow, () => {
    memo.forget();
    return { ok: true };
  });
}
