# Azure Pipelines YAML, concise

## Structure
`trigger` / `pr` / `schedules` -> `parameters` / `variables` -> `resources` -> `stages` > `jobs` > `steps`. A file with only `steps:` gets one implicit stage and job. Every level takes `displayName`, `condition`, `dependsOn`.

```yaml
trigger: { branches: { include: [main, release/*] }, paths: { exclude: [docs/*] } }
pr: [main]                       # branch policies also queue builds: do not duplicate both without need
pool: { vmImage: ubuntu-latest }
stages:
- stage: Test
  jobs:
  - job: pytest
    steps:
    - checkout: self
    - script: pytest -q --junitxml=junit.xml
    - task: PublishTestResults@2
      condition: succeededOrFailed()
      inputs: { testResultsFiles: junit.xml, failTaskOnFailedTests: true }
```

## Templates and extends
- `- template: templates/test.yml` (steps, jobs or stages template) with `parameters:`; from another repo: `template: t.yml@tpl` plus `resources: repositories: [{repository: tpl, type: git, name: <project>/<repo>}]`.
- `extends: template: base.yml` enforces a shape: teams that require it list it in team.yaml `requiredTemplates`; `aihub pipeline validate` reports a missing one.
- Template expressions `${{ }}` resolve at compile time, macros `$(var)` at run time, runtime expressions `$[ ]` at run time. A parameter is compile time; a variable is run time.

## Parameters vs variables
`parameters:` are typed and visible on the run screen (`type: string|boolean|number|object|step`, `values:`). `variables:` are strings. Queue-time values show in `aihub pipeline vars --run N`.

## Conditions and ordering
Default condition is `succeeded()`. Use `succeededOrFailed()` for publishing, `eq(variables['Build.SourceBranch'], 'refs/heads/main')` for branch gates. `dependsOn: []` removes the implicit order and starts a stage at once; `dependsOn: [A, B]` waits for both. Outputs between jobs: `##vso[task.setvariable variable=x;isOutput=true]`, read as `dependencies.<job>.outputs['<step>.x']`.

## Variable groups and Key Vault
`variables: - group: vg-dev`. Key Vault secrets arrive through a Key Vault linked group (`aihub library create --keyvault <connection>/<vault> --secrets a,b`). Secrets are not in the environment: map them (`env: { TOKEN: $(token) }`). The pipeline must be authorized for the group (`aihub library authorize`).

## Environments and deployment jobs
```yaml
- stage: Deploy
  jobs:
  - deployment: app
    environment: dev            # approvals and checks live on the environment
    strategy: { runOnce: { deploy: { steps: [ { script: ./deploy.sh } ] } } }
```
First use needs authorization: `aihub pipeline authorize --pipeline P --resource environment:dev`. A run waits on `aihub pipeline approvals list`; ACC and PRD approvals are the developer's.

## Caching and speed
`Cache@2` with `key: 'pip | "$(Agent.OS)" | requirements.txt'` and `path: $(Pipeline.Workspace)/.pip`. Shallow checkout: `fetchDepth: 1`. Run slow tests in parallel jobs with `strategy: matrix`.

## Tests and coverage
`PublishTestResults@2` (JUnit, NUnit, VSTest) makes `aihub pipeline tests` work; `PublishCodeCoverageResults@2` makes `aihub pipeline coverage` work. Publish artifacts with `publish: $(Build.ArtifactStagingDirectory)` (`artifact: drop`).

## Common errors -> fixes
| Message | Cause and fix |
|---|---|
| `File /ci/x.yml not found in repository ... branch` | the YAML is not on that branch: push it or `--branch` |
| `Unexpected value 'stepz'` (Line, Col) | key typo or wrong level; check the indentation |
| `A template expression is not allowed in this context` | `${{ }}` used where only run-time values exist; use `$(var)` or a parameter |
| `Job X depends on unknown job Y` | name mismatch in `dependsOn`; names are case sensitive |
| `Could not find a pool with name` / no agent | wrong pool name or no agent: `aihub devops pools` |
| `Resource not authorized` / `Environment ... could not be found` | authorize the pipeline for the resource (above) |
| `Variable group ... could not be found or is not authorized` | `aihub library show/authorize`, spelling of the group |
| `Required template ... not found in expanded YAML` | the team requires an `extends`/`template`; add it |
| Task fails but exit code is 0 | script ignored an error: `set -euo pipefail` in bash, `$ErrorActionPreference = 'Stop'` in PowerShell |
