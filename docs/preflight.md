# Preflight: the deploy job on your PC, before you push

`aihub preflight` runs a chosen subset of the steps of the team's CD deploy job on the developer's PC, with the same
scripts, arguments and variable names as the pipeline. The pipeline YAML is the source of truth: preflight reads its
steps every run, so nothing has to be added to the repository that holds the pipeline and its scripts.

Typical use: you change a job or DDL YAML file, run `aihub preflight` (seconds, no network), then `aihub preflight --plan`
to see what the CD would do in your feature workspace, and, when you want to test in Fabric without waiting for the CD,
`aihub preflight --apply`. After the push the CD does the official deployment again.

## Three levels

| Level | Flag | Runs | Gets |
|---|---|---|---|
| local | (default) | steps listed under `steps.local` | no network use is expected, never a token |
| plan | `--plan` | local + `steps.read` | tokens for the developer's own sign-in; only the branch's feature workspace, never ACC or PRD |
| apply | `--apply` | plan + `steps.apply` | the same, and only the feature workspace of the current branch |

A step that is in no list never runs. Steps run in pipeline order. After a failed step later local and read steps still
run (marked `afterFailure`), so every problem shows in one go; apply steps never run after a failed or blocked step.

## team.yaml

```yaml
preflight:
  source:
    repository: shared-templates     # holds the pipeline YAML and the scripts; default: the current repository
    ref: main                        # the branch the pipeline uses; preflight runs origin/<ref>
  job: cicd/deploy.yaml              # the YAML whose steps preflight runs (path in the source repository)
  watch: ["jobs/**", "ddl/**"]       # the files this is about
  python: python                     # PythonScript@0 interpreter; default python on Windows, python3 elsewhere
  shell: bash                        # script: steps: bash | cmd | pwsh; default bash when found, else the platform shell
  setup: ["python -m pip install ."] # run in the source checkout, once per commit of it and of its dependency files
  parameters:
    workspaceName: "DEV-test-project {branchName}"
  variables:
    ENVIRONMENT: dev
    WORKSPACE_ID: "{workspaceId}"
  tokens:
    ACCESS_TOKEN: fabric             # fabric | onelake | sql | powerbi | kusto
    ONELAKE_STORAGE_TOKEN: onelake
  steps:
    local: [Validate configs]
    read: [Get workspace ids]
    apply: [Publish items]
    skip: [Connect workspace to Git] # known, never run here (no drift warning)
  apply:
    refuseWorkspaces: ["*-shared"]
    destructive:
      - step: Get workspace ids
        pattern: "DROP|will be removed"
  cd:
    pipeline: test-project-cd        # optional: --apply waits while this pipeline runs on the branch (--force overrides)
```

Placeholders in `parameters` and `variables`: `{repo}`, `{branch}`, `{branchName}` (last path segment), `{head}` (the
snapshot commit), `{lastPushed}` (the branch's upstream commit; the merge base with the target when never pushed),
`{workspace}` and `{workspaceId}` (only with `--plan`/`--apply`), `{sources}`, `{work}` and `{source}` (folders, below).

Start with `aihub preflight steps --job <path> [--source <repo>]`: it lists every step with its kind, works without a
`preflight:` block and runs nothing. Put each runnable step under `local`, `read`, `apply` or `skip`.

## Where it runs

Never in your working tree. Preflight keeps a scratch area in the git common folder (`<.git>/aihub/preflight/`, never
committed), laid out like an Azure Pipelines multi-checkout:

- `s/<your repository>`: a detached worktree at a snapshot commit of your working tree, with uncommitted, staged and
  untracked (not ignored) files. The snapshot is made with a temporary index; your index and files are not touched.
- `s/<source repository>`: the source repository at `origin/<ref>`, from its local clone (found like the other
  cross-repository commands, fetched first unless `--no-fetch`). The output names the commit and when it was fetched.

Steps may write there freely; each run resets both checkouts (ignored files such as a virtual environment stay).
`git worktree list` shows the two detached worktrees. `--verbose` prints the scratch path and every output line.

## Variables

`$(Name)`, `${{ parameters.x }}` and `${{ variables.x }}` are expanded in arguments, env values, inline scripts and
working directories, from (in this order) outputs of earlier steps, `preflight.variables`/`parameters`, the YAML's own
compile-time `variables:`, the built-ins (`Build.SourcesDirectory`, `Build.Repository.Name`, `Build.SourceBranch`,
`Build.SourceBranchName`, `Build.SourceVersion`, `Build.BuildId`, `Pipeline.Workspace`, `System.StageName`,
`System.StageAttempt`, `System.Debug` (false), `System.DefaultWorkingDirectory`, `Agent.TempDirectory`; also as environment variables such as
`BUILD_SOURCESDIRECTORY`), then token variables. A step that needs a variable nobody can fill is `blocked` with its
name: add one line to `preflight.variables`, or, when a read step sets it, list the step under `steps.read` so it
runs after that step with `--plan`. A more complex template expression makes the step "not run: cannot
evaluate". In an inline script an all-lowercase `$(name)` nobody defines is left alone (shell command substitution).

Steps hand values on with `##vso[task.setvariable variable=NAME;isOutput=true;issecret=true]VALUE`, as on the agent
(also as `<stepName>.NAME`). Secret values and all tokens are masked in everything preflight prints or returns, and an
inline script (written to `Agent.TempDirectory` with its variables expanded) is deleted when its step ends.
`##vso[task.logissue]` lines become the step's issues; `##vso[task.complete result=Failed]` or a non-zero exit fails it.

Conditions: `succeeded()`, `always()`, `failed()`, `and`, `or`, `not`, `eq`, `ne`, `startsWith`, `endsWith`,
`contains`, `in`, `variables['X']`, `variables.X` and literals. Anything else, or a variable preflight does not know,
is `notRun` with "condition could not be evaluated".

## Drift: when the pipeline changes

Preflight reads the YAML and the scripts of `origin/<ref>` every run, so most changes come along by themselves.

- A runnable step in no list is `unknown`: not run, and every later step is `uncertain` (it may depend on it). An
  uncertain apply step does not run. Several such steps are named in one line.
- A listed name that is not in the YAML is a warning.
- A renamed step is recognised by its fingerprint (kind, script path, arguments, env names, inline text): "looks renamed
  from A to B".
- A changed script of a read or apply step is mentioned once.

The fingerprints are kept in `state.json` in the scratch area.

## Safety rules

- Local steps never get a token; a local step that asks for one is `blocked` ("listed as local but asks for token X").
  The inherited environment never carries your aihub tokens or PATs to any step.
- `--plan` refuses a workspace classified ACC or PRD, with no override. `--apply` writes only to the feature workspace
  of the current branch (the branch rule of `aihub fabric`, `--workspace W` may name it, the same guards apply), never
  to a workspace classified test, acc or prd, never to one matching `apply.refuseWorkspaces`. A branch without a
  workspace is told how the first one comes to exist: the team's CD after the first push.
- `apply.destructive`: when the named read step's output matches the pattern, `--apply` stops before the first apply
  step until you pass `--yes`.
- `cd.pipeline`: `--apply` waits while a run of that pipeline is queued or in progress on the branch (`--force`
  overrides); a lookup that fails is a note, not a stop.
- Write-call check of read steps: preflight searches the script of each read step (and, for Python, the local modules
  it imports, one level) for HTTP writes (POST, PUT, PATCH, DELETE patterns) and remembers what it found. When new
  call sites appear, the step does not run until `aihub preflight accept "<step>"`. This is a text search, not a
  guarantee: a write through a library call it does not recognise is not found.

## Output

Text: per level one line per step (status, name, seconds, the first issue or the reason), then drift and one verdict
line ("nothing was written" when no apply step ran). Under a failed step come the lines of its output that say why
(`| ...`: the lines that read like an error, else the last ones, at most 10, cut to 240 characters) and `log:` with the
file that holds all of its output (in `logs/` of the scratch area, secrets masked): a validator names the file and the
rule in the middle of its output, long before its last line. `--json`: see [cli-json.md](cli-json.md). The exit code is 1 when
a step failed or was blocked, or apply was held back. `--step "<name>"` runs up to and including that step.
`--dry-run` runs nothing and prints each step with its level and expanded command (secrets masked).

## Limits

- Only what the YAML says can run locally: `script`, `bash`, `pwsh`, `powershell`, `PythonScript@0`, `PowerShell@2`,
  `Bash@3`, `CmdLine@2`. Other tasks (`checkout`, `UsePythonVersion@0`, `PublishPipelineArtifact@1`, `AzureCLI@2`, ...)
  are listed and, when a team lists one, reported as "cannot run this kind of step".
- Runtime expressions (`$[ ... ]`), variable groups and variable templates are not read; put the values a step needs
  in `preflight.variables`.
- Read and apply steps run as you, with your sign-in (the identities of `aihub fabric`), not as the pipeline's service
  principal: something can pass for you and fail in the CD, or the other way round.
- Preflight does not stop a local step from using the network; it only never hands it a token.
