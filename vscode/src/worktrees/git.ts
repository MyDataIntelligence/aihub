import { execFile } from "child_process";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  spawnError?: string;
}

export type Git = (args: string[], cwd: string) => Promise<GitResult>;

export function createGit(gitPath = "git", log?: (line: string) => void): Git {
  return (args, cwd) =>
    new Promise<GitResult>((resolve) => {
      log?.(`git ${args.join(" ")} (${cwd})`);
      try {
        execFile(
          gitPath,
          args,
          {
            cwd,
            windowsHide: true,
            maxBuffer: 16 * 1024 * 1024,
            timeout: 120_000,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
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
