import * as vscode from "vscode";
import { makeRunner, type Runner } from "../cli";
import { ensureCli, type CliMemo } from "./cliCheck";

const memos = new Map<string, CliMemo>();

/**
 * `aihub` run with a long limit, never asking for a sign-in window: every action of the buttons goes through it. The
 * first call reads the CLI version once (remembered, no process per click) and throws a CliProblem with a plain
 * sentence when the CLI is missing or too old, instead of the CLI's usage text.
 */
export const runner = (): Runner => {
  const command = String(vscode.workspace.getConfiguration("aihub").get("cliPath", "aihub")) || "aihub";
  const raw = makeRunner({ command, timeoutMs: 180_000, env: { GCM_INTERACTIVE: "never", GIT_TERMINAL_PROMPT: "0" } });
  const memo = memos.get(command) ?? memos.set(command, {}).get(command)!;
  return async (args, cwd) => {
    await ensureCli(raw, cwd, memo);
    return raw(args, cwd);
  };
};

export const cli = (args: string[], cwd: string): Promise<string> => runner()(args, cwd);

/** The JSON object in a CLI answer (text before it, such as a warning line, is skipped). */
export const jsonOf = <T>(out: string): T => JSON.parse(out.slice(out.indexOf("{"))) as T;
