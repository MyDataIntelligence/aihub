import { homedir } from "node:os";
import { join } from "node:path";

export type Client = "opencode" | "github-copilot" | "codex";
export const CLIENTS: Client[] = ["opencode", "github-copilot", "codex"];

export interface ClientDirs {
  skills: string;
  /** Slash command / prompt directory and which bundled command set feeds it; absent when the client has none in this scope. */
  commands?: { dir: string; source: "opencode" | "copilot" };
  /** Folder for the optional aihub agents and which bundled agent set feeds it; absent for clients without agent files (Codex). */
  agents?: { dir: string; source: "opencode" | "copilot" };
}

const home = (env: NodeJS.ProcessEnv): string => env.HOME || env.USERPROFILE || homedir();

/** Global (per user) or project (inside `root`) locations of a client. Environment overrides come from `env`. */
export function clientDirs(client: Client, env: NodeJS.ProcessEnv, opts: { global: boolean; root?: string }): ClientDirs {
  if (opts.global) {
    if (client === "opencode") {
      const base = env.OPENCODE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home(env), ".config"), "opencode");
      return { skills: join(base, "skills"), commands: { dir: join(base, "command"), source: "opencode" }, agents: { dir: join(base, "agents"), source: "opencode" } };
    }
    if (client === "codex") {
      const base = env.CODEX_HOME || join(home(env), ".codex");
      return { skills: join(base, "skills"), commands: { dir: join(base, "prompts"), source: "opencode" } };
    }
    const copilot = env.COPILOT_HOME || join(home(env), ".copilot");
    return { skills: join(copilot, "skills"), agents: { dir: join(copilot, "agents"), source: "copilot" } };
  }
  const root = opts.root ?? ".";
  if (client === "opencode") {
    return { skills: join(root, ".opencode", "skills"), commands: { dir: join(root, ".opencode", "command"), source: "opencode" }, agents: { dir: join(root, ".opencode", "agents"), source: "opencode" } };
  }
  if (client === "github-copilot") {
    return { skills: join(root, ".github", "skills"), commands: { dir: join(root, ".github", "prompts"), source: "copilot" }, agents: { dir: join(root, ".github", "agents"), source: "copilot" } };
  }
  return { skills: join(root, ".agents", "skills") };
}
