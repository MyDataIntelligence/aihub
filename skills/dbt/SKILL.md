---
name: dbt
description: "Use when the repo is a dbt project (dbt_project.yml) and the user wants models built, tested, checked or explained: 'draai dbt', 'run the dbt tests', 'waarom faalt deze dbt test', 'wat raakt deze model-wijziging', 'maak yaml voor dit model', 'dbt impact'."
---
# dbt

## When
A `dbt_project.yml` is in the repository. Local dbt runs through `aihub dbt`; Fabric writes go through `aihub fabric dbt run --workspace <ws>`.

## Steps
1. Orient: `aihub dbt detect` (project, adapter, versions, last run). Setup problems: `aihub dbt check`.
2. Run only what changed: `aihub test changed --run`, or by hand:

```sh
aihub dbt impact --base main
aihub dbt build --select "stg_orders+ mart_orders"
aihub dbt test --select state:modified+ --state prod-state --defer
```

3. A failure: `aihub dbt failures` shows the failed test, its compiled SQL and the first 5 failing rows. Fix the cause (model, data, or an expectation that is really wrong); never delete or loosen a test to get green.
4. Models need YAML: `aihub dbt yaml check`, then `aihub dbt yaml scaffold <model> --write` (add `--unit-test` for models with real logic) and fill in the TODO descriptions.
5. In a PR with dbt changes: `aihub dbt impact --write` puts the affected models, tests and exposures in the PR.

Fabric target (adapter `fabric` or `fabricspark`): `aihub dbt build` refuses; use `aihub fabric dbt run --workspace <your DEV or FEATURE workspace> --command build --select "stg_orders+"`. Reads (`test`, `compile`, `show`, `ls`) work locally.

## What the CLI fills
Project folder, profile target, `--project-dir`, `.env`, the selector words for the changed models. Do not ask for them.

## If it fails
`capacity is full` (HTTP 430): `aihub fabric spark sessions --workspace <ws>`, stop an idle one, run again. No dbt found: install dbt in the project `.venv`. Errors and selectors: [dbt reference](references/dbt.md).

Rules: never print profile secrets; never run against ACC or PRD; a model change without its tests run is "nog niet uitgevoerd" in the PR.
