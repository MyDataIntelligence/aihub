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
Identity order: `--sp <name>`, env `AIHUB_FABRIC_SP`, env `AZURE_CLIENT_ID` + `AZURE_TENANT_ID` + `AZURE_CLIENT_SECRET` (or `AZURE_CLIENT_CERTIFICATE_PATH`), `fabric.workspaces[].servicePrincipal` in team.yaml (a name only), the user default service principal, `AIHUB_FABRIC_TOKEN`, then the `az login` user. A service principal signs in with the client-credentials flow and the scope of each resource (Fabric, OneLake/storage, SQL, Power BI); tokens are cached until shortly before they expire. Per-resource token overrides: `AIHUB_ONELAKE_TOKEN`, `AIHUB_POWERBI_TOKEN`, `AIHUB_SQL_TOKEN`.

| Command | Does |
|---|---|
| `auth status` | Who am I (user, token or service principal, tenant, source, expiry). `--json` output always carries an `identity` field; `--verbose` prints it on stderr. |
| `auth sp add NAME --tenant T --client-id C (--secret-from-stdin \| --cert file.pem \| --keyvault kv://vault/secret)` | Registers it in the user config (`fabric-sp.json` in the aihub home folder). The secret goes to the OS credential store (macOS keychain, secret-tool, Windows DPAPI) or stays a Key Vault reference read with `az`; never in the repo. |
| `auth sp list \| remove NAME \| default NAME \| default --clear \| test NAME` | Manage and test (sign in and list workspaces). |

The ACC/PRD refusal applies to a service principal exactly as to a user. Log output, errors and `--json` pass through secret redaction (SAS signatures, bearer tokens, client secrets, connection-string passwords, JWTs, private keys).

## Examples
- "wat is de status van run 1234": `aihub fabric status --workspace DEV-test-project --item nb_load --job 1234`
- "lees de tabellen van lakehouse lh_test": `aihub fabric lakehouse tables --workspace DEV-test-project --lakehouse lh_test`
- "pull de branch in mijn workspace": `aihub fabric git update --workspace DEV-test-project --dry-run`, then without `--dry-run`.
