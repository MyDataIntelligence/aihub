import { CliError, INSTALL_COMMAND, versionAtLeast, type Runner } from "../cli";

/** The first aihub CLI that has every command the buttons call (`branch switch`, `worktree add|drop|repair|remove --folder`, `worktree list --all`, `recent`, `comments threads`, `pipeline list|show|log|poll|run-again`, `browse pipelines|run|artifacts|draft-*`, `pr create` that sets the upstream of a pushed branch). */
export const MIN_BAR_CLI = "1.9.0";

/** The CLI is missing or too old for the buttons: a plain sentence for the user, never the CLI's own usage text. */
export class CliProblem extends Error {
  constructor(
    readonly kind: "missing" | "old",
    message: string,
    readonly updateCommand: string = INSTALL_COMMAND,
  ) {
    super(message);
  }
}

export interface CliMemo {
  /** the version found, or the problem; remembered so a click never starts a process just to ask */
  seen?: { at: number; version?: string; problem?: CliProblem };
}

/** A good answer is kept for the whole session; a problem for two minutes (the user may update and try again). */
const PROBLEM_TTL_MS = 120_000;

/**
 * Reads `aihub --version` once and throws a CliProblem when the CLI is missing or older than `min`. Other failures
 * (a timeout) are not remembered and do not block: the action itself then reports its own error.
 */
export async function ensureCli(run: Runner, cwd: string, memo: CliMemo, o: { min?: string; now?: () => number } = {}): Promise<string | undefined> {
  const min = o.min ?? MIN_BAR_CLI;
  const now = (o.now ?? Date.now)();
  const s = memo.seen;
  if (s && (!s.problem || now - s.at < PROBLEM_TTL_MS)) {
    if (s.problem) throw s.problem;
    return s.version;
  }
  let version: string | undefined;
  let problem: CliProblem | undefined;
  try {
    const out = (await run(["--version"], cwd)).trim();
    version = /\d+\.\d+\.\d+\S*/.exec(out)?.[0];
    if (version && !versionAtLeast(version, min)) problem = new CliProblem("old", `The aihub CLI on this PC is ${version}; the buttons need ${min} or newer. Update it with: ${INSTALL_COMMAND}`);
  } catch (e) {
    if (!(e instanceof CliError) || e.kind !== "missing") return undefined;
    problem = new CliProblem("missing", `The aihub CLI was not found on this PC; the buttons need ${min} or newer. Install it with: ${INSTALL_COMMAND}`);
  }
  memo.seen = { at: now, version, problem };
  if (problem) throw problem;
  return version;
}
