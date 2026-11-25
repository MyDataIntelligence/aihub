import * as vscode from "vscode";
import { makeRunner } from "../cli";

/** `aihub` run with a long limit, never asking for a sign-in window: every action of the buttons goes through it. */
export const runner = () =>
  makeRunner({ command: String(vscode.workspace.getConfiguration("aihub").get("cliPath", "aihub")) || "aihub", timeoutMs: 180_000, env: { GCM_INTERACTIVE: "never", GIT_TERMINAL_PROMPT: "0" } });

export const cli = (args: string[], cwd: string): Promise<string> => runner()(args, cwd);

/** The JSON object in a CLI answer (text before it, such as a warning line, is skipped). */
export const jsonOf = <T>(out: string): T => JSON.parse(out.slice(out.indexOf("{"))) as T;
