---
name: fabric
description: "Use when a question or task is about Microsoft Fabric (workspace, notebook, pipeline, lakehouse, run): 'wat staat er in mijn workspace', 'draai notebook X', 'draai hem en wacht', 'waarom faalde de run', 'mijn notebook is rood', 'zet de parameter op ...', 'commit de workspace naar git', 'what is in my workspace', 'run notebook X and wait', 'why did the run fail', 'change the notebook and rerun', 'wat is er veranderd sinds de laatste groene run', 'why did it fail now', 'welke commit draait in test'. No Fabric connector or tool is needed: run `aihub fabric ...` in the shell (aihub is on the PATH; `aihub fabric --help` lists the commands), also when this skill file cannot be read."
---
# Fabric: one command per task

## When
Anything in a Fabric workspace: look, run, explain a failure, change, commit. Names or ids work; without `--workspace` the branch default from `team.yaml` is used.

## Steps
Run the ONE command for the task (plain text: no `--json`, `--help` or reference first) and answer from its output:

| Task | Command |
|---|---|
| What is in a workspace | `aihub fabric items --workspace W` |
| Run and wait, "is hij gelukt?" | `aihub fabric run --workspace W --item I --wait` |
| Why did it fail, "is rood" | `aihub fabric failures --workspace W --item I` |
| Why now, "wat is er veranderd sinds de laatste groene run" | `aihub fabric failures --workspace W --since-green` |
| Which commit runs in this workspace | `aihub fabric deployed --workspace W` |
| Change a notebook and rerun | `aihub fabric item edit --workspace W --item I --set name=value --run --wait` |
| Commit the workspace to git | `aihub fabric git commit --workspace W --message "<what changed>"` |
| Pull the branch in | `aihub fabric git update --workspace W` |

Example: "Zet in notebook nb_orders de regio op noord en draai hem opnieuw" -> `aihub fabric item edit --workspace DEV-test-project --item nb_orders --set regio=noord --run --wait`

`run --wait` ends with the result and, on failure, the failed cell, the exception and the likely cause: no `status`, `logs` or `watch` after it. `item edit`: `--set` keeps the quotes; `--replace` needs text that occurs once. Leave double quotes out of the text (PowerShell drops them) or use `--replace-file F --with-file F`. 

## What the CLI fills
Ids, the token, waiting, the root cause, a commit message.

## If it fails
The error gives the one usage line or a "did you mean". ACC/PRD writes are refused. 403: no access. Not signed in: `az login`. Anything else (logs, lakehouse, sql, spark, deploy): `aihub fabric help`, or the [reference](references/fabric-commands.md).

Rules: 0 questions, never ACC or PRD.
