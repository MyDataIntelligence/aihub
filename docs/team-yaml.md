# team.yaml

`team.yaml` holds everything the CLI needs to know about one team. It lives in the team repository at
`.agents/skills/_shared/references/team.yaml` and is created by `aihub init` (proposed as a pull request, never
overwriting an existing file). The generic pack never contains team knowledge.

The documented schema is [`skills/_shared/references/team.schema.yaml`](../skills/_shared/references/team.schema.yaml).
Templates are separate files next to it (stories, commits) or in the repo (`.azuredevops/pull_request_template.md`).

## Synthetic example

```yaml
version: 1                                                      # schema version
language: nl                                                    # language of stories, PR text and comments

azureDevOps:                                                    # where the CLI talks to
  organization: ferron-test                                     # Azure DevOps organization
  project: test-project                                         # Azure DevOps project

repositories:                                                   # repositories of this team
  - name: test-project                                          # repository name in Azure DevOps
    aliases: [tp]                                               # short names people may say
    defaultTarget: main                                         # branch a new PR targets
    releaseBranches: ["release/*"]                              # release branch patterns

pullRequest:                                                    # pull request settings
  template: .azuredevops/pull_request_template.md               # PR template path
  title: "{storyId}: {storyTitle}"                              # PR title pattern
  emptySection: "Niet van toepassing"                           # text for an empty template section

workItems:                                                      # work item settings
  storyType: User Story                                         # work item type of a story
  storyTemplate: .agents/skills/_shared/assets/story-template.md# story template path
  templates:                                                    # optional: Bug and Task templates for `aihub workitem create`
    Bug: .agents/skills/_shared/assets/bug-template.md
    Task: .agents/skills/_shared/assets/task-template.md

branches:                                                       # branch rules
  feature: "feature/{storyId}-{slug}"                           # feature branch pattern
  protected: [main, "release/*"]                                # branches the CLI never pushes to

cherryPick:                                                     # cherry-pick settings
  groups:                                                       # named sets of target branches
    supported: ["release/1.2", "release/1.3"]                   # group usable as --to supported

pipelines:                                                      # pipelines to follow
  - repository: test-project                                    # repository the pipeline belongs to
    name: test-project-ci                                       # pipeline name
    required: true                                              # a red run blocks the PR
```

## Fields

| Key | Meaning |
|---|---|
| `language` | Language of generated stories, PR text and comments. |
| `azureDevOps` | Organization and project the CLI talks to. |
| `repositories[]` | Repository name, spoken aliases, default PR target and release branch patterns. |
| `pullRequest` | PR template path, title pattern and the text for empty sections. |
| `workItems` | Story type, story template and the states `aihub story start` (`states.active`, default Active) and `aihub story finish` (`states.finished`, default Done) set. |
| `branches` | Feature branch pattern and protected branches. |
| `cherryPick.groups` | Named sets of target branches for `aihub cherry-pick --to <group>`. |
| `pipelines` | Pipelines to follow per repository. |
| `guidelines` | Optional list of repository files (for example `docs/CONTRIBUTING.md`) the generic skills tell the agent to read first; `aihub doctor` checks they exist. |

Check the file with `aihub doctor`. Change it through a pull request (see [onboarding](onboarding.md)).

## Tests of the changed files (optional)

```yaml
tests:
  command: "python -m pytest {tests}" # {tests} becomes the quoted test files; default python -m pytest for .py (puts the repo root on sys.path, so top-level packages import), npx vitest run for JS/TS
  map:                             # rules for code the name/import heuristics do not match
    - source: "etl/**"             # changed files matching these globs (a string or a list)
      tests: "tests/etl/**"        # run the repository files matching these globs
```

`aihub test changed [--base <branch>] [--run]` lists the tests that belong to what the branch changed (committed since the merge base with the target,
uncommitted and untracked files) and with `--run` runs only those. Without `tests:` it uses the defaults: for Python `test_<module>.py`, `<module>_test.py` and test
files that import the module; for JS/TS `<name>.test.ts`, `<name>.spec.ts` and specs that import the file; a changed test file runs itself. Code without a test is
listed, docs and config are ignored, and it never falls back to the whole suite: the pipeline runs that.

## Data before/after in the PR (optional)

```yaml
dataChecks:
  item: lh_orders              # Lakehouse or Warehouse that exists in both workspaces
  baseline: DEV-shared         # optional; default: the workspace of the PR's target branch, else the dev workspace
  feature: DEV-anna            # optional; default: the workspace whose fabric.workspaces branches match the source branch
  tables:
    - name: gold.orders
      count: true
      nulls: [customer_id]
      sums: [amount]
      distinct: [customer_id]
      sql: ""                  # optional custom SELECT (one row, every column a metric)
```

`aihub pr data-diff [--pr N] [--write] [--baseline W] [--feature W] [--json]` runs the same read-only checks in the baseline and the feature workspace and prints a before/after table with deltas
and a one-line verdict. Identifiers are validated (plain letters, digits, underscore), a custom SELECT goes through the same read-only guard as `aihub fabric sql`. It reads through the SQL endpoint
(`fabric sql`) and falls back to Livy (Spark SQL in the Lakehouse), and says which one it used. ACC and PRD workspaces are refused. `--write` replaces the PR section "Data before/after"
("Data vóór/na" for a Dutch team, or `dataChecks.section`) with the table, like Changes it is code-owned.

## Fabric and Robot (optional)

```yaml
fabric:                                  # optional: every workspace you can access works without this section
  workspaces:                            # optional shortcuts and branch rules (also fixes the environment of a workspace)
    - name: DEV-test-project             # workspace display name
      environment: dev                   # dev | feature | test | acc | prd; acc and prd are never run by the CLI
      branches: ["feature/*"]            # branch patterns whose changes are tested in this workspace
    - name: DEV-shared                   # a second dev workspace for the same branches
      environment: dev                   # same rules as above
      branches: ["feature/*"]            # a branch matching several workspaces is run in each of them
    - name: ACC-test-project             # a workspace the developer runs by hand
      environment: acc                   # refused by `aihub fabric run` unless --allow-env acc
  workspaceGroups:                       # named sets of workspaces for `aihub fabric run --workspaces <name>`
    devs: [DEV-test-project, DEV-shared] # group name and the workspace names in it
    ci:                                  # object form: the same group with a service principal
      workspaces: [DEV-test-project]     # the workspace names in the group
      servicePrincipal: ci-runner        # name of a service principal registered on the user machine (secret never here)
  branchWorkspacePrefixes: [team data]   # prefixes of per-branch workspaces "<prefix> <branch label>" for `aihub fabric failures`

robot:                                   # Robot integration tests for `aihub robot`
  pipeline: test-project-robot           # Azure DevOps pipeline that runs the Robot suites
  defaultTarget: feature                 # target used when `aihub robot run` has no --on
  targets:                               # named places to run Robot
    feature:                             # name to say: "draai Robot op feature"
      branch: integration                # branch the pipeline runs on
      mergeMyBranchFirst: true           # true: merge my current branch into this branch and push it, then run
      mustAlreadyContain: [staging]      # branches that must already be merged into it; merged in first when behind
    staging:                             # name to say: "test op staging"
      branch: staging                    # branch the pipeline runs on
      mergeMyBranchFirst: false          # false: run the branch as it is, merge nothing
  suites:                                # Robot suites, one per flow
    - name: orders                       # suite name, passed to the pipeline as parameter `suite`
      paths: ["src/flows/orders/**"]     # path patterns of the flow this suite covers
      tests: ["tests/robot/orders/**"]   # path patterns of this suite's Robot files
```

| Key | Meaning |
|---|---|
| `fabric.workspaces[]` | Optional. Name, optional id, `environment` and optional `branches` patterns (the default workspace of a branch). Without an entry, any workspace the signed-in user can access is used by name or id, and its environment is read from the name (`acc`, `acceptance`, `prd`, `prod`, `production` mark ACC and PRD). Writes and runs are refused in `acc` and `prd` (and `test` when listed) unless `--allow-env` names that environment. |
| `fabric.workspaces[].servicePrincipal` | Optional name of a service principal registered on the user's machine (`aihub fabric auth sp add`). Only the name lives here; tenant, client id and secret are in the user config and credential store. `--sp` and the environment variables still win. |
| `fabric.branchWorkspacePrefixes` | Prefixes of the per-branch workspaces `aihub fabric failures --branch B` looks for ("<prefix> <branch label>", compared without case and punctuation; repository names count as prefixes too). Two workspaces with the same normalised name are ambiguous and give no match. |
| `fabric.workspaceGroups` | Named lists of workspace names. `aihub fabric run --item X --workspaces devs` runs X in every workspace of the group; `--workspace a --workspace b` does the same ad hoc. The result is one table per workspace and a failure in one does not stop the others. `aihub fabric plan` lists every workspace the branch rules match. |
| `robot.pipeline` | Azure DevOps pipeline that `aihub robot run` queues (override with `--pipeline`). |
| `robot.targets` | Named branches to run Robot on. `mergeMyBranchFirst: true` merges the current branch into the target branch (in a temporary worktree, never your checkout) and pushes it before the run; a merge conflict stops the run and pushes nothing. `mustAlreadyContain` lists branches that must be in the target branch first. |
| `robot.defaultTarget` | The target used without `--on`. `aihub robot run --on staging` picks a target by name; an unknown name is taken as a branch that is run as it is. `aihub robot targets` lists them. |
| `robot.integrationBranch`, `robot.integrationBranches[]`, `robot.integrationRequires` | Older form of one merge target (a branch, optionally per repository, and the branches it must already contain). Used when `robot.targets` is absent. |
| `robot.suites[]` | Suite name, `paths` of the flow it covers and `tests` (its Robot files). `aihub robot needed` compares the branch diff with these patterns. |

`aihub robot run --no-merge` skips the merge for one run. Fabric items are found by the git-integration folder convention (`<name>.Notebook/`, `<name>.DataPipeline/`). Fabric auth: `az login` or the environment variable `AIHUB_FABRIC_TOKEN`.

## Cross-repo (optional)

```yaml
repositories:                            # repositories[] may also carry a local clone path
  - name: test-project                   # repository name in Azure DevOps
    aliases: [tp]                        # short names people may say
    defaultTarget: main                  # branch a new PR targets
  - name: test-developers                # second repository of the team
    aliases: [developers]                # "port naar developers"
    defaultTarget: main                  # branch a ported change targets
    path: ../test-developers             # optional local clone; default: sibling directory, else a temporary clone

crossRepo:                               # settings for `aihub port` and `aihub crossrepo`
  pathMaps:                              # named path mappings for `aihub port --map dev`
    dev:                                 # name to say
      - from: src/app                    # directory prefix in the source repository
        to: lib/app                      # directory prefix in the target repository
  testTarget:                            # default target of `aihub crossrepo test-resources`
    repo: test-developers                # repository that receives the resources
    branch: integration                  # its active test branch (never a protected branch)
  testResources:                         # what is copied
    fromRepo: test-project               # repository the resources come from
    paths: ["tests/data/**"]             # globs relative to the source repository root
    toPath: resources                    # optional directory prefix in the target repository
```

| Key | Meaning |
|---|---|
| `repositories[].path` | Local clone of that repository (absolute, or relative to the current repository). Without it the CLI looks for a sibling directory with that origin and otherwise clones temporarily. |
| `crossRepo.pathMaps` | Named lists of `from`/`to` directory prefixes. The longest `from` wins; files outside every map are reported, never dropped silently. `aihub port --path-map "src=>dst"` adds an ad-hoc map. |
| `crossRepo.testTarget` | Repository and active branch that `aihub crossrepo test-resources` pushes to when `--to-repo`/`--target` are absent. |
| `crossRepo.testResources` | Source repository, glob list and optional target directory prefix for the same command. |

`aihub port` writes a new branch `port/<source>-from-<repo>` in the target repository (a conflict pushes nothing); `aihub crossrepo status|link-prs --story N` follow a story over several repositories. See the `cross-repo` skill.
