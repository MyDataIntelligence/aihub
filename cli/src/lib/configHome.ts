import { homedir } from "node:os";
import { join } from "node:path";

/** The user's own aihub config folder (never inside a work repository). Node only: the VS Code extension bundles this file as it is. */
export const configHome = (env: NodeJS.ProcessEnv): string => env.AIHUB_CONFIG_HOME || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "aihub");
