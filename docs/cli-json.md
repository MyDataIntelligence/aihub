# JSON for tools: pr list, pr show, status, watch events, pipelines

For the VS Code extension and other scripts. Every command prints one JSON document with `--json` and never asks a question.

Votes everywhere: `vote` is the Azure DevOps number (`10` approved, `5` approved with suggestions, `0` no vote, `-5` waiting for the author, `-10` rejected),
`voteName` its text, `required` whether the reviewer is required.

## `aihub pr list [--mine|--reviewer] [--branch <b>] [--status active|completed|abandoned|all] [--repo <r>] [--json]`

Pull requests of the repositories in `team.yaml` (all repositories of the project when none are listed, or only `--repo`); newest first, at most 100.
`--mine` = created by you, `--reviewer` = you are a reviewer, `--branch` = source branch. Default status `active`. Array of:

```json
{"id":7,"title":"7 CSV export","repo":"test-repo","source":"feature/7-csv","target":"main","status":"active","draft":false,"author":"Anna",
 "reviewers":[{"name":"Bob","vote":10,"voteName":"approved","required":true}],
 "url":"https://dev.azure.com/<org>/<project>/_git/<repo>/pullrequest/7","created":"2026-11-18T10:00:00Z"}
```

## `aihub pr show --pr <n|url> [--json]`

The same fields plus:

```json
{"description":"first 12 lines / 600 characters","mergeStatus":"succeeded",
 "policies":{"total":2,"approved":1,"blocking":["Minimum number of reviewers: rejected"]},
 "threads":{"total":2,"open":1}}
```

## `aihub status --json`

`pr` is `null` or `{id, title, status, draft, url, reviewers:[{name, vote, voteName, required}]}` (other fields as before: `repo, branch, story, pipeline, checks, openThreads, dirty, unpushed, notes, done, next, warnings`).

## `aihub watch events [--limit N] [--since <30s|5m|2h>] [--json]`

The events that `aihub watch --pr` and `aihub watch --mine` recorded (store `$AIHUB_HOME/events`, default `~/.aihub/events`), newest first, default limit 20. `--since` needs a unit. Array of:

```json
{"id":"mine-mwl92gjg-1","at":"2026-11-18T11:50:00.000Z","epoch":1794916200000,"message":"Build (ruff) failed on your PR !8 ...","repo":"/path/of/the/clone","client":"opencode","session":"...","url":"aihub://open?event=mine-mwl92gjg-1"}
```

`url` is what the notification's Open button runs (`aihub open --event <id>`). Without `--json` one line per event.

## Pipelines in the bar: `aihub pipeline list|show|log|poll|run-again`

Always JSON (no `--json` needed). Times are ISO UTC, durations seconds; the caller formats them. `--repo-dir <dir>` picks the repository
(default: the one of the current folder); the remote is read from `.git/config`, so none of these starts git. Every run, stage, job and
step carries `webUrl` (Open in Browser, Copy Link). States: `queued`, `running`, `cancelling`, `succeeded`, `partiallySucceeded`,
`failed`, `canceled`; stages, jobs and steps also `skipped` and `pending`.

`aihub pipeline list [--mine] [--today] [--status running|queued|failed|succeeded|canceled] [--branch B] [--top N] [--repo-dir D]...`:
runs of one or more repositories, newest first; repositories of one project cost one REST call together. `--branch` also matches the
pull request runs of that branch. `today` counts all of today's runs read, whatever `--status` says; `capped` means there were more.

```json
{"me":{"id":"<guid>","name":"Test User"},"since":"2026-11-25T23:00:00.000Z",
 "runs":[{"id":2049,"number":"20261126.3","pipeline":{"id":7,"name":"orders-ci"},"repo":"repo-a","repoDir":"C:/src/repo-a",
          "branch":"feature/4711-orderexport","commit":"<sha>","state":"running","reason":"manual","requestedFor":{"name":"Test User","isMe":true},
          "queuedAt":"…","startedAt":"…","finishedAt":null,"durationSeconds":252,"currentStage":"Test","webUrl":"…"}],
 "today":{"total":7,"running":1,"queued":0,"failed":2,"succeeded":4,"canceled":0,"capped":false},"errors":[{"repoDir":"…","error":"…"}]}
```

`aihub pipeline show --run N`: `run` (trigger: `reason`, `manual`, `requestedFor`, `branch`, `commit {id,short,message}`, `pr {id,webUrl}`,
`waitSeconds`, `durationSeconds`, `agent`), `stages[] {id,identifier,name,state,durationSeconds,dependsOn,notRunReason,errorCount,webUrl,
jobs[] {id,name,state,durationSeconds,agent,webUrl, steps[] {id,name,state,durationSeconds,logId,errorCount,warningCount,webUrl}}}`,
`parameters[] {name,value}`, `variables[] {name,value,isSecret}` (a secret's value is always `null`) and `summary`:

```json
{"text":"Stage Test stopped at step Run pytest. 2 of 148 tests failed. The first failure is test_empty_customer_number in notebooks/test_orders.py:41.",
 "stoppedStage":"Test","stoppedStep":"Run pytest","stoppedStepId":"<guid>","failedTests":2,"totalTests":148,
 "firstFailure":{"test":"test_empty_customer_number","message":"AssertionError: …","file":"notebooks/test_orders.py","line":41}}
```

`aihub pipeline log --run N [--step <step id|name>] [--tail 2000] [--from-line K]`: one step log (default: the failed step), at most
`--tail` lines; `--from-line K` reads only from line K on (follow without reading everything again). Levels come from `##[error]`,
`##[warning]`, pytest `FAILED`/`E`, `path:line: …Error` and Python tracebacks. `links` are repository-relative, with their character
positions in `text`; `sections` are `##[group]` blocks and stretches of info lines with a label, for folding.

```json
{"run":2046,"step":{"id":"<guid>","name":"Run pytest","stage":"Test","job":"Job pytest","state":"failed","durationSeconds":171,"webUrl":"…"},
 "final":true,"totalLines":341,"truncated":false,"counts":{"errors":8,"warnings":2},
 "firstError":{"n":312,"time":"…","text":"AssertionError: customer_number must not be empty","file":"notebooks/test_orders.py","line":41},
 "lines":[{"n":319,"time":"…","level":"error","text":"notebooks/test_orders.py:41: AssertionError","links":[{"file":"notebooks/test_orders.py","line":41,"start":0,"end":27}]}],
 "sections":[{"kind":"noise","label":"running 148 tests, test progress","start":144,"end":286,"problems":false}]}
```

`aihub pipeline poll --run N`: the cheap read to repeat (every 15 s) while a run of mine runs: two REST calls, the caller times it.
`{id,pipeline,state,finished,currentStage,currentStep,startedAt,finishedAt,durationSeconds,failedStage,failedStep,tests:{failed,total}|null,webUrl}`;
`tests` only for a finished red run.

`aihub pipeline run-again --run N --plan`: the rerun form. Parameter types and allowed values and the stage dependencies come from the
pipeline YAML at the run's commit (`dependencySource: "yaml"`; otherwise each stage needs the one before it, `"order"`). A stage can be
skipped (`canSkip`) only when no other stage depends on it; `requiredBy` names those that do.

```json
{"run":{"id":2046,"pipeline":{"id":7,"name":"orders-ci"},"branch":"feature/4711-orderexport","sourceBranch":"refs/heads/…","commit":{"id":"…","short":"3f9a2c1","message":"Guard empty customer number"}},
 "latestCommit":{"id":"…","short":"8b1d7e0","message":"Fix amount filter","newerCount":1},
 "parameters":[{"name":"runIntegration","displayName":null,"type":"boolean","default":false,"values":null,"value":"false"}],
 "variables":[{"name":"DB_PASSWORD","value":null,"isSecret":true,"settable":true}],
 "stages":[{"identifier":"DeployDev","name":"Deploy dev","dependsOn":["Test"],"requiredBy":[],"canSkip":true}],"dependencySource":"yaml"}
```

`aihub pipeline run-again --run N [--commit same|latest] [--changes-file F]` queues a new run of the same pipeline and branch with every
parameter and settable variable of the old run, plus the changes in `F` (a file, so a secret never shows in the process list):
`{"parameters":{"runIntegration":true},"variables":{"debugLogging":"true"},"skipStages":["DeployDev"]}`. A secret is sent only when it has
a value in `F`; otherwise it keeps its own. Wrong types, values outside `values`, variables that are not settable at queue time and a
skip another stage depends on are refused before anything is queued. Answer:
`{id,number,pipeline,branch,commit,skipped,changed:{parameters,variables},webUrl}`. Rerun Failed Jobs is `aihub pipeline retry --run N
[--stage S] --json` → `{run,retried,webUrl}`.
