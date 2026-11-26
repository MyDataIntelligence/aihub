import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * "Pipelines in the bar": the aihub.bar.pipeline* commands. Each one is one `aihub pipeline ...` process in the repository's
 * folder and answers with the CLI's JSON, or with `{ error: { kind, message } }` (never a popup: the bar shows it). A failure
 * that stays true for a while (not signed in, CLI missing or too old) is remembered for minutes per command and folder, so
 * the bar's 15 s timer does not start a process that cannot succeed. Two identical reads at the same moment share one process.
 * Nothing here runs at activation. The JSON shapes are in docs/cli-json.md ("Pipelines in the bar").
 */

export type PipelineErrorKind = "signedOut" | "cliMissing" | "cliTooOld" | "notARepository" | "failed";

export interface PipelineError {
  error: { kind: PipelineErrorKind; message: string };
}

export const PIPELINE_UPDATE_COMMAND = "npm i -g @ferronhooi/aihub@next";

/** What kind of failure a CLI error text is; the kinds other than "failed" are remembered. */
export function classify(message: string, cliKind?: string): PipelineErrorKind {
  if (cliKind === "missing") return "cliMissing";
  if (cliKind === "old" || /usage: aihub pipeline|unknown option|Unknown option '--(plan|repo-dir|mine|today|from-line|changes-file)'/i.test(message)) return "cliTooOld";
  if (/not signed in|az login|AIHUB_ADO_PAT|\(401\)/i.test(message)) return "signedOut";
  if (/not inside a git repository|not a git repository|not an Azure DevOps remote/i.test(message)) return "notARepository";
  return "failed";
}

export function errorOf(e: unknown): PipelineError {
  const err = e as { message?: string; kind?: string };
  const raw = String(err?.message ?? e).replace(/^aihub:\s*/, "").trim();
  const kind = classify(raw, err?.kind);
  const message =
    kind === "cliTooOld" ? `This needs a newer aihub CLI with pipeline support. Update it with: ${PIPELINE_UPDATE_COMMAND}` : kind === "signedOut" ? "Not signed in to Azure DevOps: run az login (or set AIHUB_ADO_PAT)." : raw;
  return { error: { kind, message } };
}

export const REMEMBER_FAILURE_MS = 5 * 60_000;

/** Remembers the lasting failures per key and shares a read that is still running. */
export class PipelineMemo {
  private failed = new Map<string, { at: number; value: PipelineError }>();
  private running = new Map<string, Promise<unknown>>();

  constructor(private readonly now: () => number = Date.now) {}

  async read<T>(key: string, work: () => Promise<T>, failKey = key): Promise<T | PipelineError> {
    const f = this.failed.get(failKey);
    if (f && this.now() - f.at < REMEMBER_FAILURE_MS) return f.value;
    const busy = this.running.get(key);
    if (busy) return busy as Promise<T | PipelineError>;
    const p = (async () => {
      try {
        const v = await work();
        this.failed.delete(failKey);
        return v;
      } catch (e) {
        const out = errorOf(e);
        if (out.error.kind !== "failed") this.failed.set(failKey, { at: this.now(), value: out });
        return out;
      } finally {
        this.running.delete(key);
      }
    })();
    this.running.set(key, p);
    return p;
  }

  /** after az login or an update: try again at once */
  forget(): void {
    this.failed.clear();
  }
}

// ---- arguments ---------------------------------------------------------------------------------------------------

export interface RunsArg {
  /** repository folders (a set: all of them); default: the repositories of this window */
  repoDirs?: string[];
  /** default true: runs I started */
  mine?: boolean;
  today?: boolean;
  status?: "running" | "queued" | "failed" | "succeeded" | "canceled";
  branch?: string;
  top?: number;
}

export interface RunArg {
  run: number;
  /** the repository the run belongs to (RunRow.repoDir); default: the first repository of this window */
  repoDir?: string;
}

export interface LogArg extends RunArg {
  /** step id (from pipelineRun) or name; default: the failed step */
  step?: string;
  tail?: number;
  fromLine?: number;
}

export interface RerunArg extends RunArg {
  commit?: "same" | "latest";
  /** only what the user changed */
  parameters?: Record<string, string | number | boolean>;
  /** only what the user changed; a secret only when the user typed a value */
  variables?: Record<string, string>;
  skipStages?: string[];
}

const posInt = (n: unknown): number | undefined => (typeof n === "number" && Number.isInteger(n) && n > 0 ? n : typeof n === "string" && /^\d+$/.test(n) ? Number(n) : undefined);

export function runsArgs(a: RunsArg, dirs: string[]): string[] {
  const out = ["pipeline", "list"];
  if (a.mine !== false) out.push("--mine");
  if (a.today) out.push("--today");
  if (a.status) out.push("--status", a.status);
  if (a.branch) out.push("--branch", a.branch);
  const top = posInt(a.top);
  if (top) out.push("--top", String(top));
  for (const d of dirs) out.push("--repo-dir", d);
  return out;
}

export function logArgs(a: LogArg): string[] {
  const out = ["pipeline", "log", "--run", String(a.run)];
  if (a.step) out.push("--step", a.step);
  const tail = posInt(a.tail);
  if (tail) out.push("--tail", String(tail));
  const from = posInt(a.fromLine);
  if (from) out.push("--from-line", String(from));
  return out;
}

/** The changes go in a file (a secret never shows in the process list); the caller removes it right after the call. */
export function rerunFile(a: RerunArg): { args: string[]; file?: string } {
  const args = ["pipeline", "run-again", "--run", String(a.run)];
  if (a.commit) args.push("--commit", a.commit);
  const changes: Record<string, unknown> = {};
  if (a.parameters && Object.keys(a.parameters).length) changes.parameters = a.parameters;
  const vars = Object.fromEntries(Object.entries(a.variables ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  if (Object.keys(vars).length) changes.variables = vars;
  if (a.skipStages?.length) changes.skipStages = a.skipStages;
  if (!Object.keys(changes).length) return { args };
  const dir = mkdtempSync(join(tmpdir(), "aihub-rerun-"));
  const file = join(dir, "changes.json");
  writeFileSync(file, JSON.stringify(changes), { encoding: "utf8", mode: 0o600 });
  args.push("--changes-file", file);
  return { args, file };
}

export function removeRerunFile(file: string | undefined): void {
  if (!file) return;
  try {
    rmSync(join(file, ".."), { recursive: true, force: true });
  } catch {
    /* the temp folder is cleaned by the OS */
  }
}

/** The text "Fix with Agent" puts in the chat (the pipeline-fix skill); the user presses Enter. */
export function fixText(a: { run: number; pipeline?: string; branch?: string }): string {
  const what = [a.pipeline, a.branch ? `on ${a.branch}` : ""].filter(Boolean).join(" ");
  return `Use the pipeline-fix skill to fix the failed run ${a.run}${what ? ` (${what})` : ""}: start with aihub pipeline logs --failed --run ${a.run}.`;
}

/** The first number in a run argument (`{ run: 2046 }`, `"2046"`, a build link). */
export function runIdOf(a: unknown): number | undefined {
  if (a && typeof a === "object" && "run" in a) return runIdOf((a as { run: unknown }).run);
  if (typeof a === "number") return posInt(a);
  if (typeof a === "string") return posInt(a) ?? posInt(/[?&]buildId=(\d+)/.exec(a)?.[1]);
  return undefined;
}
