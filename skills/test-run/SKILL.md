---
name: test-run
description: "Use when the change must be tested in Fabric or with Robot: 'test dit in Fabric', 'run it in Fabric', 'draai de Robot-tests', 'run the Robot tests', 'moeten de integratietests draaien', before reporting tests in a PR."
---
# Run Fabric and Robot tests

## When
The branch changes Fabric items (notebooks, pipelines) or a flow with Robot integration tests, and the PR tests section needs real results.

## Steps
1. Fabric: see what to run, then run it in order and wait:

```sh
aihub fabric plan
aihub fabric run --item nb_load_orders --wait
```

Several workspaces ("in beide DEV's"): repeat `--workspace` or use `--workspaces <group>`.

2. Robot: check first, then run only when needed. The target comes from the sentence: "test op staging" is `--on staging`, "draai Robot op feature" is `--on feature`. No target named: use the team default, do not ask. Run merges your branch into a merge target first and stops on a conflict:

```sh
aihub robot needed
aihub robot run --on staging --suite orders
```

3. Parameters: `--params-file params.json` (Fabric), `--include <tag>` (Robot).
4. A failed run: read the failure line, fix the cause, run again. Never weaken a test.
5. Report in the PR tests section only what ran, with the result. Not run: write "nog niet uitgevoerd".

## What the CLI fills
Changed items versus the target, the workspace by branch rule, item and job ids, the pipeline and branch from the team file. Do not ask for ids.

## If it fails
Merge conflict: nothing was pushed; merge the target into your branch and fix it. `aihub robot targets` lists the targets; `--no-merge` skips the merge. Not signed in: `az login` or `aihub doctor`. Item not found: check the plan. Never run ACC or PRD: the developer does that; the CLI refuses them. Details: [Fabric and Robot reference](references/fabric-robot.md).

Rules: direct task, 0 questions. A new Robot test is only needed for a new or changed flow.
