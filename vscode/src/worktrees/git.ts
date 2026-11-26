import { trackedExecFile } from "../perf/probe";
import { gitEnvironment } from "../../../cli/src/lib/gitEnv";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  spawnError?: string;
}

export type Git = (args: string[], cwd: string) => Promise<GitResult>;

/**
 * At most `max` git processes at a time; the rest wait in order. On a machine where antivirus makes every process
 * start cost ~200 ms, unlimited parallel reads pushed each other out (a work laptop logged 1519 git starts in one
 * minute and reads of 2 minutes).
 */
export function limitGit(git: Git, max: number): Git {
  let running = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    if (running >= max || !queue.length) return;
    running++;
    queue.shift()!();
  };
  return (args, cwd) =>
    new Promise<GitResult>((resolve) => {
      queue.push(() =>
        git(args, cwd).then((r) => {
          running--;
          resolve(r);
          next();
        }),
      );
      next();
    });
}

/** All git processes of the extension share this limit (Worktree Sets, the Branch menu). */
export const GIT_MAX_PARALLEL = 2;
let shared: Git | undefined;

export function createGit(gitPath = "git", log?: (line: string) => void): Git {
  const raw = spawnGit(gitPath, log);
  // one queue for every createGit of the default git, so two views cannot each start two
  if (gitPath === "git") return (shared ??= limitGit(raw, GIT_MAX_PARALLEL));
  return limitGit(raw, GIT_MAX_PARALLEL);
}

function spawnGit(gitPath: string, log?: (line: string) => void): Git {
  return (args, cwd) =>
    new Promise<GitResult>((resolve) => {
      log?.(`git ${args.join(" ")} (${cwd})`);
      try {
        trackedExecFile(
          gitPath,
          args,
          {
            cwd,
            windowsHide: true,
            maxBuffer: 16 * 1024 * 1024,
            timeout: 120_000,
            env: gitEnvironment(process.env, { GIT_TERMINAL_PROMPT: "0" }),
          },
          (error, stdout, stderr) => {
            const out = String(stdout ?? "");
            const err = String(stderr ?? "");
            if (!error) {
              resolve({ code: 0, stdout: out, stderr: err });
              return;
            }
            const e = error as NodeJS.ErrnoException & { code?: number | string };
            if (typeof e.code === "number") {
              log?.(`git exited with code ${e.code}: ${err.trim().split(/\r?\n/)[0] ?? ""}`);
              resolve({ code: e.code, stdout: out, stderr: err });
              return;
            }
            const spawnError = String(e.code ?? e.message ?? "UNKNOWN");
            log?.(`git failed to run: ${spawnError}`);
            resolve({ code: -1, stdout: out, stderr: err || e.message, spawnError });
          },
        );
      } catch (e) {
        const spawnError = String((e as NodeJS.ErrnoException).code ?? (e as Error).message);
        log?.(`git failed to run: ${spawnError}`);
        resolve({ code: -1, stdout: "", stderr: (e as Error).message, spawnError });
      }
    });
}
