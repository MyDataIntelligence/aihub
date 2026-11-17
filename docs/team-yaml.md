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

Check the file with `aihub doctor`. Change it through a pull request (see [onboarding](onboarding.md)).

## Fabric and Robot (optional)

```yaml
fabric:                                  # Fabric workspaces for `aihub fabric`
  workspaces:                            # list of workspaces the CLI may know about
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
| `fabric.workspaces[]` | Name, optional id, `environment` and optional `branches` patterns. `aihub fabric run` only runs `dev` and `feature`; `acc` and `prd` need `--allow-env` and are run by the developer. |
| `fabric.workspaceGroups` | Named lists of workspace names. `aihub fabric run --item X --workspaces devs` runs X in every workspace of the group; `--workspace a --workspace b` does the same ad hoc. The result is one table per workspace and a failure in one does not stop the others. `aihub fabric plan` lists every workspace the branch rules match. |
| `robot.pipeline` | Azure DevOps pipeline that `aihub robot run` queues (override with `--pipeline`). |
| `robot.targets` | Named branches to run Robot on. `mergeMyBranchFirst: true` merges the current branch into the target branch (in a temporary worktree, never your checkout) and pushes it before the run; a merge conflict stops the run and pushes nothing. `mustAlreadyContain` lists branches that must be in the target branch first. |
| `robot.defaultTarget` | The target used without `--on`. `aihub robot run --on staging` picks a target by name; an unknown name is taken as a branch that is run as it is. `aihub robot targets` lists them. |
| `robot.integrationBranch`, `robot.integrationBranches[]`, `robot.integrationRequires` | Older form of one merge target (a branch, optionally per repository, and the branches it must already contain). Used when `robot.targets` is absent. |
| `robot.suites[]` | Suite name, `paths` of the flow it covers and `tests` (its Robot files). `aihub robot needed` compares the branch diff with these patterns. |

`aihub robot run --no-merge` skips the merge for one run. Fabric items are found by the git-integration folder convention (`<name>.Notebook/`, `<name>.DataPipeline/`). Fabric auth: `az login` or the environment variable `AIHUB_FABRIC_TOKEN`.
