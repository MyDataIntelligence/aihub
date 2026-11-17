# Fabric and Robot reference

## Commands

| Command | Does |
|---|---|
| `aihub fabric plan [--branch B] [--target T] [--workspace W]` | Maps changed files (`<name>.Notebook/`, `<name>.DataPipeline/`, lakehouse items) to Fabric items, ordered: dependencies, notebooks, pipelines. |
| `aihub fabric run --item N [--workspace W] [--params-file F] [--wait]` | Starts a notebook or pipeline job; with `--wait` polls and prints status and the failure reason. |
| `aihub fabric status --item N --job ID [--workspace W]` | Status of one job. |
| `aihub robot needed [--branch B]` | Which suites cover a changed flow, and whether a test changed with it. |
| `aihub robot run [--suite S] [--include tag] [--pipeline P] [--no-wait]` | Queues the team Robot pipeline on the integration branch and prints the results summary. |

## Environments

`dev` and `feature` workspaces run without a flag. `test`, `acc` and `prd` are refused with one line unless `--allow-env <env>` is passed, and that only when the developer asked for it in this session. A workspace that is not in the team file is refused.

## Parameters file

JSON map, for example `{"limit": 10, "full_load": false}`. Notebooks get typed parameters, pipelines get the map as is.

## PR tests section

One line per run: what ran, where (workspace or pipeline), result. Anything not run: "nog niet uitgevoerd".
