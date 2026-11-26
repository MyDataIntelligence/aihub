import * as vscode from "vscode";
import { openFacts } from "./engine";
import { cli, jsonOf } from "./runner";
import { errorOf, fixText, logArgs, PipelineMemo, removeRerunFile, rerunFile, runIdOf, runsArgs, type LogArg, type PipelineError, type RerunArg, type RunArg, type RunsArg } from "./pipelines";
import { BAR_COMMANDS } from "./types";

/** The repository folders of this window (a set: all of them), from files only. */
const windowDirs = (): string[] => {
  const f = openFacts(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
  return f.set ? f.set.repos.map((r) => r.path) : f.repo ? [f.repo.path] : [];
};

const noRun = (): PipelineError => ({ error: { kind: "failed", message: "no run id given ({ run: <id> })" } });
const noRepo = (): PipelineError => ({ error: { kind: "notARepository", message: "no repository in this window" } });

/** Registers the aihub.bar.pipeline* commands; `reg` is the bar's registration (one error path for all). */
export function registerPipelineCommands(reg: (id: string, f: (...a: any[]) => unknown) => void, toChat: (text: string) => Promise<void> | void): void {
  const memo = new PipelineMemo();
  const json = async (args: string[], cwd: string) => jsonOf<unknown>(await cli(args, cwd));
  const dirOf = (a?: { repoDir?: string }) => a?.repoDir || windowDirs()[0];
  // a lasting failure (signed out, CLI too old) is the same for every read of that folder: remembered per folder
  const read = (name: string, args: string[], cwd: string) => memo.read(`${name}|${cwd}|${args.join(" ")}`, () => json(args, cwd), cwd);
  const act = async (args: string[], cwd: string) => {
    try {
      return await json(args, cwd);
    } catch (e) {
      return errorOf(e);
    }
  };

  reg(BAR_COMMANDS.pipelineRuns, (a: RunsArg = {}) => {
    const dirs = a.repoDirs?.length ? a.repoDirs : windowDirs();
    if (!dirs.length) return noRepo();
    return read("runs", runsArgs(a, dirs), dirs[0]);
  });
  reg(BAR_COMMANDS.pipelineRun, (a?: RunArg) => {
    const run = runIdOf(a);
    const cwd = dirOf(a);
    if (!run) return noRun();
    return cwd ? read("run", ["pipeline", "show", "--run", String(run)], cwd) : noRepo();
  });
  reg(BAR_COMMANDS.pipelineStatus, (a?: RunArg) => {
    const run = runIdOf(a);
    const cwd = dirOf(a);
    if (!run) return noRun();
    return cwd ? read("status", ["pipeline", "poll", "--run", String(run)], cwd) : noRepo();
  });
  reg(BAR_COMMANDS.pipelineLog, (a?: LogArg) => {
    const run = runIdOf(a);
    const cwd = dirOf(a);
    if (!run || !a) return noRun();
    return cwd ? read("log", logArgs({ ...a, run }), cwd) : noRepo();
  });
  reg(BAR_COMMANDS.pipelineRerunPlan, (a?: RunArg) => {
    const run = runIdOf(a);
    const cwd = dirOf(a);
    if (!run) return noRun();
    return cwd ? read("plan", ["pipeline", "run-again", "--run", String(run), "--plan"], cwd) : noRepo();
  });
  reg(BAR_COMMANDS.pipelineRerun, async (a?: RerunArg) => {
    const run = runIdOf(a);
    const cwd = dirOf(a);
    if (!run || !a) return noRun();
    if (!cwd) return noRepo();
    const { args, file } = rerunFile({ ...a, run });
    try {
      return await act(args, cwd);
    } finally {
      removeRerunFile(file);
    }
  });
  reg(BAR_COMMANDS.pipelineRerunFailed, (a?: RunArg & { stage?: string }) => {
    const run = runIdOf(a);
    const cwd = dirOf(a);
    if (!run) return noRun();
    return cwd ? act(["pipeline", "retry", "--run", String(run), ...(a?.stage ? ["--stage", a.stage] : []), "--json"], cwd) : noRepo();
  });
  reg(BAR_COMMANDS.pipelineCancel, (a?: RunArg) => {
    const run = runIdOf(a);
    const cwd = dirOf(a);
    if (!run) return noRun();
    return cwd ? act(["pipeline", "cancel", "--run", String(run), "--json"], cwd) : noRepo();
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
