---
name: fabric
description: "Use when work touches Microsoft Fabric: 'maak een notebook aan in DEV', 'lees de tabellen van lakehouse X', 'draai pipeline Y in mijn workspace', 'wat is de status van run ...', 'waarom faalde de run', 'create a notebook in DEV', 'show the logs of the failed job', 'pull the branch into the workspace'."
---
# Fabric: read, run and write

## When
The user wants to look at, change or run something in a Fabric workspace. Reads work in every workspace you can access; writes and runs not in ACC or PRD. A workspace is a name or id.

## Steps
1. Orient: `aihub fabric workspaces --filter test`, then `aihub fabric items --workspace DEV-test-project --type Notebook`.
2. Run: `aihub fabric run --workspace DEV-test-project --item nb_load` prints the job id; follow it with `aihub watch --fabric-job DEV-test-project/nb_load/<job id> --notify` (say "ik volg het op de achtergrond"; `--wait` only on request). A failure prints the dig-deeper command: `aihub fabric logs --workspace DEV-test-project --item nb_load --job <id>`.
3. What failed: `aihub fabric failures --branch feature/12-x` (root cause), or `aihub fabric logs --workspace DEV-test-project --since 24h --status failed`.
4. Write, always look first with `--dry-run`: `aihub fabric item create --workspace DEV-test-project --type Notebook --name nb_new --definition-dir fabric/nb_new.Notebook` (also `item update`, `item rename`, `item delete --yes`, `git update|commit`).
5. After code changes: `aihub fabric plan --check-workspace` lists the items to create or update.
6. Data: `aihub fabric sql --item wh_test --query "select ..."`, `onelake`, `dax|kql|graphql`, `livy run`, `spark logs`; every other tool: `aihub fabric api list`.

Service principal: `aihub fabric auth sp add ci --tenant T --client-id C --secret-from-stdin`, then `--sp ci`.

## What the CLI fills
Workspace and item ids, the branch default workspace, the token, polling, paging and 429 retries.

## If it fails
ACC and PRD are refused (`--allow-env acc` only when the user asked). 403: the account lacks access. Not signed in: `az login`, `aihub fabric auth status`. A missing endpoint is reported per section. All commands and flags: [reference](references/fabric-commands.md).

Rules: direct task, 0 questions, never ACC or PRD, `--json` when you parse.
