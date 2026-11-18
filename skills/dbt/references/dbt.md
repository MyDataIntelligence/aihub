# dbt reference

Knowledge from the old Hub's `fabric_dbt_guide`, kept as one page. Commands are `aihub dbt ...` (local) or `aihub fabric dbt run ...` (Fabric writes).

## Routes on Fabric
- Lakehouse, `dbt-fabricspark` (`method: livy`): dbt runs locally and sends Spark SQL to a Livy session in the workspace (your `az login`). Delta tables. Best default for lakehouse data.
- Warehouse, `dbt-fabric`: T-SQL from your machine (ODBC Driver 18, `authentication: CLI`). Use it when data and consumers live in a warehouse.
- Fabric dbt job item (preview): Fabric runs the project stored in the job. Develop locally, then `aihub fabric dbt save-job`, run it with `aihub fabric api run_job`.

## Setup and profiles
- One virtual environment per repository (`.venv`, found automatically), pinned `requirements.txt` (`dbt-core~=1.10` plus the adapter). `dbt --version` shows core and adapter; `aihub dbt detect` too.
- `profiles.yml` next to `dbt_project.yml` or in the user dbt folder. No secret in it: `authentication: CLI` (az login), or `"{{ env_var('NAME') }}"` for a service principal; `.env` next to the project is passed to dbt. `aihub dbt check` finds literal secrets.
- fabricspark keys: `type`, `method: livy`, `authentication: CLI`, `endpoint`, `workspaceid`, `lakehouseid`, `lakehouse`, `schema`, `threads` (1, at most 2), `connect_retries`, `connect_timeout`, `retry_all`, and `spark_config.name` (required since 1.13: the session name in the Monitoring hub). `reuse_session: true` keeps one session between runs but holds capacity.
- `.gitignore`: `target/`, `logs/`, `dbt_packages/`, the venv, `profiles.yml` when it holds anything personal.
- First `aihub dbt debug` (connection), then `aihub dbt parse` (no warehouse needed), then build.

## Capacity (HTTP 430)
`TooManyRequestsForCapacity`: the Spark limit is full, often by your own idle session (a notebook, `dbt debug`, `reuse_session`). `aihub fabric spark sessions --workspace <ws>`, `aihub fabric spark stop ... --dry-run`, run again. Keep `threads` low; batch work in one `build --select`.

## Structure and naming
`models/staging` (`stg_<source>__<table>`, one model per source table, rename and cast), `models/intermediate` (`int_`), `models/marts` (`fct_`, `dim_`). Sources only through `source()` in staging, everything else `ref()`. One YAML per folder with descriptions and tests. Staging as views (warehouse) or tables (lakehouse, views are not visible in the SQL endpoint), marts as tables or incremental. Configure per folder in `dbt_project.yml`.

## Data tests and unit tests
- `data_tests:` (dbt 1.8+; `tests:` still works but is deprecated and flagged by `aihub dbt yaml check`). Generic: `unique`, `not_null`, `accepted_values`, `relationships`; singular tests are SQL in `tests/` returning the failing rows. `severity: warn` for known issues, `store_failures: true` keeps failing rows. At least `unique` + `not_null` on every key.
- Unit tests (`unit_tests:` beside the model): fixed `given` rows per `ref`/`source`, `expect` rows. Nothing is written; only listed columns are compared. Upstream relations must exist (build once, or `aihub dbt build --empty`). Override `is_incremental`, vars or macros per test. Run: `aihub dbt test --select test_type:unit`; exclude in production with `--exclude-resource-type unit_test`. Write them for real logic (SCD2, dedup, CASE, join edge cases), not pass-through staging. `aihub dbt yaml scaffold <model> --unit-test` writes the skeleton (placeholder values by type; fill in real cases).
- `aihub dbt failures` shows why a test failed: compiled SQL, count and first rows (via `dbt show`), the diff of a unit test.

## Selectors and state
`model+` downstream, `+model` upstream, `@model`, `tag:daily`, `path:models/marts`, `source:raw+`, `test_type:unit`, `resource_type:snapshot`, `result:error+ --state <dir>`, `state:modified+ --state <dir>`. Several selectors in one `--select "a+ b"` are a union, `a,b` an intersection. `selectors.yml` + `--selector name`. `aihub dbt retry` reruns what failed. `aihub dbt ls --select <x>` shows what a selector picks without running.

State and defer: keep the production `manifest.json` as a pipeline artifact; locally `aihub dbt build --select state:modified+ --state <dir> --defer` builds only changed models and reads unchanged parents from production. `aihub dbt impact --state auto` computes the same set from the merge base (both sides are compared with LF endings and no trailing whitespace, so autocrlf checkouts do not show false changes).

## Incremental, snapshots, SCD2
- Incremental: `materialized='incremental'`, `unique_key`, `incremental_strategy` (`merge` on Delta, `append`, `insert_overwrite`; dbt-fabric `merge`, `delete+insert`), filter new rows in `{% if is_incremental() %}`, `on_schema_change: append_new_columns`. dbt 1.9+ `microbatch` with `event_time`, `batch_size`, `begin`. `--full-refresh` rebuilds; test the incremental branch with a unit-test override.
- Snapshots (dbt 1.9+ YAML, `dbt snapshot` right after the load): `timestamp` when the source has a trustworthy `updated_at`, `check` otherwise (expensive MERGE on Spark). The snapshot table is the only copy of the history: never `--full-refresh`, keep dev and prod apart, a non-unique key breaks the MERGE. History starts at the first run.
- Source with a change history (CDC, audit log): an SCD2 macro (hash tracked columns, drop unchanged versions with `lag`, `valid_to` from `lead`) is rebuildable and unit-testable; source with only the current state: snapshot.

## Packages, sources, contracts, docs
- `packages.yml` pinned (`dbt-labs/dbt_utils`, `metaplane/dbt_expectations`), `aihub dbt deps`, commit `package-lock.yml`, not `dbt_packages/`. Check adapter support.
- Sources: declare every raw table with `loaded_at_field` and `freshness: {warn_after, error_after}`, then `aihub dbt freshness` after the load. Keys of sources get `unique`/`not_null`.
- Contracts: `config: {contract: {enforced: true}}` with `data_type` on every column for marts others depend on; a breaking change is a new model version.
- Docs: descriptions on every model and column, `{{ doc('x') }}` blocks for long text, `aihub dbt docs` (`dbt docs generate`), exposures name the reports that use a model: `meta: {fabric_item: <report or semantic model>}` makes `aihub dbt impact` list the Fabric item.
- Hooks and vars: `pre-hook`/`post-hook` (`OPTIMIZE {{ this }}` on Delta), `on-run-start/end`, `target.name` per environment; separate dev and test targets with their own workspace or lakehouse.

## Previewing without building
`aihub dbt show --select <model> --limit 10` (or `--inline "select ..."`), `aihub dbt build --empty` (zero-row build: SQL, schema and contracts), `aihub dbt compile --select <model>` prints the SQL; `target/compiled/` holds it, `target/run/` what ran.

## Slim CI in Azure DevOps
PR pipeline: `dbt build --select state:modified+ --defer --state <prod-artifacts>`; unit tests in CI, excluded in production; a service principal (`authentication: ServicePrincipal` with `env_var()` secrets from the pipeline library), a CI schema or workspace per PR. `aihub pipeline` shows the run and its logs.

## Common errors
| Error | Cause and fix |
|---|---|
| `Compilation Error ... depends on a node named 'x' which was not found` | a `ref()` to a model that does not exist or is disabled: fix the name, `aihub dbt ls` |
| `Could not find profile named 'x'` | `profile:` in `dbt_project.yml` differs from `profiles.yml`: `aihub dbt check` |
| `Catalog Error: Table ... does not exist` (tests, unit tests) | upstream not built yet: `aihub dbt build --select +<model>` or `--empty` |
| `Got N results, configured to fail if != 0` | the test found rows: `aihub dbt failures` shows them |
| `TooManyRequestsForCapacity` / 430 | capacity full: stop idle Livy sessions |
| `adapter 'x' not found` | `pip install dbt-<adapter>` in the project venv |
| `unique_key` merge fails with duplicate rows | the source key is not unique: add a `unique` test on the source |
| Unit test fails on types | give `given` rows all columns the model reads, with matching types |
