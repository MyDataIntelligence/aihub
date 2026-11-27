import { homedir } from "node:os";
import * as vscode from "vscode";
import { cli, jsonOf } from "./runner";
import { browseErrorOf, BrowseMemo, removePushFiles, type BrowseError } from "./browse";
import { teamArgs, type TeamCommon } from "./team";
import { BAR_COMMANDS } from "./types";

const cwdOf = (a?: TeamCommon): string => (typeof a?.cwd === "string" && a.cwd ? a.cwd : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir());
const bad = (e: unknown): BrowseError => ({ error: { kind: "badInput", message: (e as Error).message } });

/**
 * Registers the aihub.bar.team* commands (Team settings page, editor, preview, setup). Reads share a running process;
 * the lasting failures (CLI missing or too old, not signed in) are remembered 5 minutes. Writes are never shared.
 * Nothing runs at activation, nothing polls.
 */
export function registerTeamCommands(reg: (id: string, f: (...a: any[]) => unknown) => void): void {
  const memo = new BrowseMemo();
  const run = <A extends TeamCommon>(build: (a: A) => { args: string[]; dir?: string }, shared: boolean) => async (a: A) => {
    let b: { args: string[]; dir?: string };
    try {
      b = build((a ?? {}) as A);
    } catch (e) {
      return bad(e);
    }
    const work = async () => {
      try {
        return jsonOf<unknown>(await cli(b.args, cwdOf(a)));
      } finally {
        removePushFiles(b.dir);
      }
    };
    if (shared) return memo.read(`${cwdOf(a)}\u0000${b.args.join("\u0000")}`, `team|${cwdOf(a)}`.toLowerCase(), work);
    try {
      return await work();
    } catch (e) {
      return browseErrorOf(e);
    }
  };
  reg(BAR_COMMANDS.teamShow, run(teamArgs.show, true));
  reg(BAR_COMMANDS.teamSchema, run(teamArgs.schema, true));
  // a check of the text being typed: never shared (each text is different), never remembered
  reg(BAR_COMMANDS.teamValidate, run(teamArgs.validate, false));
  reg(BAR_COMMANDS.teamPreview, run(teamArgs.preview, true));
  reg(BAR_COMMANDS.teamEdit, run(teamArgs.edit, false));
  reg(BAR_COMMANDS.teamInit, run(teamArgs.init, false));
}
