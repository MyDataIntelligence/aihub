import { spawnSync } from "./proc.js";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Client = "opencode" | "github-copilot" | "codex" | "claude";
export const CLIENTS: Client[] = ["opencode", "github-copilot", "codex", "claude"];
/** What `--client all` (and no flag) means. Claude Code is explicit: opencode also reads ~/.claude/skills, which would list every skill twice. */
export const DEFAULT_CLIENTS: Client[] = ["opencode", "github-copilot", "codex"];

/** Which bundled agent set feeds a folder: opencode 1.x (`agent/`, `permission` map), opencode 2.x (`agents/`, `permissions` list), Copilot, Codex (TOML) or Claude Code. */
export type AgentSource = "opencode" | "opencode2" | "copilot" | "codex" | "claude";

export interface ClientDirs {
  skills: string;
  /** Slash command / prompt directory and which bundled command set feeds it; absent when the client has none in this scope. */
  commands?: { dir: string; source: "opencode" | "copilot" };
  /** Folder for the optional aihub agents; `other` is the folder of the other opencode format, cleaned up when the format changes. */
  agents?: { dir: string; source: AgentSource; other?: string };
}

const home = (env: NodeJS.ProcessEnv): string => env.HOME || env.USERPROFILE || homedir();

let probed: string | undefined;

/** The installed opencode version: AIHUB_OPENCODE_VERSION (tests, overrides) or `opencode --version`; undefined when opencode is not installed. */
export function opencodeVersion(env: NodeJS.ProcessEnv): string | undefined {
  if (env.AIHUB_OPENCODE_VERSION !== undefined) return env.AIHUB_OPENCODE_VERSION || undefined;
  if (probed === undefined) {
    const r = spawnSync("opencode", ["--version"], { encoding: "utf8", timeout: 8000, shell: process.platform === "win32" });
    probed = r.status === 0 ? (/\d+\.\d+\.\d+\S*/.exec(r.stdout ?? "")?.[0] ?? "") : "";
  }
  return probed || undefined;
}

/** opencode 1.x reads `agent/` with a `permission` map; 2.x prefers `agents/` with a `permissions` list. Unknown (not installed) gets 1.x, which 2.x still translates. */
export function opencodeAgentSource(env: NodeJS.ProcessEnv): "opencode" | "opencode2" {
  const major = Number(/^v?(\d+)/.exec(opencodeVersion(env) ?? "")?.[1]);
  return major >= 2 ? "opencode2" : "opencode";
}

function opencodeAgents(base: string, env: NodeJS.ProcessEnv): NonNullable<ClientDirs["agents"]> {
  const v2 = opencodeAgentSource(env) === "opencode2";
  return { dir: join(base, v2 ? "agents" : "agent"), source: v2 ? "opencode2" : "opencode", other: join(base, v2 ? "agent" : "agents") };
}

/**
 * The user prompt-file folder of VS Code (Copilot Chat reads `*.prompt.md` there as slash commands in every workspace):
 * AIHUB_VSCODE_USER_DIR, else the `User` folder of VS Code's user data (Windows %APPDATA%\Code\User, macOS ~/Library/Application
 * Support/Code/User, Linux ~/.config/Code/User). Undefined when that folder does not exist (VS Code not installed for this user).
 */
export function vscodeUserPrompts(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string | undefined {
  const user =
    env.AIHUB_VSCODE_USER_DIR ||
    (platform === "win32"
      ? env.APPDATA
        ? join(env.APPDATA, "Code", "User")
        : undefined
      : platform === "darwin"
        ? join(home(env), "Library", "Application Support", "Code", "User")
        : join(env.XDG_CONFIG_HOME || join(home(env), ".config"), "Code", "User"));
  return user && existsSync(user) ? join(user, "prompts") : undefined;
}

/** Global (per user) or project (inside `root`) locations of a client. Environment overrides come from `env`. */
export function clientDirs(client: Client, env: NodeJS.ProcessEnv, opts: { global: boolean; root?: string }): ClientDirs {
  if (opts.global) {
    if (client === "opencode") {
      const base = env.OPENCODE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home(env), ".config"), "opencode");
      return { skills: join(base, "skills"), commands: { dir: join(base, "command"), source: "opencode" }, agents: opencodeAgents(base, env) };
    }
    if (client === "codex") {
      const base = env.CODEX_HOME || join(home(env), ".codex");
      return { skills: join(base, "skills"), commands: { dir: join(base, "prompts"), source: "opencode" }, agents: { dir: join(base, "agents"), source: "codex" } };
    }
    if (client === "claude") {
      const base = env.CLAUDE_CONFIG_DIR || join(home(env), ".claude");
      return { skills: join(base, "skills"), commands: { dir: join(base, "commands"), source: "opencode" }, agents: { dir: join(base, "agents"), source: "claude" } };
    }
    const copilot = env.COPILOT_HOME || join(home(env), ".copilot");
    // the slash commands (/story-run, /pr, ...) are prompt files in VS Code's user profile; only when VS Code is there
    const prompts = vscodeUserPrompts(env);
    return { skills: join(copilot, "skills"), ...(prompts ? { commands: { dir: prompts, source: "copilot" as const } } : {}), agents: { dir: join(copilot, "agents"), source: "copilot" } };
  }
  const root = opts.root ?? ".";
  if (client === "opencode") {
    return { skills: join(root, ".opencode", "skills"), commands: { dir: join(root, ".opencode", "command"), source: "opencode" }, agents: opencodeAgents(join(root, ".opencode"), env) };
  }
  if (client === "github-copilot") {
    return { skills: join(root, ".github", "skills"), commands: { dir: join(root, ".github", "prompts"), source: "copilot" }, agents: { dir: join(root, ".github", "agents"), source: "copilot" } };
  }
  if (client === "claude") {
    return { skills: join(root, ".claude", "skills"), commands: { dir: join(root, ".claude", "commands"), source: "opencode" }, agents: { dir: join(root, ".claude", "agents"), source: "claude" } };
  }
  return { skills: join(root, ".agents", "skills"), agents: { dir: join(root, ".codex", "agents"), source: "codex" } };
}
