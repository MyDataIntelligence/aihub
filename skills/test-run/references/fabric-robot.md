# Fabric and Robot reference

## Commands

| Command | Does |
|---|---|
| Other Fabric commands | Read, logs, write, git and deployment commands are in the `fabric` skill ([reference](../../fabric/references/fabric-commands.md)). |
| `aihub fabric plan [--branch B] [--target T] [--workspace W]` | Maps changed files (`<name>.Notebook/`, `<name>.DataPipeline/`, lakehouse items) to Fabric items, ordered: dependencies, notebooks, pipelines. |
| `aihub fabric run --item N [--workspace W]... [--workspaces GROUP] [--params-file F] [--wait]` | Starts a notebook or pipeline job; with `--wait` waits and prints the end result and, on failure, the root cause (failed cell, exception, likely cause) in the same output. Several `--workspace` flags or a team.yaml group run it in each workspace: one results table, errors in one workspace do not stop the others. |
| `aihub fabric status --item N --job ID [--workspace W] [--wait]` | Status of one job; `--wait` waits for a job that runs already (never start it again to wait). |
| `aihub robot needed [--branch B]` | Which suites cover a changed flow, and whether a test changed with it. |
| `aihub robot run [--on target\|branch] [--suite S] [--include tag] [--pipeline P] [--no-merge] [--no-wait]` | With a merge target: merges the current branch (and `mustAlreadyContain` branches that are behind) into the target branch in a temporary worktree, pushes it and lists the commits that went in; a conflict stops with the files and pushes nothing. Then queues the team Robot pipeline on that branch and prints the results summary. |
| `aihub robot targets` | Lists the named targets and the default. |

## Environments

`dev` and `feature` workspaces run without a flag. `test`, `acc` and `prd` are refused with one line unless `--allow-env <env>` is passed, and that only when the developer asked for it in this session. A workspace that is not in the team file is refused.

## Parameters file

JSON map, for example `{"limit": 10, "full_load": false}`. Notebooks get typed parameters, pipelines get the map as is.

## PR tests section

One line per run: what ran, where (workspace or pipeline), result. Anything not run: "nog niet uitgevoerd".
