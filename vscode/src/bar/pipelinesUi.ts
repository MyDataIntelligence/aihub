import { homedir } from "node:os";
import * as vscode from "vscode";
import { openFacts } from "./engine";
import { cli, jsonOf } from "./runner";
import { errorOf, fixText, logArgs, PipelineMemo, placeOf, removeRerunFile, rerunFile, runIdOf, runsArgs, type LogArg, type PipelineError, type RerunArg, type RunArg, type RunsArg } from "./pipelines";
import { BAR_COMMANDS } from "./types";

/** The repository folders of this window (a set: all of them), from files only. */
const windowDirs = (): string[] => {
  const f = openFacts(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
  return f.set ? f.set.repos.map((r) => r.path) : f.repo ? [f.repo.path] : [];
};

const noRun = (): PipelineError => ({ error: { kind: "failed", message: "no run id given ({ run: <id> })" } });
const noRepo = (): PipelineError => ({ error: { kind: "notARepository", message: "no repository in this window and no project given ({ run, project })" } });

/** Registers the aihub.bar.pipeline* commands; `reg` is the bar's registration (one error path for all). */
export function registerPipelineCommands(reg: (id: string, f: (...a: any[]) => unknown) => void, toChat: (text: string) => Promise<void> | void): void {
  const memo = new PipelineMemo();
  const json = async (args: string[], cwd: string) => jsonOf<unknown>(await cli(args, cwd));
  // a lasting failure (signed out, CLI too old) is the same for every read of that folder or project: remembered per place
  const read = (name: string, args: string[], p: { cwd: string; key: string }) => memo.read(`${name}|${p.key}|${args.join(" ")}`, () => json(args, p.cwd), p.key);
  const act = async (args: string[], cwd: string) => {
    try {
      return await json(args, cwd);
    } catch (e) {
      return errorOf(e);
    }
  };
  /** run id and place (repository folder, or project without a clone), or the error to answer with */
  const target = (a: RunArg | undefined): { run: number; place: NonNullable<ReturnType<typeof placeOf>> } | PipelineError => {
    const run = runIdOf(a);
    if (!run) return noRun();
    const place = placeOf(a, windowDirs(), homedir());
    return place ? { run, place } : noRepo();
  };
  const isError = (x: unknown): x is PipelineError => !!x && typeof x === "object" && "error" in x;

  reg(BAR_COMMANDS.pipelineRuns, (a: RunsArg = {}) => {
    const dirs = a.repoDirs?.length ? a.repoDirs : windowDirs();
    if (!dirs.length) return noRepo();
    return read("runs", runsArgs(a, dirs), { cwd: dirs[0], key: dirs[0] });
  });
  reg(BAR_COMMANDS.pipelineRun, (a?: RunArg) => {
    const t = target(a);
    return isError(t) ? t : read("run", ["pipeline", "show", "--run", String(t.run), ...t.place.extra], t.place);
  });
  reg(BAR_COMMANDS.pipelineStatus, (a?: RunArg) => {
    const t = target(a);
    return isError(t) ? t : read("status", ["pipeline", "poll", "--run", String(t.run), ...t.place.extra], t.place);
  });
  reg(BAR_COMMANDS.pipelineLog, (a?: LogArg) => {
    const t = target(a);
    return isError(t) ? t : read("log", [...logArgs({ ...a!, run: t.run }), ...t.place.extra], t.place);
  });
  reg(BAR_COMMANDS.pipelineRerunPlan, (a?: RunArg) => {
    const t = target(a);
    return isError(t) ? t : read("plan", ["pipeline", "run-again", "--run", String(t.run), "--plan", ...t.place.extra], t.place);
  });
  reg(BAR_COMMANDS.pipelineRerun, async (a?: RerunArg) => {
    const t = target(a);
    if (isError(t)) return t;
    const { args, file } = rerunFile({ ...a!, run: t.run });
    try {
      return await act([...args, ...t.place.extra], t.place.cwd);
    } finally {
      removeRerunFile(file);
    }
  });
  reg(BAR_COMMANDS.pipelineRerunFailed, (a?: RunArg & { stage?: string }) => {
    const t = target(a);
    return isError(t) ? t : act(["pipeline", "retry", "--run", String(t.run), ...(a?.stage ? ["--stage", a.stage] : []), "--json", ...t.place.extra], t.place.cwd);
  });
  reg(BAR_COMMANDS.pipelineCancel, (a?: RunArg) => {
    const t = target(a);
    return isError(t) ? t : act(["pipeline", "cancel", "--run", String(t.run), "--json", ...t.place.extra], t.place.cwd);
  });
  reg(BAR_COMMANDS.pipelineFix, async (a?: RunArg & { pipeline?: string; branch?: string }) => {
    const run = runIdOf(a);
    if (!run) return noRun();
    await toChat(fixText({ run, pipeline: a?.pipeline, branch: a?.branch }));
    return { ok: true };
  });
  // after az login or an update of the CLI: the remembered failures go
  reg(BAR_COMMANDS.pipelineRetryNow, () => {
    memo.forget();
    return { ok: true };
  });
}
