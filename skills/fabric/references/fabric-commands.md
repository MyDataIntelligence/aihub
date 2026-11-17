# Fabric commands

Every command takes `--workspace <name|id>` (any workspace you can access; the default is the branch rule in `team.yaml`), `--json`, and writes take `--dry-run`. Names are matched case-insensitively; a miss prints "did you mean".

| Area | Command |
|---|---|
| Read | `workspaces [--filter]`, `workspace show\|roles`, `items [--type T]`, `item show\|definition [--out dir]`, `capacities`, `connections`, `gateways` |
| Run history | `jobs --item I [--top N]`, `job show\|cancel --job ID`, `status`, `schedules --item I` |
| Logs | `logs --workspace W [--since 24h] [--status failed] [--item I] [--search t] [--tail N]`; with `--item I --job ID`: scheduler failure, notebook/SJD Spark driver stderr/stdout with error excerpt, pipeline activity runs; semantic model refresh history. Each section names its source; an unavailable endpoint is reported, not fatal |
| Lakehouse | `lakehouse tables\|files --lakehouse L [--path P]`, `shortcuts --lakehouse L`, `lakehouse load\|maintenance --table T` |
| Write | `item create --type T --name N [--definition-dir D] [--description]`, `item update --item I --definition-dir D`, `item rename --name N`, `item delete --yes`, `run --item I [--params-file F] [--wait]`, `run --cancel ID`, `workspace create\|assign-capacity`, `environment publish\|libraries` |
| Git | `git status`, `git update`, `git commit --message-file F` |
| Deploy | `deployment list`, `deployment stages --pipeline P`, `deployment deploy --pipeline P --from-stage S --to-stage T` |
| Plan | `plan [--check-workspace]` maps changed `<name>.<Type>/` folders to create/update commands |

## Safety
The workspace name (or stage name) marks ACC and PRD: writes and runs there are refused before any call unless `--allow-env acc|prd` is given for that environment. A workspace opened by id is classified by its display name first. Deleting needs `--yes`. A deployment stage that is ACC/PRD, or the last of three or more stages, counts as production.

## Auth
`AIHUB_FABRIC_TOKEN`, else `az account get-access-token`. OneLake uses `AIHUB_ONELAKE_TOKEN`, semantic model refresh history `AIHUB_POWERBI_TOKEN` (else az, per resource).

## Examples
- "wat is de status van run 1234": `aihub fabric status --workspace DEV-test-project --item nb_load --job 1234`
- "lees de tabellen van lakehouse lh_test": `aihub fabric lakehouse tables --workspace DEV-test-project --lakehouse lh_test`
- "pull de branch in mijn workspace": `aihub fabric git update --workspace DEV-test-project --dry-run`, then without `--dry-run`.
