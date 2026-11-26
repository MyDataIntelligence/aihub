import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classify, errorOf, fixText, logArgs, PipelineMemo, REMEMBER_FAILURE_MS, removeRerunFile, rerunFile, runIdOf, runsArgs } from "../src/bar/pipelines";
import { BAR_COMMANDS } from "../src/bar/types";

describe("pipelines in the bar: arguments", () => {
  it("runs: mine by default, every repository of the set, filters", () => {
    expect(runsArgs({}, ["C:/s/repo-a", "C:/s/repo-b"])).toEqual(["pipeline", "list", "--mine", "--repo-dir", "C:/s/repo-a", "--repo-dir", "C:/s/repo-b"]);
    expect(runsArgs({ mine: false, today: true, status: "failed", branch: "feature/4711-x", top: 3 }, ["d"])).toEqual(["pipeline", "list", "--today", "--status", "failed", "--branch", "feature/4711-x", "--top", "3", "--repo-dir", "d"]);
    expect(runsArgs({ top: -1 }, [])).toEqual(["pipeline", "list", "--mine"]);
  });

  it("log: step, tail and the line to read from", () => {
    expect(logArgs({ run: 2046 })).toEqual(["pipeline", "log", "--run", "2046"]);
    expect(logArgs({ run: 2046, step: "Run pytest", tail: 500, fromLine: 312 })).toEqual(["pipeline", "log", "--run", "2046", "--step", "Run pytest", "--tail", "500", "--from-line", "312"]);
  });

  it("rerun: only the changes go in a private file, an empty secret is left out, the file is removed after", () => {
    expect(rerunFile({ run: 2046 })).toEqual({ args: ["pipeline", "run-again", "--run", "2046"] });
    const r = rerunFile({ run: 2046, commit: "latest", parameters: { runIntegration: true }, variables: { debugLogging: "true", DB_PASSWORD: "" }, skipStages: ["DeployDev"] });
    expect(r.args.slice(0, 6)).toEqual(["pipeline", "run-again", "--run", "2046", "--commit", "latest"]);
    expect(r.args[6]).toBe("--changes-file");
    expect(JSON.parse(readFileSync(r.file!, "utf8"))).toEqual({ parameters: { runIntegration: true }, variables: { debugLogging: "true" }, skipStages: ["DeployDev"] });
    removeRerunFile(r.file);
    expect(existsSync(r.file!)).toBe(false);
  });

  it("run ids from a number, text, an object or a build link", () => {
    expect(runIdOf({ run: 2046 })).toBe(2046);
    expect(runIdOf("2046")).toBe(2046);
    expect(runIdOf("https://dev.azure.com/ferron-test/test-project/_build/results?buildId=326&view=logs")).toBe(326);
    expect(runIdOf({ run: "x" })).toBeUndefined();
    expect(runIdOf(undefined)).toBeUndefined();
  });

  it("Fix with Agent: the pipeline-fix skill with the run", () => {
    expect(fixText({ run: 2046, pipeline: "orders-ci", branch: "feature/4711-x" })).toBe("Use the pipeline-fix skill to fix the failed run 2046 (orders-ci on feature/4711-x): start with aihub pipeline logs --failed --run 2046.");
  });

  it("every pipeline command is in the contract", () => {
    for (const id of ["pipelineRuns", "pipelineRun", "pipelineLog", "pipelineStatus", "pipelineRerunPlan", "pipelineRerun", "pipelineRerunFailed", "pipelineCancel", "pipelineFix", "pipelineRetryNow"]) expect((BAR_COMMANDS as Record<string, string>)[id]).toBe(`aihub.bar.${id}`);
  });
});

describe("pipelines in the bar: failures", () => {
  it("classifies the CLI's answers", () => {
    expect(classify("aihub: not signed in to Azure DevOps: run 'az login' or set AIHUB_ADO_PAT")).toBe("signedOut");
    expect(classify("aihub: usage: aihub pipeline follow|status|runs|logs|run|rerun|retry [flags]")).toBe("cliTooOld");
    expect(classify("x", "missing")).toBe("cliMissing");
    expect(classify("x", "old")).toBe("cliTooOld");
    expect(classify("C:/x is not inside a git repository")).toBe("notARepository");
    expect(classify("Azure DevOps: not found (404)")).toBe("failed");
    expect(errorOf(new Error("aihub: usage: aihub pipeline follow")).error.message).toContain("npm i -g @ferronhooi/aihub@next");
  });

  it("a lasting failure is remembered 5 minutes per folder; a passing one is not; two reads at once share one process", async () => {
    let t = 0;
    const memo = new PipelineMemo(() => t);
    let calls = 0;
    const signedOut = async () => {
      calls++;
      throw new Error("aihub: not signed in to Azure DevOps: run 'az login'");
    };
    expect(await memo.read("a", signedOut, "dir")).toMatchObject({ error: { kind: "signedOut" } });
    expect(await memo.read("b", signedOut, "dir")).toMatchObject({ error: { kind: "signedOut" } });
    expect(calls).toBe(1);
    t = REMEMBER_FAILURE_MS + 1;
    await memo.read("a", signedOut, "dir");
    expect(calls).toBe(2);
    memo.forget();
    let flaky = 0;
    const once = async () => {
      flaky++;
      throw new Error("Azure DevOps GET build/builds failed (500)");
    };
    await memo.read("c", once, "dir2");
    await memo.read("c", once, "dir2");
    expect(flaky).toBe(2);
    let n = 0;
    let release!: (v: unknown) => void;
    const slow = () => {
      n++;
      return new Promise((r) => (release = r));
    };
    const p1 = memo.read("d", slow);
    const p2 = memo.read("d", slow);
    release({ ok: 1 });
    expect(await p1).toEqual({ ok: 1 });
    expect(await p2).toEqual({ ok: 1 });
    expect(n).toBe(1);
  });
});
