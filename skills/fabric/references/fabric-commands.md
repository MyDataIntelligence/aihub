# Fabric commands

Every command takes `--workspace <name|id>` (any workspace you can access; the default is the branch rule in `team.yaml`), `--json` (one compact line; the text form is the default and enough for an agent), and writes take `--dry-run`. Names are matched case-insensitively; a miss prints "did you mean". `aihub fabric help` is one short screen, `aihub fabric help <look|run|why|change|git|data|admin>` the detail; a wrong command gets its one usage line.

| Area | Command |
|---|---|
| Read | `workspaces [--filter]`, `workspace show\|roles`, `items [--type T]` (a lakehouse's own SQL endpoint is shown as `Lakehouse (+SQL endpoint)`, not as a second item; `--type SQLEndpoint` lists them), `item show\|definition [--out dir]`, `capacities`, `connections`, `gateways` |
| Run history | `jobs --item I [--top N]`, `job show\|cancel --job ID`, `status --item I --job ID [--wait]` (`--wait`: until it ends, with the cause on failure), `schedules --item I` |
| Logs | `logs --workspace W [--since 24h] [--status failed] [--item I] [--search t] [--tail N]`; with `--item I --job ID`: a digest of a few hundred bytes (scheduler failure, failed cell, exception, likely cause, error excerpt, Spark session, pipeline activity runs, the size of each raw log); `--out <file>` writes every line of every log to a file, `--search t`/`--tail N` print a window (capped at 16 KB). Semantic model: refresh history. An unavailable endpoint is reported, not fatal |
| Lakehouse | `lakehouse tables\|files --lakehouse L [--path P]`, `shortcuts --lakehouse L`, `lakehouse load\|maintenance --table T` |
| Write | `item edit --item I (--set name=value \| --replace old --with new \| --replace-file F --with-file F) [--part P] [--run --wait]` (changes the definition in place: the text must occur exactly once, else nothing is written; `--set` keeps the quotes of the current value; `.platform` is left alone), `item create --type T --name N [--definition-dir D] [--description]`, `item update --item I --definition-dir D`, `item rename --name N`, `item delete --yes`, `run --item I [--params-file F] [--wait]` (`--wait`: the end result, and on failure the root cause chain in the same output), `run --cancel ID`, `workspace create\|assign-capacity\|delete --yes`, `environment publish\|libraries` |
| Git | `git status`, `git update`, `git commit [--message "text" \| --message-file F]` (no message: "Update <item> from Fabric workspace W"; prints what it committed, the new head and whether the workspace is clean) |
| Deploy | `deployment list`, `deployment stages --pipeline P`, `deployment deploy --pipeline P --from-stage S --to-stage T` |
| OneLake | `onelake list\|read\|write\|mkdir\|delete\|move --lakehouse L --path P [--to P2] [--text T\|--file F] [--yes]` |
| Queries (read-only) | `dax --item MODEL --query "EVALUATE ..."`, `kql --item DB --query "T \| take 10"`, `graphql --item API --query "{ ... }"`; `--query-file`, `--top N` |
| Failures | `failures [--branch B] [--workspace W] [--item I] [--since-green]`: newest failed and active runs of the branch workspace (name `<prefix> <branch label>`, prefixes from `fabric.branchWorkspacePrefixes` and repository names) and the root cause chain pipeline, child pipeline, notebook, Spark driver log with the failed cell and a likely cause (out-of-memory, missing column, missing table, missing library, permission, timeout, capacity, Delta conflict, ...) |
| Since green | `failures --since-green [--item I]`: after the failures output, what changed since the last green run of the failed item: the window (red start, last green end), the CD deployments in it (`fabric.environments.<ENV>.deployedBy`), the commits from the code of the green run to the code of the red run, other repository versions of the runs, and suspects first (touches the failed item or the failing leaf, an item it calls, or a configuration file named like it), with PR and stories; outcome `suspects`, `deployedUnrelated`, `nothingDeployed`, `noGreenRun`, `notConfigured` or `unavailable` |
| Deployed | `deployed --workspace W \| --env ENV`: which commit runs in a CD-filled workspace: the newest run of `deployedBy.pipeline` on the environment branch whose `deployedBy.stage` succeeded, with run, finish time, trigger, PR, stories and other repository versions. team.yaml: `fabric.environments.<ENV>: { branch, workspace: "Fabric {repo} test", deployedBy: { pipeline, stage } }`. A feature workspace is git-connected: use `git status` |
| Spark | `spark sessions [--item I] [--state s]`, `spark stop --session ID|--all-mine [--dry-run] [--yes]` (frees the capacity when `run` says TooManyRequestsForCapacity), `spark app --item I --job ID --view application|jobs|stages|tasks|executors|sql|environment|advice|resourceUsage [--status failed] [--stage N]`, `spark logs --item I --job ID [--log-type driver|executor|livy] [--file stderr] [--tail N] [--search re --context N] [--errors] [--cell] [--out file]` (the last 60 lines unless `--tail`, capped at 16 KB; the likely cause comes from the whole log) |
| Code and SQL | `livy run --lakehouse L --code ... [--kind sql|pyspark]` (closes its session; refuses code that names an ACC/PRD workspace), `sql --item WH --query ...` (one read-only SELECT, tedious with an Entra token), `udf invoke --item U --function f [--args-file]`, `notebook-test prepare|run|verify` (assert/print lines only, in notebooks named `AIHub E2E ...`) |
| dbt | `dbt detect|results`, `dbt scaffold --route warehouse|lakehouse|job`, `dbt run --workspace W --command build` (proves the profile target lives in that workspace first), `dbt upload`, `dbt save-job`, `dbt get-job` |
| Connections | `connection create|update --body-file F` (secrets only as `kv://vault/secret`), `connection delete --connection ID --confirm-name NAME` |
| Everything else | `api list [--filter x]`, then `api <tool> --workspace W --item I --arg name=value [--body-file f.json]` runs any legacy tool row (folders, tags, shortcuts, data access roles, data shares, private endpoints, Spark settings, mirroring, role assignments, connections ...). See `docs/fabric-inventory.md` in the aihub repository for each tool and its status. |
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
- "zet de regio op noord en draai opnieuw": `aihub fabric item edit --workspace DEV-test-project --item nb_load --set regio=noord --run --wait`
- "lees de tabellen van lakehouse lh_test": `aihub fabric lakehouse tables --workspace DEV-test-project --lakehouse lh_test`
- "pull de branch in mijn workspace": `aihub fabric git update --workspace DEV-test-project --dry-run`, then without `--dry-run`.
