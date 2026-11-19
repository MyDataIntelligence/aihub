# dbt inventory: what the old Hub and dbt Lens had, what a dbt developer needs, and where it lives now

Sources: the legacy Hub (`MyDataIntelligence/extensions`, tag `legacy/hub-surface-v2-2026-11-17`: `core/hub-core/.../fabric/dbt/{DbtCli,DbtGuide,DbtProjects,DbtYaml}.kt`, `mcp/McpFabricDbt*.kt`, `resources/dbt/dbt-guide.md`), the separate dbt Lens VS Code extension (`vscode/dbt-lens`: README and `contrib/*.json`), and what a dbt developer does every day.

Status words: **existing** (already in this CLI), **to build** (built with this inventory as `aihub dbt ...`, skill `dbt`), **out of scope** (with the reason).

## Rules that carry over

- dbt runs on the developer's machine through the local `dbt` CLI (found in `.venv`, `venv`, `.venv-dbt` of the project, then on PATH); no shell, usage tracking off (`DO_NOT_TRACK=1`, `DBT_SEND_ANONYMOUS_USAGE_STATS=False`), colour off, bounded output, time-out.
- Never print a secret from `profiles.yml`: a value under a credential-looking key is shown as `<redacted>` unless it is an `env_var()` reference. Logs go through the Fabric redaction.
- Fabric adapters (`fabric`, `fabricspark`) write to a workspace: those writes (`build`, `run`, `seed`, `snapshot`, `run-operation`) stay behind the workspace guard of `aihub fabric dbt run` (no ACC or PRD, the profile target must live in the chosen workspace). `aihub dbt` runs reads and compile steps on any adapter and writes on non-Fabric adapters (DuckDB, a local Postgres); for a Fabric target it points to `aihub fabric dbt run`.
- Every command answers compact text and, with `--json`, a stable object.
- Examples and tests use synthetic projects only.
- Live on Fabric (2026-11-19, `docs/live-verification.md`): `fabric dbt scaffold` + `fabric dbt run --command build` on a warehouse with dbt-core 1.12.7 and dbt-fabric 1.12.0 (az CLI auth), then `aihub dbt test|show|compile` and `fabric sql` on the result. The Livy lakehouse route (`fabricspark`) was not run live.

## A. Legacy Hub

| Legacy tool or code | What it did | Now |
|---|---|---|
| `fabric_dbt_detect` | projects (`dbt_project.yml`), models and test files, profiles with secrets redacted, route (warehouse, lakehouse, other), dbt CLI version, last run | existing: `aihub fabric dbt detect`; richer `aihub dbt detect` (adapter, dbt-core version, manifest age, exposures) to build |
| `fabric_dbt_scaffold` | new project for the warehouse, lakehouse or job route, no secret in the profile | existing: `aihub fabric dbt scaffold` |
| `fabric_dbt_run` | `build run test compile show seed snapshot retry run-operation debug deps parse ls` with select, exclude, target, limit, inline, macro and args, empty, fullRefresh, vars; workspace guard; HTTP 430 "capacity full" answer | existing for Fabric: `aihub fabric dbt run --workspace` (guard, 430 hint). To build: `aihub dbt <verb>` for the local run of every verb, plus `freshness`, `docs`, `--defer --state`, `--vars`, `--threads`, `--fail-fast` |
| `fabric_dbt_get_run_results` | counts, failing nodes with message, log tail | existing: `aihub fabric dbt results`; to build: `aihub dbt failures` (failed test, compiled SQL, first failing rows) |
| `fabric_dbt_save_job`, `fabric_dbt_get_job` | project into the Fabric dbt job item, definition and runs | existing: `aihub fabric dbt upload\|save-job\|get-job` |
| `fabric_dbt_guide` (+ `dbt-guide.md`, 22 topics) | routes, setup, capacity, structure, data tests, unit tests, regression tests, macros, scd2, snapshots, incremental, packages, sources, contracts, selectors, slim CI, docs and exposures, hooks and vars, preview, job item | dropped as a tool in the rebuild ("belongs in a skill") and never came back: to build as skill `dbt` + `skills/dbt/references/dbt.md` |
| `DbtProjects.selector` | rejected selectors that look like flags | existing in `fabric dbt run`; to build for `aihub dbt` (same rule) |
| `DbtProjects.profiles/redact` | profile targets with masked secrets | existing: `findProfiles`, `profileValue` |
| `DbtYaml` | a small YAML reader for project and schema files | out of scope: the CLI has the `yaml` package |
| `DbtCli.locate/process` | dbt from the project venv, no shell, no tracking, output cap, tree kill on time-out | existing for `fabric dbt run` (spawn); to build as one shared runner with venv lookup |
| Lite `dbt_robot.py`, `hub-lite-fabric-dbt.agent.md` | Hub Lite dbt helper | out of scope: Hub Lite is dropped |

## B. dbt Lens (VS Code extension)

dbt Lens is an editor product (language server, CodeLens, webviews). The CLI does not duplicate the editor surface; it covers what an agent or a pipeline step needs.

| dbt Lens feature | Now |
|---|---|
| Compiled SQL beside the model, hover on Jinja, Show SQL, Render selection, macro playground | partly: `aihub dbt compile --select <model>` prints the compiled SQL; the editor views are out of scope (GUI) |
| Go to definition, find references, autocomplete, signature help, outline | out of scope (language server) |
| Create unit test CodeLens: ready `unit_tests:` entry with one `given` per input | to build: `aihub dbt yaml scaffold <model> --unit-test` |
| Run one unit test, cell diff of expected vs actual | to build: `aihub dbt test --select test_type:unit`, diff in `aihub dbt failures`; the cell-level webview is out of scope |
| Fill expect from actual, show unit-test SQL | out of scope as a command (review step); `dbt show` and `target/compiled` give the SQL |
| Run, Build, Test, Show, Compile above every model, upstream and downstream variants | to build: `aihub dbt <verb> --select <model>[+]` |
| Test Explorer, failures in the Problems panel | to build as text: `aihub dbt failures` (file, test, message); the panel is out of scope |
| Environment sidebar (Python, dbt-core, adapter, profile, target switch) | to build: `aihub dbt detect` (versions, profile, targets); switching = `--target` |
| Profile editor forms for fabricspark and fabric | out of scope (GUI); `aihub fabric dbt scaffold` writes the profile |
| Check Setup (missing `spark_config.name`, too many threads for one Livy session, literal secrets, missing adapter) | to build: `aihub dbt check` |
| `.env` files passed to every dbt process | to build: `aihub dbt` reads `.env` next to the project (never prints it) |
| Lakehouse and Warehouse explorer, row preview grid, read-only queries | existing: `aihub fabric sql`, `aihub fabric onelake`, `aihub fabric api` |
| Livy session status, keep warm, stop | existing: `aihub fabric spark sessions\|stop` |
| HTTP 430 and 429 back-off with a clear message | existing for `fabric dbt run` (capacity hint); to build in `aihub dbt` run (same hint) |
| Model lineage graph | to build as text: `aihub dbt lineage <model> [--up\|--down]`; the graph view is out of scope |
| Column-level lineage (sqlglot) | out of scope: needs a SQL parser per dialect; a reviewer reads the compiled SQL |
| Live selector preview | to build: `aihub dbt ls --select <selector>` |
| Generate or update model YAML from the compiled SQL, add column tests | to build: `aihub dbt yaml scaffold <model> [--write]` and `aihub dbt yaml check` |
| sqlfluff lint and format | out of scope: run `sqlfluff` directly; the team's lint step stays the team's |
| Language-model tools and bridge for Copilot agent mode | out of scope: replaced by this CLI and the `dbt` skill |

## C. What a dbt developer needs every day

| Need | Now |
|---|---|
| Find the project, profile, target, adapter, dbt and adapter versions | existing `aihub fabric dbt detect`; to build `aihub dbt detect` |
| Setup problems (literal secrets, missing adapter, Livy settings, threads) | to build `aihub dbt check` |
| `dbt deps`, `parse`, `debug` | to build `aihub dbt deps\|parse\|debug` (`debug` and `parse` need no workspace) |
| `dbt build\|run\|test\|compile\|seed\|snapshot\|show\|ls` with selectors, `--exclude`, `--target`, `--vars`, `--full-refresh`, `--empty`, `--threads` | to build `aihub dbt <verb>`; Fabric writes via `aihub fabric dbt run` |
| `dbt source freshness` | to build `aihub dbt freshness` |
| `--defer --state <dir>`, `state:modified+`, `result:error+`, `retry` | to build as options of `aihub dbt <verb>` (`--state`, `--defer`); `retry` is a verb |
| Parse `run_results.json` and `manifest.json` | existing counts and failures; to build the rich reader (`aihub dbt failures`, `lineage`, `impact`) |
| Failed test: compiled SQL and the first failing rows | to build `aihub dbt failures [--rows 5] [--no-sample]` (compiled SQL from the result, rows from `dbt show`) |
| Impact of changed models: downstream models, tests, exposures, Fabric items reading them | to build `aihub dbt impact [--base <target>] [--state <dir>] [--write] [--json]` |
| Test only what changed | existing `aihub test changed` (Python and JS); to build the dbt branch (changed models become `dbt build -s <changed>+`, `tests.dbt` in team.yaml overrides) |
| Model, test and docs YAML: generate and validate | to build `aihub dbt yaml check\|scaffold` (missing entries, missing description, no key test, `tests:` vs `data_tests:`) |
| Sources and exposures | to build: listed by `lineage` and `impact` (sources, exposures with type, owner, url, `meta.fabric_item`) |
| `dbt docs generate` | to build `aihub dbt docs` (writes `target/`; serving the site is out of scope) |
| Unit tests (dbt 1.8+), `--empty`, `dbt show` previews | skill `dbt` + reference; `aihub dbt show\|test\|build --empty` |
| Slim CI with `state:modified+ --defer` | skill `dbt` reference (pipeline step); locally `aihub dbt build --state <dir> --defer --select state:modified+` |
| Fabric adapters: profiles for warehouse (`dbt-fabric`, `authentication: CLI`) and lakehouse (`dbt-fabricspark`, `method: livy`), auth by `az login` or a service principal with `env_var()` | existing scaffold and detect; checks in `aihub dbt check`; notes in the reference |
| Capacity full (HTTP 430) | existing hint in `aihub fabric dbt run` and `aihub fabric spark stop`; the same hint in `aihub dbt` |
| Production CI run, scheduling, the Fabric dbt job item | existing `aihub fabric dbt save-job`, `aihub fabric api run_job`; pipelines: `aihub pipeline` |
| Editor features (hover, go to definition, Test Explorer UI) | out of scope: dbt Lens stays the editor product |
| Running against ACC or PRD from the CLI | out of scope by rule: the developer does that; the guard refuses it |
