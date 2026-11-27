import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pipeBrowseArgs, pushFiles, removePushFiles, runFiles } from "../src/bar/browse";
import { BAR_COMMANDS } from "../src/bar/types";

describe("pipeline browser: arguments", () => {
  it("reads", () => {
    expect(pipeBrowseArgs.pipelines({ project: "test-project", refresh: true })).toEqual(["browse", "pipelines", "--project", "test-project", "--refresh"]);
    expect(pipeBrowseArgs.pipeline({ project: "test-project", pipeline: 21, top: 3 })).toEqual(["browse", "pipeline", "--project", "test-project", "--pipeline", "21", "--top", "3"]);
    expect(pipeBrowseArgs.runPlan({ project: "test-project", pipeline: 21, ref: "tag:v1" })).toEqual(["browse", "run-plan", "--project", "test-project", "--pipeline", "21", "--ref", "tag:v1"]);
    expect(pipeBrowseArgs.artifacts({ project: "test-project", run: 339 })).toEqual(["browse", "artifacts", "--project", "test-project", "--run", "339"]);
    expect(pipeBrowseArgs.artifactOpen({ project: "test-project", run: 339, artifact: "robot-report", path: "report.html" })).toEqual(["browse", "artifact-open", "--project", "test-project", "--run", "339", "--artifact", "robot-report", "--path", "report.html"]);
    expect(pipeBrowseArgs.drafts({ project: "test-project", org: "ferron-test" })).toEqual(["browse", "drafts", "--project", "test-project", "--org", "ferron-test"]);
    expect(() => pipeBrowseArgs.pipeline({ project: "test-project", pipeline: "x" as never })).toThrow(/must be a number/);
    expect(() => pipeBrowseArgs.artifactFiles({ project: "test-project", run: 1 } as never)).toThrow(/needs artifact/);
  });

  it("draft create and delete", () => {
    expect(pipeBrowseArgs.draftCreate({ project: "p", repo: "repo-a", name: "orders-ci-py312", branch: "feature/4711-draft-orders-ci-py312", fromPipeline: 7 })).toEqual(["browse", "draft-create", "--project", "p", "--repo", "repo-a", "--name", "orders-ci-py312", "--branch", "feature/4711-draft-orders-ci-py312", "--from-pipeline", "7"]);
    expect(pipeBrowseArgs.draftCreate({ project: "p", repo: "r", name: "x", branch: "b", empty: true }).slice(-1)).toEqual(["--empty"]);
    expect(() => pipeBrowseArgs.draftCreate({ project: "p", repo: "r", name: "x", branch: "b" })).toThrow(/fromPipeline or empty/);
    expect(pipeBrowseArgs.draftDelete({ project: "p", pipeline: 21 })).toEqual(["browse", "draft-delete", "--project", "p", "--pipeline", "21"]);
    expect(pipeBrowseArgs.draftDelete({ project: "p", pipeline: 21, keepBranch: true }).slice(-1)).toEqual(["--keep-branch"]);
  });

  it("run: the changes in a private file, an empty secret left out, removed after", () => {
    expect(runFiles({ project: "p", pipeline: 21, branch: "main" })).toEqual({ args: ["browse", "run", "--project", "p", "--pipeline", "21", "--branch", "main"] });
    const f = runFiles({ project: "p", pipeline: 21, tag: "v1", commit: "9c1f3ab", parameters: { runIntegration: true }, variables: { debugLogging: "true", DB_PASSWORD: "" }, skipStages: ["DeployAcc"] });
    expect(f.args.slice(0, 10)).toEqual(["browse", "run", "--project", "p", "--pipeline", "21", "--tag", "v1", "--commit", "9c1f3ab"]);
    const file = f.args[f.args.indexOf("--changes-file") + 1];
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ parameters: { runIntegration: true }, variables: { debugLogging: "true" }, skipStages: ["DeployAcc"] });
    removePushFiles(f.dir);
    expect(existsSync(file)).toBe(false);
    expect(() => runFiles({ project: "p", pipeline: 21, branch: "a", tag: "b" })).toThrow(/not both/);
  });

  it("push names the pipeline when the YAML of one is saved", () => {
    const f = pushFiles({ project: "p", repo: "r", path: "/pipelines/x.yml", baseCommit: "c", baseBranch: "main", content: "x", branch: "feature/x", message: "m", pipeline: 21 });
    expect(f.args.slice(-2)).toEqual(["--pipeline", "21"]);
    removePushFiles(f.dir);
  });

  it("every pipeline-browser command is in the contract", () => {
    for (const id of ["browsePipelines", "browsePipeline", "browseRunPlan", "browseRun", "browseArtifacts", "browseArtifactFiles", "browseArtifactOpen", "browseDraftCreate", "browseDrafts", "browseDraftDelete"]) expect((BAR_COMMANDS as Record<string, string>)[id]).toBe(`aihub.bar.${id}`);
  });
});
