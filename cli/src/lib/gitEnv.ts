/**
 * The environment of every git process aihub starts. Git variables that point git at another repository, index or object
 * store than the folder it runs in must never be inherited: a `git init` or `git clone` that runs inside a hook of a linked
 * worktree inherits GIT_DIR=<main>/.git/worktrees/<name> and then writes `core.bare = true` into the shared config of the
 * main clone ("fatal: this operation must be run in a work tree").
 */
export const REPOSITORY_VARIABLES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
] as const;

/**
 * `base` (default: the process environment) without the repository variables, then `explicit` on top: a variable aihub sets
 * on purpose (GIT_INDEX_FILE of a temporary index) survives.
 */
export function gitEnvironment(base: NodeJS.ProcessEnv = process.env, explicit: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const drop = new Set<string>(REPOSITORY_VARIABLES);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!drop.has(k.toUpperCase())) out[k] = v;
  return { ...out, ...explicit };
}

/** True when `command` (a program, or on a shell a whole command line) starts git. */
export function isGitCommand(command: unknown): boolean {
  return typeof command === "string" && /^\s*"?(?:.*[\\/])?git(?:\.exe)?"?(?:\s|$)/i.test(command);
}

/**
 * The options of a child-process call for git: the environment the caller gave (or the process environment) without the
 * repository variables, except those the caller set to a value different from the inherited one (set on purpose).
 */
export function scrubGitOptions(options: unknown): unknown {
  const o = (options && typeof options === "object" && !Array.isArray(options) ? options : {}) as { env?: NodeJS.ProcessEnv };
  const given = o.env ?? process.env;
  const explicit: Record<string, string | undefined> = {};
  for (const name of REPOSITORY_VARIABLES) {
    for (const [k, v] of Object.entries(given)) if (k.toUpperCase() === name && v !== undefined && v !== process.env[k]) explicit[k] = v;
  }
  return { ...o, env: gitEnvironment(given, explicit) };
}
