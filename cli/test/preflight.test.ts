import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/router.js";
import { setPreflightDeps } from "../src/commands/preflight.js";
import { loadJob } from "../src/lib/preflight/pipelineYaml.js";
import { evalCondition, expand } from "../src/lib/preflight/expr.js";
import { masker, readLog } from "../src/lib/preflight/vso.js";
import { commandFor, pathShells, posixPaths, pythonFor, scriptShell, splitArgs, type Shells } from "../src/lib/preflight/exec.js";
import { localImports, writeCalls } from "../src/lib/preflight/drift.js";
import { validateTeamText } from "../src/lib/teamValidate.js";
import { ctxFor, fakeFetch, makeRepo, sh, tmp, write } from "./helpers.js";

/**
 * A synthetic consumer repository (test-repo, origin rewritten to a bare repository) next to a synthetic source
 * repository (shared-templates) with a deploy job whose steps run with node, so no test needs bash or Python.
 */
const NODE = JSON.stringify(process.execPath.replace(/\\/g, "/"));

const SCRIPTS: Record<string, string> = {
  // prints its argument; sets a plain and a secret output
  "scripts/check.js": `const a = process.argv.slice(2).join(" ");
console.log("check " + a);
console.log("##vso[task.setvariable variable=CHECKED;isOutput=true]yes-" + a);
console.log("##vso[task.setvariable issecret=true;variable=SECRET_ID]hush-value-123");`,
  // reads what an earlier step set (env and argument)
  "scripts/use.js": `console.log("got " + process.argv.slice(2).join(" ") + " env=" + (process.env.CHECKED || "") + " secret=" + (process.env.SEC || ""));`,
  "scripts/fail.js": `console.log("##vso[task.logissue type=error]duplicate id in jobs/a.yaml"); process.exit(2);`,
  "scripts/token.js": `console.log("token-length " + (process.env.ACCESS_TOKEN || "").length + " " + process.env.ACCESS_TOKEN);
console.log("##vso[task.setvariable variable=WORKSPACE_ID]" + process.env.WS_ID);`,
  "scripts/plan.js": `console.log("plan: DROP COLUMN amount in dbo.orders");`,
  "scripts/write.js": `require("fs").writeFileSync(require("path").join(process.env.BUILD_SOURCESDIRECTORY, "applied.txt"), "applied " + process.argv.slice(2).join(" "));
console.log("applied");`,
  "scripts/readwork.js": `const fs = require("fs"); const p = require("path").join(process.env.BUILD_SOURCESDIRECTORY, process.env.BUILD_REPOSITORY_NAME, "jobs");
for (const f of fs.readdirSync(p).sort()) console.log(f + "=" + fs.readFileSync(require("path").join(p, f), "utf8").trim());
fs.writeFileSync(require("path").join(p, "written-by-step.txt"), "x");`,
};

const JOB = `parameters:
  - name: workspaceName
    default: none
jobs:
  - job: Tokens
    steps:
      - task: AzureCLI@2
        displayName: Acquire tokens
        inputs: { scriptType: pscore }
  - deployment: deploy
    variables:
      SOURCE_DIR: $(Build.SourcesDirectory)/shared-templates
      ACCESS_TOKEN: $[ dependencies.Tokens.outputs['t.ACCESS_TOKEN'] ]
    strategy:
      runOnce:
        deploy:
          steps:
            - checkout: self
            - task: UsePythonVersion@0
              displayName: Use Python 3.12
            - script: node $(SOURCE_DIR)/scripts/check.js \${{ parameters.workspaceName }}
              name: chk
              displayName: Validate configs
            - task: PythonScript@0
              displayName: Use the check
              env:
                CHECKED: $(chk.CHECKED)
                SEC: $(SECRET_ID)
              inputs:
                scriptSource: filePath
                scriptPath: shared-templates/scripts/use.js
                arguments: --value "$(CHECKED)"
            - template: tasks/read.yaml
              parameters:
                label: from-template
            - task: PythonScript@0
              displayName: Deploy items
              condition: and(succeeded(), startsWith(variables['Build.SourceBranch'], 'refs/heads/feature/'))
              env:
                ACCESS_TOKEN: $(ACCESS_TOKEN)
              inputs:
                scriptPath: shared-templates/scripts/write.js
                arguments: $(WORKSPACE_ID)
            - task: PublishPipelineArtifact@1
              displayName: Publish artifact
`;

const READ_TEMPLATE = `parameters:
  - name: label
    default: none
steps:
  - task: PythonScript@0
    name: ids
    displayName: Get workspace ids
    env:
      ACCESS_TOKEN: $(ACCESS_TOKEN)
      WS_ID: $(WsId)
    inputs:
      scriptPath: shared-templates/scripts/token.js
      arguments: \${{ parameters.label }}
  - task: PythonScript@0
    displayName: Plan changes
    inputs:
      scriptPath: shared-templates/scripts/plan.js
`;

interface World {
  consumer: string;
  source: string;
  sourceOrigin: string;
}

function preflightYaml(extra = "", steps = "local: [Validate configs, Use the check]\n    read: [Get workspace ids, Plan changes]\n    apply: [Deploy items]\n    skip: [Publish artifact]") {
  return `repositories:
  - name: test-repo
    defaultTarget: main
fabric:
  branchWorkspacePrefixes: ["DEV-test-project"]
preflight:
  source:
    repository: shared-templates
    ref: main
  job: cicd/deploy.yaml
  python: ${NODE}
  parameters:
    workspaceName: "ws-{branchName}"
  variables:
    WsId: "{workspaceId}"
  tokens:
    ACCESS_TOKEN: fabric
  steps:
    ${steps}
${extra}`;
}

function world(o: { job?: string; team?: string; scripts?: Record<string, string> } = {}): World {
  const { dir: consumer } = makeRepo();
  const base = join(consumer, "..");
  const sourceOrigin = join(base, "shared-templates.git");
  const source = join(base, "shared-templates");
  mkdirSync(sourceOrigin);
  mkdirSync(source);
  sh(sourceOrigin, ["init", "--bare", "-b", "main"]);
  sh(source, ["init", "-b", "main"]);
  sh(source, ["remote", "add", "origin", sourceOrigin]);
  for (const [f, t] of Object.entries({ ...SCRIPTS, ...(o.scripts ?? {}) })) write(source, f, t);
  write(source, "cicd/deploy.yaml", o.job ?? JOB);
  write(source, "cicd/tasks/read.yaml", READ_TEMPLATE);
  sh(source, ["add", "."]);
  sh(source, ["commit", "-m", "templates"]);
  sh(source, ["push", "origin", "main"]);
  write(consumer, ".agents/skills/_shared/references/team.yaml", o.team ?? preflightYaml());
  write(consumer, "jobs/a.yaml", "a: 1\n");
  sh(consumer, ["add", "."]);
  sh(consumer, ["commit", "-m", "team"]);
  sh(consumer, ["push", "origin", "main"]);
  sh(consumer, ["checkout", "-b", "feature/12-export"]);
  return { consumer, source, sourceOrigin };
}

const fakeShells = (have: string[], platform: NodeJS.Platform = "linux"): Shells => ({ platform, which: (p) => (have.includes(p) ? `/usr/bin/${p}` : undefined) });

const WORKSPACES = [
  { id: "11111111-1111-1111-1111-111111111111", displayName: "DEV-test-project 12-export" },
  { id: "22222222-2222-2222-2222-222222222222", displayName: "DEV-test-project" },
  { id: "33333333-3333-3333-3333-333333333333", displayName: "ACC-test-project" },
];

afterEach(() => setPreflightDeps({}));

async function pf(dir: string, args: string[], deps: Parameters<typeof setPreflightDeps>[0] = {}) {
  setPreflightDeps({ workspaces: async () => WORKSPACES, token: async () => "Bearer fake-fabric-token-abc", ...deps });
  const { ctx, lines, errs } = ctxFor(dir, fakeFetch([]).fn);
  const code = await main(["preflight", ...args], ctx);
  const out = lines.join("\n");
  return { code, out, errs, json: args.includes("--json") ? JSON.parse(lines[0]) : undefined };
}

const step = (j: any, name: string) => j.steps.find((s: any) => s.name === name);

// ---- units -----------------------------------------------------------------------------------------------------

describe("preflight: reading the pipeline YAML", () => {
  it("collects steps in order from nested jobs, a deployment strategy and a - template: include", () => {
    const w = world();
    const doc = loadJob(w.source, "cicd/deploy.yaml");
    expect(doc.steps.map((s) => `${s.index}:${s.name}:${s.kind}`)).toEqual([
      "1:Acquire tokens:other",
      "2:Checkout self:other",
      "3:Use Python 3.12:other",
      "4:Validate configs:script",
      "5:Use the check:python",
      "6:Get workspace ids:python",
      "7:Plan changes:python",
      "8:Deploy items:python",
      "9:Publish artifact:other",
    ]);
    expect(doc.steps[5].file).toBe("cicd/tasks/read.yaml");
    expect(doc.steps[5].ref).toBe("ids");
    expect(doc.variables.SOURCE_DIR).toBe("$(Build.SourcesDirectory)/shared-templates");
    expect(doc.variables.ACCESS_TOKEN).toBeUndefined(); // a runtime $[ ] expression is not known before the run
  });

  it("stages, bash/pwsh/PowerShell@2/Bash@3 steps, /root and @self templates, and what cannot be read", () => {
    const dir = tmp();
    write(dir, "p/main.yml", `stages:
  - stage: one
    jobs:
      - job: a
        steps:
          - bash: echo hi
          - pwsh: Write-Host hi
            displayName: Say hi
          - task: powershell@2
            inputs: { targetType: inline, script: "Write-Host x" }
          - task: Bash@3
            inputs: { filePath: s/run.sh, arguments: "-x 1" }
          - template: /t/steps.yml
          - template: t/steps.yml@self
          - template: steps.yml@other-repo
          - \${{ if eq(parameters.x, 'y') }}:
            - script: echo inserted
`);
    write(dir, "t/steps.yml", "steps:\n  - script: echo from-template\n    displayName: From template\n");
    const doc = loadJob(dir, "p/main.yml");
    expect(doc.steps.map((s) => [s.name, s.kind, s.scriptPath ?? s.inline ?? s.cannot])).toEqual([
      ["Bash", "bash", "echo hi"],
      ["Say hi", "pwsh", "Write-Host hi"],
      ["powershell", "powershell", "Write-Host x"],
      ["Bash", "bash", "s/run.sh"],
      ["From template", "script", "echo from-template"],
      ["From template", "script", "echo from-template"],
      ["template steps.yml@other-repo", "other", "template from another repository (other-repo)"],
      ["${{ if eq(parameters.x, 'y') }}", "other", "template expression cannot be evaluated"],
    ]);
    expect(doc.steps[3].arguments).toBe("-x 1");
  });

  it("a job file that is not there says so", () => {
    expect(() => loadJob(tmp(), "cicd/gone.yaml")).toThrow(/not in the source repository/);
  });
});

describe("preflight: expressions", () => {
  const vars: Record<string, string> = { "build.sourcebranch": "refs/heads/feature/12-x", env: "dev" };
  const variable = (n: string) => vars[n.toLowerCase()];
  it("expands $(Name), ${{ parameters.x }} and ${{ variables.x }}; unknown names are missing, complex expressions cannot", () => {
    const r = expand("a $(Env) ${{ parameters.p }} ${{variables.env}} $(Nope) ${{ format('{0}', 1) }}", { variable, parameter: (n) => (n === "p" ? "P" : undefined) });
    expect(r.text).toBe("a dev P dev $(Nope) ${{ format('{0}', 1) }}");
    expect(r.missing).toEqual(["Nope"]);
    expect(r.cannot).toEqual(["${{ format('{0}', 1) }}"]);
    expect(expand("echo $(pwd) $(Env)", { variable, parameter: () => undefined, keepShell: true }).missing).toEqual([]);
  });

  it("evaluates the supported condition subset and refuses the rest", () => {
    const st = { succeeded: true, variable };
    expect(evalCondition(undefined, st).value).toBe(true);
    expect(evalCondition(undefined, { ...st, succeeded: false }).value).toBe(false);
    expect(evalCondition("and(succeeded(), startsWith(variables['Build.SourceBranch'], 'refs/heads/feature/'))", st).value).toBe(true);
    expect(evalCondition("or(eq(variables.ENV, 'tst'), eq(variables['env'], 'acc'))", st).value).toBe(false);
    expect(evalCondition("and(always(), not(failed()), in(variables.env, 'dev', 'tst'), ne('a', 'b'), contains('abc', 'B'), endsWith('abc', 'c'))", st).value).toBe(true);
    expect(evalCondition("eq(true, 'True')", st).value).toBe(true);
    expect(evalCondition("succeeded('OtherJob')", st).reason).toBe("condition could not be evaluated");
    expect(evalCondition("eq(variables['Missing'], 'x')", st).reason).toMatch(/variable Missing is not known/);
    expect(evalCondition("eq(dependencies.a.result, 'Succeeded')", st).reason).toMatch(/could not be evaluated/);
  });
});

describe("preflight: logging commands and masking", () => {
  it("reads task.setvariable in any property order, logissue and task.complete", () => {
    const l = readLog("x\n##vso[task.setvariable isOutput=true;variable=A]1\n##vso[task.setvariable variable=B;issecret=true]s3cret\n##vso[task.logissue type=warning]careful\n##vso[task.complete result=Failed;]done");
    expect(l.variables).toEqual([
      { name: "A", value: "1", secret: false, output: true },
      { name: "B", value: "s3cret", secret: true, output: false },
    ]);
    expect(l.issues).toEqual([{ type: "warning", text: "careful" }]);
    expect(l.result).toBe("Failed");
    expect(masker(() => ["s3cret"])("token s3cret here")).toBe("token *** here");
  });
});

describe("preflight: how a step becomes a process", () => {
  const step = (kind: any, extra: any = {}) => ({ index: 1, name: "x", kind, env: {}, enabled: true, continueOnError: false, file: "f", scope: { file: "f", passed: {}, defaults: {} }, ...extra });
  const o = (sh: Shells, extra: any = {}) => ({ sh, tempDir: "/tmp/t", id: "s1", ...extra });
  it("script: bash when found, else cmd on Windows and sh elsewhere; preflight.shell wins", () => {
    expect(scriptShell(fakeShells(["bash"]))).toBe("bash");
    expect(scriptShell(fakeShells([], "win32"))).toBe("cmd");
    expect(scriptShell(fakeShells([]))).toBe("sh");
    expect(scriptShell(fakeShells(["bash"]), "pwsh")).toBe("pwsh");
    const b = commandFor(step("script"), { inline: "node a.js" }, o(fakeShells(["bash"])));
    expect([b.file, b.args.slice(0, 2)]).toEqual(["bash", ["--noprofile", "--norc"]]);
    expect(b.script?.content).toBe("node a.js");
    const c = commandFor(step("script"), { inline: "node a.js\nnode b.js" }, o(fakeShells([], "win32")));
    expect(c.file).toBe("cmd.exe");
    expect(c.verbatim).toBe(true);
    expect(c.script?.content).toBe("@echo off\r\nnode a.js\r\nnode b.js\r\n");
    const p = commandFor(step("script"), { inline: "Write-Host 1" }, o(fakeShells(["pwsh"]), { shell: "pwsh" }));
    expect(p.file).toBe("pwsh");
    expect(p.script?.content).toContain("$ErrorActionPreference = 'Stop'");
  });

  it("Windows: bash is Git for Windows' bash, also when only git is on PATH; WSL's bash never counts; the full path is spawned", () => {
    const root = tmp();
    write(root, "Windows/System32/bash.exe", "wsl");
    write(root, "Git/cmd/git.exe", "git");
    write(root, "Git/bin/bash.exe", "bash");
    const env = { PATH: [join(root, "Windows", "System32"), join(root, "Git", "cmd")].join(";"), PATHEXT: ".exe" };
    const win = pathShells(env, "win32");
    expect(win.which("bash")).toBe(join(root, "Git", "bin", "bash.exe"));
    expect(scriptShell(win)).toBe("bash");
    const b = commandFor(step("script"), { inline: "echo 1" }, o(win));
    expect(b.file).toBe(join(root, "Git", "bin", "bash.exe")); // by name, Windows would start the first bash.exe on PATH: WSL's
    // no Git at all: WSL's bash alone is not bash, script steps fall back to cmd
    expect(pathShells({ PATH: join(root, "Windows", "System32"), PATHEXT: ".exe" }, "win32").which("bash")).toBeUndefined();
  });

  it("Windows paths in a bash script get forward slashes, so an unquoted $(Build.SourcesDirectory) keeps its separators", () => {
    const base = "C:\\Users\\dev\\my repos\\test-repo\\.git\\aihub\\preflight";
    const s = `${base}\\s`;
    expect(posixPaths(`ls ${s}/jobs && cd "${s}" && echo ${base}`, [base, s])).toBe('ls C:/Users/dev/my repos/test-repo/.git/aihub/preflight/s/jobs && cd "C:/Users/dev/my repos/test-repo/.git/aihub/preflight/s" && echo C:/Users/dev/my repos/test-repo/.git/aihub/preflight');
    expect(posixPaths("echo C:\\other", [base, s])).toBe("echo C:\\other");
  });

  it("PythonScript@0: preflight.python, else python3 or python; a missing program is reported, not guessed", () => {
    expect(pythonFor(fakeShells(["python3"]))).toBe("python3");
    expect(pythonFor(fakeShells([]))).toBe("python");
    expect(pythonFor(fakeShells(["python3"], "win32"))).toBe("python");
    const py = commandFor(step("python"), { scriptFile: "/s/a.py", arguments: 'setup --dir "a b"' }, o(fakeShells(["python3"])));
    expect([py.file, ...py.args]).toEqual(["python3", "/s/a.py", "setup", "--dir", "a b"]);
    expect(commandFor(step("python"), { scriptFile: "/s/a.py" }, o(fakeShells([]))).missing).toBe("python");
    expect(commandFor(step("bash"), { inline: "echo" }, o(fakeShells([], "win32"))).missing).toBe("bash");
    expect(commandFor(step("powershell"), { inline: "x" }, o(fakeShells(["pwsh"]))).file).toBe("pwsh");
    expect(commandFor(step("powershell"), { inline: "x" }, o(fakeShells(["powershell"], "win32"))).file).toBe("powershell");
    expect(splitArgs(`a "b c" 'd e' --x=1`)).toEqual(["a", "b c", "d e", "--x=1"]);
  });
});

describe("preflight: write-call scan (a text search)", () => {
  it("finds POST/PUT/PATCH/DELETE calls in a script and the local modules it imports, one level", () => {
    const dir = tmp();
    write(dir, "scripts/read.py", "import requests\nfrom helpers import api\nrequests.get(url)\n");
    write(dir, "scripts/helpers/api.py", "def go(s):\n    return s.post(url, json={})\n");
    expect(localImports(join(dir, "scripts/read.py"), readFileSync(join(dir, "scripts/read.py"), "utf8"), dir).map((f) => f.replace(/\\/g, "/"))).toEqual([join(dir, "scripts/helpers/api.py").replace(/\\/g, "/")]);
    expect(writeCalls(join(dir, "scripts/read.py"), dir)).toEqual(["scripts/helpers/api.py: return s.post(url, json={})"]);
  });
});

// ---- the command --------------------------------------------------------------------------------------------------

describe("aihub preflight", () => {
  it("local (default): runs only local steps, passes outputs on, masks secrets, never touches the working tree", async () => {
    const w = world();
    write(w.consumer, "jobs/a.yaml", "a: 2\n"); // uncommitted
    write(w.consumer, "jobs/b.yaml", "b: new\n"); // untracked
    sh(w.consumer, ["add", "jobs/b.yaml"]); // staged
    write(w.consumer, "jobs/c.yaml", "c: untracked\n");
    const before = sh(w.consumer, ["status", "--porcelain"]);
    const stagedBefore = sh(w.consumer, ["diff", "--cached", "--name-only"]);
    const r = await pf(w.consumer, ["--json"]);
    expect(r.code).toBe(0);
    const j = r.json;
    expect(Object.keys(j)).toEqual(["source", "job", "workspace", "level", "dryRun", "steps", "drift", "ok", "notes"]);
    expect(j.source.repository).toBe("shared-templates");
    expect(j.source.commit).toBe(sh(w.source, ["rev-parse", "origin/main"]));
    expect(j.level).toBe("local");
    expect(j.workspace).toBeNull();
    expect(j.ok).toBe(true);
    expect(step(j, "Validate configs")).toMatchObject({ level: "local", status: "passed", afterFailure: false, uncertain: false });
    expect(step(j, "Use the check")).toMatchObject({ status: "passed" });
    expect(step(j, "Get workspace ids")).toMatchObject({ status: "skipped", reason: "needs --plan" });
    expect(step(j, "Deploy items")).toMatchObject({ status: "skipped", reason: "needs --apply" });
    expect(step(j, "Publish artifact")).toMatchObject({ level: "skip", status: "skipped" });
    expect(step(j, "Acquire tokens")).toMatchObject({ level: "unknown", status: "skipped" });
    expect(j.drift).toEqual({ unknown: [], missing: [], renamed: [], changed: [] });
    expect(sh(w.consumer, ["status", "--porcelain"])).toBe(before);
    expect(sh(w.consumer, ["diff", "--cached", "--name-only"])).toBe(stagedBefore);
    expect(sh(w.consumer, ["stash", "list"])).toBe("");
  });

  it("the text output: one line per step, grouped per level, then the verdict; --verbose prints the scratch path and masks secrets", async () => {
    const w = world();
    setPreflightDeps({});
    const { ctx, lines, errs } = ctxFor(w.consumer, fakeFetch([]).fn);
    expect(await main(["preflight", "--verbose"], ctx)).toBe(0);
    const out = lines.join("\n");
    expect(out).toMatch(/^preflight local: cicd\/deploy\.yaml from shared-templates@main \([0-9a-f]{7}, fetched /);
    expect(out).toContain("local · 2 step(s)");
    expect(out).toMatch(/ok\s+Validate configs/);
    expect(out).toContain("read from the workspace · 2 step(s): need --plan");
    expect(out).toContain("preflight ok: 2 step(s) passed; next: aihub preflight --plan");
    const e = errs.join("\n");
    expect(e).toMatch(/preflight: scratch .*aihub[\\/]preflight/);
    expect(e).toContain("check ws-12-export"); // ${{ parameters.workspaceName }} from team.yaml with {branchName}
    expect(e).toContain("got --value yes-ws-12-export env=yes-ws-12-export secret=***");
    expect(e).not.toContain("hush-value-123");
  });

  it("the snapshot holds uncommitted, staged and untracked files; steps may write there", async () => {
    const w = world({ job: "steps:\n  - script: node $(Build.SourcesDirectory)/shared-templates/scripts/readwork.js\n    displayName: Read work\n", team: preflightYaml("", "local: [Read work]") });
    write(w.consumer, "jobs/a.yaml", "a: 2\n");
    write(w.consumer, "jobs/b.yaml", "b: new\n");
    write(w.consumer, ".gitignore", "jobs/ignored.yaml\n");
    write(w.consumer, "jobs/ignored.yaml", "secret: 1\n");
    const before = sh(w.consumer, ["status", "--porcelain", "--ignored"]);
    setPreflightDeps({});
    const { ctx, errs } = ctxFor(w.consumer, fakeFetch([]).fn);
    expect(await main(["preflight", "--verbose"], ctx)).toBe(0);
    const e = errs.join("\n");
    expect(e).toContain("a.yaml=a: 2");
    expect(e).toContain("b.yaml=b: new");
    expect(e).not.toContain("ignored.yaml");
    expect(existsSync(join(w.consumer, "jobs", "written-by-step.txt"))).toBe(false);
    expect(sh(w.consumer, ["status", "--porcelain", "--ignored"])).toBe(before);
  });

  it("a variable nobody can fill blocks the step (never guessed); exit code 1", async () => {
    const w = world({ job: "steps:\n  - script: node $(Build.SourcesDirectory)/shared-templates/scripts/check.js $(ENVIRONMENT)\n    displayName: Validate configs\n  - script: node -e 1\n    displayName: Use the check\n" });
    const r = await pf(w.consumer, ["--json"]);
    expect(r.code).toBe(1);
    // a local step: the variable may be the output of a read step, so the reason names both ways out
    expect(step(r.json, "Validate configs")).toMatchObject({ status: "blocked", reason: "needs variable ENVIRONMENT: when a read step sets it, list this step under preflight.steps.read so it runs with --plan; else add it under preflight.variables in team.yaml" });
    expect(step(r.json, "Use the check").status).toBe("passed");
    expect(r.json.ok).toBe(false);
    expect(r.json.drift.missing).toEqual(["Get workspace ids", "Plan changes", "Deploy items", "Publish artifact"]);
  });

  it("a failed step shows the lines that say why, not only the last line, and keeps the whole output in a log", async () => {
    // a validator names the file and the rule in the middle of its output; its last line only says that something is wrong
    const validate = `console.log("Validating jobs/a.yaml");
console.log("Errors in jobs/a.yaml:");
console.log("- columns.0.type: invalid column type 'varchar' " + "x".repeat(400));
for (let i = 0; i < 30; i++) console.log("Validating jobs/ok" + i + ".yaml: valid");
console.log("Stopped: one or more files are wrong.");
process.exit(1);`;
    const w = world({ scripts: { "scripts/validate.js": validate }, job: "steps:\n  - script: node $(Build.SourcesDirectory)/shared-templates/scripts/validate.js\n    displayName: Validate configs\n", team: preflightYaml("", "local: [Validate configs]") });
    const r = await pf(w.consumer, ["--json"]);
    const s = step(r.json, "Validate configs");
    expect(s).toMatchObject({ status: "failed", issues: ["Stopped: one or more files are wrong."] });
    expect(s.excerpt[0]).toBe("Errors in jobs/a.yaml:");
    expect(s.excerpt[1]).toMatch(/^- columns\.0\.type: invalid column type 'varchar' x+…$/);
    expect(s.excerpt[1].length).toBeLessThanOrEqual(241);
    expect(s.excerpt.some((l: string) => /ok\d+\.yaml: valid/.test(l) && !/invalid/.test(l))).toBe(false);
    expect(readFileSync(s.log, "utf8")).toContain("Validating jobs/ok29.yaml: valid");
    const text = await pf(w.consumer, []);
    expect(text.out).toMatch(/FAILED\s+Validate configs.*Stopped: one or more files are wrong\./);
    expect(text.out).toContain("      | Errors in jobs/a.yaml:");
    expect(text.out).toMatch(/\n {6}log: .*Validate-configs\.log/);
    // a step that passes has neither
    const ok = await pf(world().consumer, ["--json"]);
    expect(step(ok.json, "Validate configs").excerpt).toBeUndefined();
    expect(step(ok.json, "Validate configs").log).toBeUndefined();
  });

  it("System.Debug is a built-in (false); several steps in no list are one drift line", async () => {
    const job = "steps:\n  - script: node -e \"console.log('debug=' + process.argv[1])\" $(System.Debug)\n    displayName: Validate configs\n  - script: node -e 1\n    displayName: New step one\n  - script: node -e 1\n    displayName: New step two\n";
    const w = world({ job, team: preflightYaml("", "local: [Validate configs]") });
    setPreflightDeps({});
    const a = ctxFor(w.consumer, fakeFetch([]).fn);
    await main(["preflight", "--verbose"], a.ctx);
    expect(a.errs.join("\n")).toContain("debug=false");
    const text = await pf(w.consumer, []);
    expect(text.out).toContain('drift: 2 steps are in no list (not run, and the steps after the first are uncertain): "New step one", "New step two"; add each to preflight.steps (local, read, apply or skip) in team.yaml');
    expect(text.out.match(/^drift:/gm)?.length).toBe(1);
  });

  it("a local step that asks for a token is blocked; read steps get it with --plan", async () => {
    const w = world({ job: "steps:\n  - script: node -e 1 $(ACCESS_TOKEN)\n    displayName: Validate configs\n" , team: preflightYaml("", "local: [Validate configs]") });
    const r = await pf(w.consumer, ["--json"]);
    expect(step(r.json, "Validate configs")).toMatchObject({ status: "blocked" });
    expect(step(r.json, "Validate configs").reason).toMatch(/listed as local but asks for token ACCESS_TOKEN/);
  });

  it("an inline script with an expanded secret or token is not left on disk after its step", async () => {
    const job = [
      "steps:",
      `  - script: node -e "console.log('##vso[task.setvariable variable=S1;issecret=true]hush-inline-42')"`,
      "    displayName: Set secret",
      `  - script: node -e "console.log('len=' + process.argv[1].length)" $(S1)`,
      "    displayName: Use secret",
      `  - script: node -e "console.log('tok=' + process.argv[1].length)" $(ACCESS_TOKEN)`,
      "    displayName: Read with token",
      "",
    ].join("\n");
    const w = world({ job, team: preflightYaml("", "local: [Set secret, Use secret]\n    read: [Read with token]") });
    write(w.consumer, ".git/aihub/preflight/_temp/step-9.sh", "echo hush-inline-42"); // left behind by an older version
    const r = await pf(w.consumer, ["--plan", "--verbose"]);
    expect(r.code).toBe(0);
    expect(r.errs.join("\n")).toContain("len=14");
    expect(r.errs.join("\n")).toContain("tok=21");
    const temp = join(w.consumer, ".git", "aihub", "preflight", "_temp");
    const left = existsSync(temp) ? readdirSync(temp).map((f) => readFileSync(join(temp, f), "utf8")).join("\n") : "";
    expect(left).not.toContain("hush-inline-42");
    expect(left).not.toContain("fake-fabric-token-abc");
    expect(existsSync(temp)).toBe(false); // the folder itself is gone after the run
  });

  it("a failed step and an interrupted run (Ctrl+C) leave no script with a secret either", async () => {
    const setSecret = `  - script: node -e "console.log('##vso[task.setvariable variable=S1;issecret=true]hush-inline-42')"\n    displayName: Set secret\n`;
    const failing = world({ job: `steps:\n${setSecret}  - script: node -e "process.exit(3)" $(S1)\n    displayName: Use secret\n`, team: preflightYaml("", "local: [Set secret, Use secret]") });
    const f = await pf(failing.consumer, []);
    expect(f.code).toBe(1);
    expect(existsSync(join(failing.consumer, ".git", "aihub", "preflight", "_temp"))).toBe(false);

    // Ctrl+C while a step that holds the secret runs: _temp goes at once and the process ends with 130
    const slow = world({ job: `steps:\n${setSecret}  - script: node -e "setTimeout(() => {}, 2500)" $(S1)\n    displayName: Use secret\n`, team: preflightYaml("", "local: [Set secret, Use secret]") });
    const temp = join(slow.consumer, ".git", "aihub", "preflight", "_temp");
    const proc = Object.assign(new EventEmitter(), { exit: vi.fn() });
    const running = pf(slow.consumer, [], { process: proc as never });
    const holds = () => existsSync(temp) && readdirSync(temp).some((n) => readFileSync(join(temp, n), "utf8").includes("hush-inline-42"));
    for (let i = 0; i < 200 && !holds(); i++) await new Promise((r) => setTimeout(r, 50));
    expect(holds()).toBe(true); // the step's script is there while it runs
    proc.emit("SIGINT", "SIGINT");
    expect(proc.exit).toHaveBeenCalledWith(130);
    expect(existsSync(temp)).toBe(false);
    await running;
    expect(proc.listenerCount("SIGINT")).toBe(0);
  });

  it("--plan: resolves the branch's workspace, hands tokens only to read steps, masks them; apply steps wait for --apply", async () => {
    const w = world();
    const asked: string[] = [];
    const r = await pf(w.consumer, ["--plan", "--json", "--verbose"], { token: async (a) => (asked.push(a), "Bearer fake-fabric-token-abc") });
    expect(r.code).toBe(0);
    const j = r.json;
    expect(j.level).toBe("plan");
    expect(j.workspace).toEqual({ name: "DEV-test-project 12-export", id: WORKSPACES[0].id, environment: "feature" });
    expect(step(j, "Get workspace ids")).toMatchObject({ level: "read", status: "passed" });
    expect(step(j, "Plan changes").status).toBe("passed");
    expect(step(j, "Deploy items")).toMatchObject({ status: "skipped", reason: "needs --apply" });
    expect(asked).toEqual(["fabric"]);
    expect(r.errs.join("\n")).toContain("token-length 21 ***");
    expect(JSON.stringify(j)).not.toContain("fake-fabric-token-abc");
  });

  it("--plan refuses ACC/PRD; --apply refuses a test workspace, refuseWorkspaces and a workspace that is not the branch's", async () => {
    const w = world();
    expect((await pf(w.consumer, ["--plan", "--workspace", "ACC-test-project"])).errs.join("\n")).toContain("is ACC: preflight never reads or writes ACC or PRD");
    const notOwn = await pf(w.consumer, ["--apply", "--workspace", "DEV-test-project"]);
    expect(notOwn.code).toBe(1);
    expect(notOwn.errs.join("\n")).toContain("is not the feature workspace of feature/12-export");
    const w2 = world({ team: preflightYaml("  apply:\n    refuseWorkspaces: [\"*12-export\"]\n").replace("fabric:\n", "fabric:\n  workspaces:\n    - name: DEV-test-project\n      environment: test\n") });
    expect((await pf(w2.consumer, ["--apply"])).errs.join("\n")).toContain("matches preflight.apply.refuseWorkspaces '*12-export'");
    expect((await pf(w2.consumer, ["--apply", "--workspace", "DEV-test-project"])).errs.join("\n")).toContain("is TEST");
    const none = await pf(w.consumer, ["--plan"], { workspaces: async () => [WORKSPACES[1]] });
    expect(none.errs.join("\n")).toContain("has no Fabric workspace yet");
    expect(none.errs.join("\n")).toContain("the team's CD after the first push");
    expect(existsSync(join(w.source, "applied.txt"))).toBe(false);
  });

  it("--apply runs the write steps on the feature workspace; a destructive plan needs --yes", async () => {
    const w = world({ team: preflightYaml("  apply:\n    destructive:\n      - step: Plan changes\n        pattern: \"DROP\"\n") });
    const held = await pf(w.consumer, ["--apply", "--json"]);
    expect(held.code).toBe(1);
    expect(step(held.json, "Deploy items").status).toBe("notRun");
    expect(step(held.json, "Deploy items").reason).toContain('"Plan changes" plans to remove something (plan: DROP COLUMN amount in dbo.orders): run again with --yes');
    const r = await pf(w.consumer, ["--apply", "--yes", "--json"]);
    expect(r.code).toBe(0);
    expect(step(r.json, "Deploy items").status).toBe("passed");
    const applied = readFileSync(join(w.consumer, ".git", "aihub", "preflight", "s", "applied.txt"), "utf8");
    expect(applied).toBe(`applied ${WORKSPACES[0].id}`); // WORKSPACE_ID set by an earlier read step from {workspaceId}
  });

  it("after a failure later local and read steps still run (afterFailure), apply steps never do; nothing was written", async () => {
    const job = JOB.replace("scripts/check.js \\${{ parameters.workspaceName }}", "scripts/fail.js").replace("node $(SOURCE_DIR)/scripts/check.js ${{ parameters.workspaceName }}", "node $(SOURCE_DIR)/scripts/fail.js");
    const w = world({ job });
    const r = await pf(w.consumer, ["--apply", "--json"]);
    expect(r.code).toBe(1);
    expect(step(r.json, "Validate configs")).toMatchObject({ status: "failed", issues: ["error: duplicate id in jobs/a.yaml"] });
    expect(step(r.json, "Get workspace ids")).toMatchObject({ status: "passed", afterFailure: true });
    expect(step(r.json, "Deploy items")).toMatchObject({ status: "notRun", reason: "an earlier step failed or was blocked: apply steps never run then" });
    const text = await pf(w.consumer, ["--apply"]);
    expect(text.out).toMatch(/FAILED\s+Validate configs.*duplicate id in jobs\/a\.yaml/);
    expect(text.out).toContain("nothing was written");
  });

  it("conditions: a false condition is notRun, one preflight cannot evaluate is notRun with that reason", async () => {
    const w = world({
      job: "steps:\n  - script: node -e 1\n    displayName: Validate configs\n    condition: eq(variables['Build.SourceBranchName'], 'main')\n  - script: node -e 1\n    displayName: Use the check\n    condition: eq(dependencies.a.result, 'Succeeded')\n",
      team: preflightYaml("", "local: [Validate configs, Use the check]"),
    });
    const r = await pf(w.consumer, ["--json"]);
    expect(step(r.json, "Validate configs")).toMatchObject({ status: "notRun", reason: "condition is false: eq(variables['Build.SourceBranchName'], 'main')" });
    expect(step(r.json, "Use the check")).toMatchObject({ status: "notRun", reason: "condition could not be evaluated" });
    expect(r.code).toBe(0);
  });

  it("drift: an unknown step is not run and makes later steps uncertain; a listed name that is gone is a warning; a rename is recognised", async () => {
    const w = world();
    expect((await pf(w.consumer, ["--json"])).code).toBe(0); // remembers the fingerprints
    write(w.source, "cicd/deploy.yaml", JOB.replace("displayName: Validate configs", "displayName: Validate all configs"));
    sh(w.source, ["commit", "-am", "rename"]);
    sh(w.source, ["push", "origin", "main"]);
    const r = await pf(w.consumer, ["--json"]);
    const j = r.json;
    expect(j.drift.unknown).toEqual(["Validate all configs"]);
    expect(j.drift.missing).toEqual(["Validate configs"]);
    expect(j.drift.renamed).toEqual([{ from: "Validate configs", to: "Validate all configs" }]);
    expect(step(j, "Validate all configs")).toMatchObject({ status: "unknown", uncertain: false });
    expect(step(j, "Use the check")).toMatchObject({ uncertain: true });
    const text = await pf(w.consumer, []);
    expect(text.out).toContain('drift: "Validate all configs" looks renamed from "Validate configs" (same script and arguments)');
  });

  it("drift: a changed script of a read step is mentioned once", async () => {
    const w = world();
    await pf(w.consumer, ["--plan"]);
    write(w.source, "scripts/plan.js", SCRIPTS["scripts/plan.js"] + "\n// changed\n");
    sh(w.source, ["commit", "-am", "change"]);
    sh(w.source, ["push", "origin", "main"]);
    expect((await pf(w.consumer, ["--plan", "--json"])).json.drift.changed).toEqual(["Plan changes"]);
    expect((await pf(w.consumer, ["--plan", "--json"])).json.drift.changed).toEqual([]);
  });

  it("a read step whose script gains a write call is held until accepted", async () => {
    const w = world();
    await pf(w.consumer, ["--plan"]);
    write(w.source, "scripts/plan.js", SCRIPTS["scripts/plan.js"] + "\nconst m = { method: 'POST' };\n");
    sh(w.source, ["commit", "-am", "write"]);
    sh(w.source, ["push", "origin", "main"]);
    const held = await pf(w.consumer, ["--plan", "--json"]);
    expect(held.code).toBe(1);
    expect(step(held.json, "Plan changes").reason).toContain('aihub preflight accept "Plan changes"');
    const acc = await pf(w.consumer, ["accept", "Plan changes"]);
    expect(acc.out).toContain('accepted "Plan changes": 1 write call site(s)');
    expect((await pf(w.consumer, ["--plan", "--json"])).json.ok).toBe(true);
  });

  it("--dry-run runs nothing and prints each expanded command with secrets masked", async () => {
    const w = world();
    const r = await pf(w.consumer, ["--apply", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/not run\s+Deploy items\s+dry run; needs \$\(WORKSPACE_ID\) at run time/);
    // a Windows path holds backslashes, so the display quotes it: token.js" from-template
    expect(r.out).toMatch(/not run\s+Get workspace ids\s+dry run\n.*token\.js"? from-template\n\s+env: ACCESS_TOKEN=\*\*\* WS_ID=11111111-1111-1111-1111-111111111111/);
    expect(r.out).toContain("shared-templates/scripts/check.js ws-12-export");
    expect(r.out).toContain("dry run: nothing was run");
    expect(r.out).not.toContain("fake-fabric-token-abc");
    expect(existsSync(join(w.consumer, ".git", "aihub", "preflight", "s", "applied.txt"))).toBe(false);
  });

  it("--step runs up to and including that step", async () => {
    const w = world();
    const r = await pf(w.consumer, ["--plan", "--step", "Get workspace ids", "--json"]);
    expect(step(r.json, "Get workspace ids").status).toBe("passed");
    expect(step(r.json, "Plan changes")).toMatchObject({ status: "skipped", reason: 'after --step "Get workspace ids"' });
    expect((await pf(w.consumer, ["--step", "Deploy items"])).errs.join("\n")).toContain("is an apply step: add --apply");
  });

  it("--apply waits while the CD runs on the branch (--force overrides); a failed lookup is only a note", async () => {
    const w = world({ team: preflightYaml("  cd:\n    pipeline: test-project-cd\n") });
    const busy = await pf(w.consumer, ["--apply"], { cdRuns: async () => [{ id: 7, status: "inProgress" }] });
    expect(busy.errs.join("\n")).toContain("a run of test-project-cd is in progress on feature/12-export (run 7)");
    const forced = await pf(w.consumer, ["--apply", "--force", "--json"], { cdRuns: async () => [{ id: 7, status: "inProgress" }] });
    expect(forced.code).toBe(0);
    const broken = await pf(w.consumer, ["--apply", "--json"], { cdRuns: async () => { throw new Error("401"); } });
    expect(broken.json.notes.join(" ")).toContain("could not check whether test-project-cd is running");
  });

  it("without a preflight block it says how to start; `preflight steps` works without one and lists levels", async () => {
    const w = world({ team: "repositories:\n  - name: test-repo\n    defaultTarget: main\n" });
    const r = await pf(w.consumer, []);
    expect(r.code).toBe(1);
    expect(r.errs.join("\n")).toContain("aihub preflight steps --job <path> [--source <repo>]");
    const s = await pf(w.consumer, ["steps", "--job", "cicd/deploy.yaml", "--source", "shared-templates", "--json"]);
    expect(s.code).toBe(0);
    expect(s.json.steps.map((x: any) => [x.name, x.level, x.runnable])).toContainEqual(["Validate configs", "unknown", true]);
    expect(s.json.steps.find((x: any) => x.name === "Publish artifact").runnable).toBe(false);
    const t = await pf(w.consumer, ["steps", "--job", "cicd/deploy.yaml", "--source", "shared-templates"]);
    expect(t.out).toContain("not in team.yaml yet: 5 runnable step(s)");
  });

  it("setup runs once per commit of the source repository and its dependency files; {lastPushed} and {head} are filled", async () => {
    const setup = `node -e "require('fs').appendFileSync('setup.log', 'x')"`;
    const w = world({
      job: "steps:\n  - script: node -e \"console.log('pushed=' + process.argv[1] + ' head=' + process.argv[2])\" $(LAST) $(HEAD)\n    displayName: Validate configs\n",
      team: preflightYaml(`  setup:\n    - ${JSON.stringify(setup)}\n`, "local: [Validate configs]").replace("    WsId:", "    LAST: \"{lastPushed}\"\n    HEAD: \"{head}\"\n    WsId:"),
    });
    write(w.source, ".gitignore", "setup.log\n");
    write(w.source, "pyproject.toml", "[project]\nname = 'x'\n");
    sh(w.source, ["add", "."]);
    sh(w.source, ["commit", "-m", "deps"]);
    sh(w.source, ["push", "origin", "main"]);
    const log = join(w.consumer, ".git", "aihub", "preflight", "s", "shared-templates", "setup.log");
    setPreflightDeps({});
    const a = ctxFor(w.consumer, fakeFetch([]).fn);
    expect(await main(["preflight", "--verbose"], a.ctx)).toBe(0);
    const mergeBase = sh(w.consumer, ["merge-base", "HEAD", "origin/main"]);
    expect(a.errs.join("\n")).toContain(`pushed=${mergeBase} head=${sh(w.consumer, ["rev-parse", "HEAD"])}`);
    await pf(w.consumer, []);
    expect(readFileSync(log, "utf8")).toBe("x");
    write(w.source, "pyproject.toml", "[project]\nname = 'y'\n");
    sh(w.source, ["commit", "-am", "deps 2"]);
    sh(w.source, ["push", "origin", "main"]);
    await pf(w.consumer, []);
    expect(readFileSync(log, "utf8")).toBe("xx");
    // a new commit of the source repository without a dependency change runs setup again as well: a setup such as
    // `pip install .` copies the scripts' own package, and a copy of the older commit must not be imported
    write(w.source, "scripts/check.js", "console.log('changed');\n");
    sh(w.source, ["commit", "-am", "script only"]);
    sh(w.source, ["push", "origin", "main"]);
    await pf(w.consumer, []);
    expect(readFileSync(log, "utf8")).toBe("xxx");
    await pf(w.consumer, []);
    expect(readFileSync(log, "utf8")).toBe("xxx");
  });

  it("help and team validate know the command and the block", async () => {
    const w = world();
    const h = await pf(w.consumer, ["--help"]);
    expect(h.out).toContain("aihub preflight");
    const text = readFileSync(join(w.consumer, ".agents/skills/_shared/references/team.yaml"), "utf8");
    expect(validateTeamText(text).problems.filter((p) => p.severity === "error")).toEqual([]);
    expect(validateTeamText(text + "  stepz: []\n").problems.map((p) => p.message)).toContainEqual('Unknown key "stepz". Did you mean "steps"?');
  });
});
