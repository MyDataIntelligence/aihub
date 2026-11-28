import { spawn, type ChildProcess } from "node:child_process";
import { killTree } from "../cli";

/**
 * Search Everywhere over Azure DevOps (`aihub.bar.searchAll`): one `aihub search all <text> --stream --json` process per
 * search. Each kind (repositories, files, text, branches, work items, pull requests, wiki, pipelines) arrives as one
 * `{"part":{...}}` line on stderr as soon as it is ready, so the popup fills group by group. Only one search runs: a newer
 * search stops the older process (the user typed on). The JSON shape is in docs/cli-json.md ("Search Everywhere").
 */

export const SEARCH_ALL_KINDS = ["repos", "files", "text", "branches", "workitems", "prs", "wiki", "pipelines"] as const;
export type SearchAllKind = (typeof SEARCH_ALL_KINDS)[number];

export interface SearchAllArg {
  text: string;
  kinds?: SearchAllKind[];
  top?: number;
  project?: string;
  org?: string;
  refresh?: boolean;
  /** a command of the caller, run with `{ text, part }` for every kind as soon as it is ready */
  onPart?: string;
}

export function searchAllArgs(a: SearchAllArg): string[] {
  const text = typeof a?.text === "string" ? a.text.trim() : "";
  if (!text) throw new Error("a search text is needed ({ text })");
  const out = ["search", "all", "--text", text];
  const kinds = (a.kinds ?? []).filter((k) => (SEARCH_ALL_KINDS as readonly string[]).includes(k));
  if (kinds.length) out.push("--kinds", kinds.join(","));
  if (a.top) out.push("--top", String(a.top));
  if (a.project) out.push("--project", a.project);
  if (a.org) out.push("--org", a.org);
  if (a.refresh) out.push("--refresh");
  out.push("--stream", "--json");
  return out;
}

/** The parts in a piece of stderr (one JSON line each: {"part":{...}}); other lines are skipped. */
export function partLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const l of text.split(/\r?\n/)) {
    if (!l.startsWith('{"part"')) continue;
    try {
      out.push((JSON.parse(l) as { part: unknown }).part);
    } catch {
      /* a cut line */
    }
  }
  return out;
}

export interface Streamed {
  done: Promise<{ code: number; stdout: string; stderr: string; stopped: boolean }>;
  stop(): void;
}

/** One aihub process whose stderr is read while it runs: the same command as the other calls, through a shell on Windows for the npm .cmd shim. */
export function streamCli(command: string, args: string[], cwd: string, onErr: (lines: string) => void, spawnFn: typeof spawn = spawn): Streamed {
  const shell = process.platform === "win32" && !/\.(exe|com)$/i.test(command);
  const q = (x: string) => (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(x) ? x : `"${x.replace(/"/g, '\\"')}"`);
  let child: ChildProcess | undefined;
  let stopped = false;
  const done = new Promise<{ code: number; stdout: string; stderr: string; stopped: boolean }>((resolve) => {
    const p = spawnFn(shell ? q(command) : command, shell ? args.map(q) : args, { cwd, shell, windowsHide: true, env: { ...process.env, GCM_INTERACTIVE: "never", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" } });
    child = p;
    let stdout = "";
    let stderr = "";
    let pending = "";
    p.stdout?.on("data", (b: Buffer) => (stdout += b.toString()));
    p.stderr?.on("data", (b: Buffer) => {
      const text = pending + b.toString();
      const cut = text.lastIndexOf("\n");
      pending = cut >= 0 ? text.slice(cut + 1) : text;
      if (cut >= 0 && !stopped) onErr(text.slice(0, cut));
      stderr += b.toString();
    });
    p.on("error", (e) => resolve({ code: 1, stdout, stderr: `${stderr}\n${e.message}`, stopped }));
    p.on("close", (code) => {
      if (pending && !stopped) onErr(pending);
      resolve({ code: code ?? 1, stdout, stderr, stopped });
    });
  });
  return {
    done,
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (child) killTree(child);
    },
  };
}

/** Only the newest search runs: starting one stops the one before. */
export class LatestOnly {
  private current: Streamed | undefined;

  start(s: Streamed): Streamed {
    this.current?.stop();
    this.current = s;
    void s.done.finally(() => {
      if (this.current === s) this.current = undefined;
    });
    return s;
  }

  stop(): void {
    this.current?.stop();
    this.current = undefined;
  }
}
