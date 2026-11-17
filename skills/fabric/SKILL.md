---
name: fabric
description: "Use when work touches Microsoft Fabric: 'maak een notebook aan in DEV', 'lees de tabellen van lakehouse X', 'draai pipeline Y in mijn workspace', 'wat is de status van run ...', 'waarom faalde de run', 'create a notebook in DEV', 'show the logs of the failed job', 'pull the branch into the workspace'."
---
# Fabric: read, run and write

## When
The user wants to look at, change or run something in a Fabric workspace. Reads work in every workspace you can access; writes and runs only outside ACC and PRD. A workspace is a name or id.

## Steps
1. Orient: `aihub fabric workspaces --filter test`, then `aihub fabric items --workspace DEV-test-project --type Notebook`.
2. Run and follow: `aihub fabric run --workspace DEV-test-project --item nb_load --wait`. A failure prints the dig-deeper command: `aihub fabric logs --workspace DEV-test-project --item nb_load --job <id>`.
3. What failed lately: `aihub fabric logs --workspace DEV-test-project --since 24h --status failed [--search text] [--tail 50]`.
4. Write, always look first with `--dry-run`: `aihub fabric item create --workspace DEV-test-project --type Notebook --name nb_new --definition-dir fabric/nb_new.Notebook`, `item update`, `item rename`, `item delete --yes`, `git update|commit`.
5. After code changes: `aihub fabric plan --check-workspace` lists the items to create or update, with the commands.
6. Data and rest: `aihub fabric onelake list --lakehouse lh_test`, `dax|kql|graphql --item X --query ...`, `aihub fabric api list` for every other tool.

Service principal (secret in the credential store): `aihub fabric auth sp add ci --tenant T --client-id C --secret-from-stdin`, then `aihub fabric items --workspace DEV-test-project --sp ci`; `auth status` says who you are.

## What the CLI fills
Workspace and item ids (from names), the default workspace of the branch, the token, long-running-operation polling, paging and 429 retries.

## If it fails
ACC and PRD are refused (`--allow-env acc` only when the user asked). 403: the account lacks access. Not signed in: `az login`, `aihub fabric auth status`. A missing endpoint is reported per section. All commands and flags: [reference](references/fabric-commands.md).

Rules: direct task, 0 questions, never ACC or PRD, `--json` when you parse.
