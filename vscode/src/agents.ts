import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The agent files `aihub skills install` writes: ~/.copilot/agents (COPILOT_HOME moves it) or .github/agents in the repo. */
export function copilotAgentFiles(name: string, repoRoot: string | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  const file = `${name}.agent.md`;
  return [...(repoRoot ? [join(repoRoot, ".github", "agents", file)] : []), join(env.COPILOT_HOME || join(homedir(), ".copilot"), "agents", file)];
}

export const copilotAgentInstalled = (name: string, repoRoot: string | undefined, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): boolean =>
  copilotAgentFiles(name, repoRoot, env).some(exists);

export interface ChatOpenArgs {
  query: string;
  isPartialQuery: true;
  mode?: string;
}

/** The argument of workbench.action.chat.open: the text goes in the input (not sent) with the aihub agent selected when it is installed. */
export function chatOpenArgs(text: string, o: { agentName: string; agentInstalled: boolean; agentMode: boolean }): ChatOpenArgs {
  const base: ChatOpenArgs = { query: text, isPartialQuery: true };
  if (o.agentInstalled && o.agentName) return { ...base, mode: o.agentName };
  return o.agentMode ? { ...base, mode: "agent" } : base;
}
