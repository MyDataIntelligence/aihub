# JSON for tools: pr list, pr show, status, watch events, pipelines, repository browser, wiki browser, preflight

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

`aihub pipeline list [--mine] [--today] [--status running|queued|failed|succeeded|canceled] [--branch B] [--top N] [--repo-dir D]... [--rows-repo-dir D]`:
runs of one or more repositories, newest first; repositories of one project cost one REST call together. `--branch` also matches the
pull request runs of that branch; `--rows-repo-dir` keeps the rows of one of the repositories (the menu of one repository). `today`
counts all of today's runs read of all `--repo-dir`s, whatever `--branch`, `--status` and `--rows-repo-dir` say; `capped` means there
were more. A finished red row carries `failedStage`, `failedStep` and `tests {failed,total}` (null otherwise); they are read once per
run and finish time and kept in `~/.aihub/pipeline-red-runs.json`.

```json
{"me":{"id":"<guid>","name":"Test User"},"since":"2026-11-25T23:00:00.000Z",
 "runs":[{"id":2049,"number":"20261126.3","pipeline":{"id":7,"name":"orders-ci"},"repo":"repo-a","repoDir":"C:/src/repo-a",
          "branch":"feature/4711-orderexport","commit":"<sha>","state":"running","reason":"manual","requestedFor":{"name":"Test User","isMe":true},
          "queuedAt":"…","startedAt":"…","finishedAt":null,"durationSeconds":252,"currentStage":"Test","webUrl":"…"}],
 "today":{"total":7,"running":1,"queued":0,"failed":2,"succeeded":4,"canceled":0,"capped":false},"errors":[{"repoDir":"…","error":"…"}]}
```

`show`, `poll`, `log`, `run-again`, `retry` and `cancel` also take `--project P [--org O]` instead of `--repo-dir`: the run is read from that project without a clone (a run opened from the pipeline browser); `--repo-dir` wins when both are given.

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

## Repository browser: `aihub browse ...`

Browse every Azure DevOps project and repository you can read without a clone. Always JSON (no `--json` needed); a failure prints
`{"error":{"kind":K,"message":"one line with the fix"}}` on stdout and exits 1. `K`: `signedOut`, `noAccess`, `notFound`,
`searchUnavailable`, `protectedBranch`, `branchExists`, `offline`, `badInput`, `failed`. `signedOut`, `noAccess` and `searchUnavailable`
are remembered 5 minutes per organisation (`--refresh` tries again).

Common: `--org O` (default: `AIHUB_ADO_ORG`, else the organisation of the clone in the current folder, else the last one used),
`--project P --repo R` (names), `--ref` = a branch name | `tag:<name>` | `commit:<sha>` (default: the default branch), paths start with
`/`. Every answer has `readAt` (ISO) and `cached` (`Read from the remote 14:21 · cached 3 min ago`); `--refresh` skips the cache. An
answer at a ref names it as `ref: {name, kind: "branch"|"tag"|"commit", commit: "<40 hex>"}`: the commit is the stable key (a tree or a
file at a commit id never changes) and the `--base-commit` of a later push. People are `{name, email, isMe}`; a repository's local clone is
`clone: {path, branch} | null` (the clones under the repos root, read from their files). Nothing runs in the background.

Cache (`<config>/aihub/cache/browse/`): projects and repositories 4 hours, project page 1 hour, a folder or file at a branch 2 minutes
(and at its commit for good), history, branches and the repository page 2 minutes. A page with a failed part is not kept.

`aihub browse projects` (2 REST calls, then cached):

```json
{"org":"ferron-test","readAt":"2026-11-26T14:21:00.000Z","cached":false,
 "projects":[{"id":"<guid>","name":"test-project","description":"Synthetic project","webUrl":"https://dev.azure.com/ferron-test/test-project",
   "repos":[{"id":"<guid>","project":"test-project","repo":"repo-a","defaultBranch":"main","sizeBytes":1200,"canOpen":true,"reason":null,
             "clone":{"path":"C:/src/repo-a","branch":"feature/4711-orderexport"},"webUrl":"…/_git/repo-a","remoteUrl":"…/_git/repo-a"}],
   "cannotOpen":1}]}
```

`reason`: `disabled` (cannot be opened), `empty` (no default branch yet) or `null`. Azure DevOps only lists repositories you may read.

`aihub browse project --project P [--days 30]`: the project page. Per repository (at most 30) one commit read and one README read;
`language` from the project's language metrics; `recentFiles` (at most 15) from the newest 8 commits of the last `--days`; `activeAuthors`
(at most 8) count those commits. A part that fails is in `errors`, the rest still comes.

```json
{"project":{"name":"test-project","description":"…","webUrl":"…"},"readAt":"…","cached":false,
 "repos":[{"…":"as in projects","description":"first prose paragraph of the README","language":"Python",
           "lastActivity":{"id":"<sha>","short":"3f9a2c1","message":"Fix amount filter","at":"…","by":{"name":"Sanne de Vries","email":"…","isMe":false},"commit":"<sha>"}}],
 "cannotOpen":[{"repo":"repo-old","reason":"disabled"}],
 "recentFiles":[{"repo":"repo-a","path":"/src/export/orders_export.py","at":"…","by":{…},"commit":"<sha>","message":"…"}],
 "activeAuthors":[{"name":"Sanne de Vries","email":"…","isMe":false,"commits":12}],
 "errors":[{"part":"language","kind":"failed","message":"…"}]}
```

`aihub browse repo --project P --repo R [--ref ...]`: the repository page. `parts` that can fail on their own: `root`, `readme`,
`branches`, `pullRequests`, `commits`, `pipelines` (Retry = the same call with `--refresh`). `pipelines.runs` are the rows of
`aihub pipeline list` (`repoDir` is the clone or `null`). `branches.items` are at most three: the default branch, then my newest, then the most recently changed (`at` = date of the newest commit, `ahead`/`behind` against the default branch; one extra call to the branch statistics).

```json
{"repo":{"…":"as in projects"},"ref":{"name":"main","kind":"branch","commit":"<sha>"},"readAt":"…","cached":false,
 "readme":{"path":"/README.md","markdown":"# repo-a\n…","truncated":false},
 "root":[{"name":"dbt","path":"/dbt","kind":"folder","sizeBytes":null,"objectId":"<sha>","lastCommit":{"id":"…","short":"…","message":"…","at":"…","by":{…}}}],
 "branches":{"count":14,"default":"main","items":[{"name":"main","isDefault":true,"isMine":false,"at":"…","commit":"<sha>","ahead":0,"behind":0},{"name":"feature/4711-orderexport","isDefault":false,"isMine":true,"at":"…","commit":"<sha>","ahead":3,"behind":1}]},
 "pullRequests":{"count":2,"items":[{"id":42,"title":"…","by":{…},"source":"feature/4711-orderexport","target":"main","isDraft":false,"createdAt":"…","webUrl":"…"}]},
 "commits":[{"id":"…","short":"…","message":"…","at":"…","by":{…},"webUrl":"…"}],
 "pipelines":{"runs":[]},
 "errors":[{"part":"pipelines","kind":"failed","message":"…"}]}
```

`aihub browse items --project P --repo R [--path /dir] [--ref ...] [--last-commit]`: one folder level, folders first, then by name.
`kind`: `folder`, `file` or `submodule`; `sizeBytes` of each file from the tree of the folder (one more call; `null` for folders); `lastCommit` only with `--last-commit`.
`{"ref":{…},"path":"/dbt","readAt":"…","cached":false,"items":[{"name":"models","path":"/dbt/models","kind":"folder","sizeBytes":null,"objectId":"<sha>","lastCommit":null}]}`

`aihub browse file --project P --repo R --path /file [--ref ...] [--max-bytes 5242880]`: `{"ref":{…},"path":"/notebooks/export_orders.py",
"objectId":"<blob sha>","sizeBytes":2310,"lastCommit":{…},"binary":false,"tooLarge":false,"content":"…","webUrl":"…"}`. A binary file or one
larger than `--max-bytes` has `content: null` (the UI offers Open in Browser). The file is read in up to three calls: metadata (Azure DevOps' binary flag), the blob size, and only then the content: a binary file (the flag, a data/archive/image/office extension, or a NUL in the first 8000 characters) or one over `--max-bytes` (5 MB) is never downloaded; `sizeBytes` is filled for them too.

`aihub browse branches --project P --repo R [--filter t] [--top 50]`: default first, then the branches I created, then by name; tags
newest first; `at` is the date of the newest commit, `ahead`/`behind` count against the default branch (one call to the branch statistics,
read with the refs; `null` when it fails). `{"default":"main","count":14,"branches":[{"name":"main","commit":"<sha>","isMine":false,"isDefault":true,"by":{…}|null,"at":"…","ahead":0,"behind":0}],
"tags":[{"name":"v1.2","commit":"<sha>"}],"more":false}`

`aihub browse history --project P --repo R [--path /p] [--ref ...] [--top 50] [--skip 0]`: newest first; `more` says there is a next page
(`--skip`). `{"ref":{"name":"main","kind":"branch"},"path":"/src/a.py","commits":[{"id","short","message","at","by","webUrl"}],"more":true}`

`aihub browse diff --project P --repo R --commit SHA --path /file`: the change of that commit to that file, against its first parent.
`changeType`: `add`, `edit`, `delete`, `rename` (`oldPath` set) or `none`. `hunks` are unified with 3 lines of context; `old`/`new` are
1-based line numbers. A binary side gives no hunks.

```json
{"commit":{"id":"…","short":"…","message":"Fix typo","at":"…","by":{…},"webUrl":"…"},"parent":"<sha>","path":"/a.py","oldPath":null,"changeType":"edit",
 "before":{"content":"…","binary":false,"tooLarge":false},"after":{"content":"…","binary":false,"tooLarge":false},
 "hunks":[{"oldStart":1,"oldLines":3,"newStart":1,"newLines":3,"lines":[{"kind":"ctx","text":"one","old":1,"new":1},{"kind":"del","text":"two","old":2,"new":null},{"kind":"add","text":"TWO","old":null,"new":2}]}]}
```

`aihub browse blame --project P --repo R --path /file [--ref ...]`: Azure DevOps has no public annotate (blame) REST API, so blame runs
`git blame` in the clone on this PC at the remote version of the ref (`origin/<branch>`, the tag or the commit).
`{"available":true,"source":"local","ref":{…},"clone":"C:/src/repo-a","lines":[{"n":1,"commit":"<sha>"}],"commits":{"<sha>":{"short","message","at","by"}}}`,
or without a clone `{"available":false,"reason":"not available for remote repositories: clone it to see who changed each line","clone":null}`
(also `available: false` when the clone lacks that version: fetch first). Not an error: exit 0.

`aihub browse find --query <file name> [--top 50] [--repos P/R,...]` (Ctrl+P): with Code Search one query `file:*<name>*` over every
repository (`route: "codeSearch"`); without it the trees of the repositories opened in the browser (the last 20) and `--repos`
(favourites), one tree per commit kept for good (`route: "treeCache"`); `notSearched` names the rest. Ranked: clones first, then exact name,
prefix, word start, anywhere, fuzzy.
`{"route":"codeSearch","results":[{"name":"orders_export.py","path":"/src/export/orders_export.py","project":"test-project","repo":"repo-a","clone":null}],"searched":{"repos":null,"notSearched":[]}}`

`aihub browse search --text T [--project P] [--repo R (needs --project)] [--branch B] [--path /p] [--ext py,sql] [--top 25] [--local]` (Code Search): the lines
come from each file at the indexed commit (Code Search gives only offsets), `ranges` are `[start, end)` columns.
`{"count":23,"results":[{"project","repo","path","branch":"main","commit":"<sha>","clone":null,"matches":[{"line":14,"text":"MAX_RETRIES = 3","ranges":[[0,11]]}]}],"notSearched":[{"what":"20 more file(s)","reason":"only the first 3 are shown (--top)"}]}`.
`--scope P,P/R,...` (Search in Selected): whole projects and chosen repositories; Code Search filters a repository within its project, so the whole projects are one query and each project with chosen repositories another, merged (`scope` in the answer); the local fallback keeps to the same scope. Every answer has `route`: `codeSearch`, or `local` when the organisation has no Code Search (or `--local`): then only the clones on this PC are searched (ripgrep from `AIHUB_RG` or PATH in one process, else `git grep` per clone; a clone on another branch than `--branch` is searched at `origin/<branch>`), nothing is sent to Azure DevOps, `searchUnavailable: {message}` says why, `tool` names ripgrep or git grep, and `notSearched` names the remote repositories that were not searched (`{"what":"5 remote repositories","reason":"not cloned on this PC; ..."}`).

`aihub browse push --project P --repo R --path /file --base-commit <ref.commit when read> --base-branch B --content-file F --branch
feature/x --message-file M [--pr [--target T] [--story N] [--pr-title t] [--draft]] [--rebase]`: one commit on a NEW branch through the
Pushes API, no clone. Refused (`protectedBranch`): `main`, `master`, `staging`, `develop`, the default branch, the base branch and
`branches.protected` of the team.yaml on the remote; an existing branch is `branchExists`. The branch starts at `--base-commit`. When the
file on `B` changed since then, nothing is pushed:

```json
{"status":"conflict","path":"/src/a.py","baseCommit":"<sha>","latest":{"id":"<sha>","short":"e07a2c4","message":"Their change","at":"…","by":{…}},
 "overlap":true,"mine":{"hunks":[…]},"theirs":{"hunks":[…]}}
```

`--rebase` (Rebase my change): when my lines and theirs do not overlap (neighbouring lines count as overlap) the change is re-applied on
the newest version and pushed from there (`rebased: true`); otherwise the same conflict. Pushed:
`{"status":"pushed","branch":"feature/4711-fix-typo","commit":{"id","short","webUrl"},"startedFrom":"<sha>","rebased":false,"pr":{"id":77,"title":"4711 Orderexport","webUrl":"…"}|null,"prError":null,"webUrl":"<branch in the browser>"}`.
`--pr` opens a pull request to `--target` (default: the default branch) with the template of the target branch on the remote, the story
linked (`AB#N`, title `<N> <story title>`) and the commit; a failed PR leaves the push and says why in `prError`.

`aihub browse pr --project P --repo R --branch B [--target T] [--story N] [--pr-title t] [--draft]` (Create Pull Request after a push):
a pull request from the head of `B` to `--target` (default: the default branch), with the template of the target on the remote; the story
is `--story` or the number in the branch name (`feature/4711-...`). An active pull request of the branch is returned as it is:
`{"pr":{"id":77,"title":"4711 Orderexport","webUrl":"…"},"existing":false}`.

### Change with Agent: `aihub browse change ...`

An agent changes files of a repository that is not cloned. Each change is a workspace in `<config>/aihub/changes/<id>/`
(never in a repository): `files/` holds the files the agent read or changed at their repository paths, `.base/` their version at
the base commit, `TASK.md` the task, `summary.md` the agent's summary. A file is changed when `files/` differs from `.base/`.
Nothing is pushed before `push`. Fixed limits: never main/master/staging/develop/the default branch, only this repository, at most
20 files, no secrets (keys, passwords, tokens), no pipeline definitions, variable groups or `.env` files (kinds `protectedBranch`,
`tooManyFiles`, `secret`, `forbiddenFile`).

`change start --project P --repo R [--ref B] [--branch feature/x] [--story N] [--paths /a,/b] [--selection /a:16-23] [--prompt-file F]`:
the base is the head of `--ref` (default: the default branch); the branch name comes from team.yaml `branches.feature`
(`feature/<story>-<slug>`, the slug from the prompt) unless `--branch`. The named files and the file of the selection are put in `files/`.

```json
{"id":"test-consumer-20261127-221709-ebdb","dir":"…/changes/<id>","filesDir":"…/changes/<id>/files","project":"test-project","repo":"test-consumer",
 "base":{"branch":"main","commit":"<sha>"},"branch":"feature/4711-filter-actieve-klanten","story":4711,"materialized":["/consumer/report.py"],
 "limits":{"maxFiles":20,"never":["main","master","staging","develop"]},"taskFile":"…/TASK.md","agentPrompt":"Read TASK.md and make the change it describes in the files under ./files. Do not push or commit."}
```

`change read --id ID --path /p` puts the base version in `files/` (once) and answers `{id,path,file,modified,binary,content}`.
`change write --id ID --path /p --content-file F` and `change rm --id ID --path /p` check the limits at once and answer
`{id,path,deleted,changedFiles,problems}`; the agent may also edit under `files/` with its own tools (the limits are then checked by
`diff` and `push`). `change summary --id ID --file F` keeps the agent's summary.

`change diff --id ID`: `{id,status,project,repo,branch,base,dir,filesDir,files:[{path,status:"modified"|"added"|"deleted",additions,deletions,hunks}],
totals:{files,additions,deletions},summary,problems:[{path?,kind,message}],pushed?}` (`hunks` as in `browse diff`).

`change push --id ID [--message-file M] [--branch B] [--pr [--target T] [--story N] [--pr-title t] [--draft]] [--rebase]`: ONE commit on a
NEW branch from the base commit (edit, add, delete) through the Pushes API; the message defaults to `#<story> <first line of the summary or
prompt>`. A file that changed on the base branch since the base commit gives `{"status":"conflict","files":[{path,latest:{id,short,message,at,by},overlap}]}`
and nothing is pushed; `--rebase` re-applies changes that do not overlap on the newest version. With `--pr` the pull request is written by the same rule as `aihub pr create` (title from `pullRequest.title`, the template of the target branch, the agent's summary in the first section without process noise, the changed files under Changes, the checks of the last `change verify` under Tests or "not run yet", the story with its criteria table). A story whose criteria are not all proven is the same question as `aihub pr create`, asked BEFORE the push: without `--draft` or `--anyway` the answer is `{"error":{"kind":"criteriaNotProven","message","proven","total","choices":["testFirst","draft","anyway"]}}` with exit 5 and nothing is pushed; `--draft` makes a draft (`pr.draft`, `pr.draftReason` in the team language, `pr.criteria`), `--anyway` a normal pull request with the table. The same holds for `browse push --pr` and `browse pr`. Pushed:
`{"status":"pushed",branch,commit:{id,short,webUrl},startedFrom,rebased,files,pr|null,prError,webUrl}`; the change is then `pushed`.

`change verify --id ID [--tests | --tests-only] [--progress]` (Run Checks, temporary copy): a shallow, blob-less copy of the base commit in the temp folder (outside every repository; for lint only the folders of the changed files, sparse; for tests the whole tree), the change applied, `aihub guidelines check` (the team's linters, changed lines only) and with `--tests` the tests of the changed files (`aihub test changed --run`). The copy is always removed, also on a failure; nothing is pushed; git signs in as usual. `--progress` writes one line per step on stderr: `{"progress":{"id","step":"clone"|"checkout"|"apply"|"lint"|"test"|"cleanup","n","total","message"}}`. Answer (also kept as `verify` in `change diff`):
`{"id","ok":false,"base":{"branch","commit"},"files":["/src/a.py"],"checks":[{"name":"ruff","kind":"lint","status":"passed"|"failed"|"skipped"|"couldNotRun","errors":[{"path","line"?,"message"}],"tookMs","command"?,"reason"?,"missing"?:["module"]}],"tookMs","copyRemoved":true,"at","notes":[]}` (at most 20 errors per check; `skipped` with a `reason`: not installed, no tests for these files; `couldNotRun` with a `reason` when the tests could not even start in the copy: an import that fails while collecting (pytest exit 4 or 5, `No module named X`, a Robot library that cannot be imported) or a missing test tool, with `missing` naming the modules. `couldNotRun` is not a failure: `ok` stays true, and the pull request's Tests section says "not run" with the reason). Before the tests the copy gets `PYTHONPATH` = its root (and `src/`), and `tests.setup` of team.yaml runs once in the copy (a failing setup is a note).

`change apply --id ID --dir D` (Open as Working Copy): the changed files written into a working copy; a file with its own change there is
skipped: `{id,target,branch,applied:[paths],skipped:[{path,why}]}`. `change discard --id ID` removes the workspace; `change list` lists them.
### Ask Agent about Selected: `aihub browse ask ...`

A read-only question over several repositories and projects. `<config>/aihub/asks/<id>/` holds `TASK.md`, the files read (counted),
the proposals (`proposals/<project>/<repo>/<path>`, the whole new file) and `report.json`. Nothing is changed, committed or pushed by the
question; "Apply in Feature Branch" makes an `aihub browse change` per repository.

- `ask start --scope P,P/R,... --prompt-file F [--story N] [--limit 200]` -> `{id,dir,scope,limit,taskFile,agentPrompt}`.
- `ask read --id ID --project P --repo R --path /f`: the file at the repository's base (its default branch's head the first time it is used),
  counted once per file; past `limit` (200) the error kind `readLimit` until `ask allow --id ID [--more 200]` -> `{id,read,limit}`.
- `ask propose --id ID --project P --repo R --path /f --content-file F`: a proposed fix (refused: secrets, pipeline/variable-group/.env files).
- `ask report --id ID --file report.json`: `{"summary":"…","repos":[{"project","repo","finding","refs":[{"path","line"?,"note"?}]}]}`, only repositories of the scope.
- `ask state --id ID`: `{id,prompt,scope,status:"open"|"answered",reads:{count,limit},needsApproval,summary,branch,repos:[{project,repo,base,finding,refs,proposals:[{path,status,additions,deletions,hunks}],change}]}`.
- `ask apply --id ID --project P --repo R [--branch B] [--story N]`: a change with that repository's proposals, on the question's branch (the
  first apply names it; every repository gets the same) -> the `change start` answer plus `applied`. Push it with `change push`.
- `ask list`, `ask discard --id ID`.
`aihub browse related --project P --repo R --path /file [--top 10]` ("+ related files" of Change with Agent): `{"route":"codeSearch"|"tree","files":[{"path":"/tests/test_report.py","why":"a test of it"},{"path":"/jobs/run.py","why":"uses report"}]}`: tests and files with the same name from the tree of the default branch, then the files of the same repository that use the module name (Code Search; without it only the tree). One search and one tree read.

`aihub browse suggest-branch [--story N] --path /file [--title t]`: `{"branch":"feature/4711-orders-export"}` (no network).

## Pipeline browser: `aihub browse pipelines|pipeline|run-plan|run|artifacts|artifact-files|artifact-open|draft-create|drafts|draft-delete`

Like the repository browser: always JSON, `--org`/`--refresh`, a failure is `{"error":{"kind","message"}}`, lasting failures are
remembered 5 minutes, nothing polls. Commands: `aihub.bar.browsePipelines` and the others in `vscode/src/bar/types.ts`.

- `pipelines --project P`: one call per project, kept 15 minutes (`readAt`, `cached`). `folders[] {path,name,parent,pipelines}` (pipelines
  counts the folder and below) and `pipelines[] {id,name,folder,repo,yamlPath,defaultBranch,isDraft,mine,latestRun{id,number,state,branch,pr,queuedAt,finishedAt},webUrl}`.
  `isDraft`: named `draft-` in `\Drafts`; `mine`: you made the pipeline.
- `pipeline --project P --pipeline ID [--top 8]`: the same row plus `yaml {project,repo,path,defaultBranch}` (open it with `browse file`),
  `runs[] {id,number,state,branch,pr,message,requestedFor{name,isMe},queuedAt,startedAt,finishedAt,durationSeconds,webUrl}` (commit
  messages in one batch call), `allRunsUrl`. Kept 2 minutes.
- `push ... --pipeline ID`: the push answer gets `pipeline {id,name,runnable,reason}`: can that pipeline run on the new branch.
- `run-plan --project P --pipeline ID [--ref branch|tag:T|commit:SHA]`: `{pipeline,ref{name,kind,commit,message},parameters[],variables[],stages[],dependencySource}`
  read from the YAML on that ref (default: the pipeline's default branch); shapes as in `pipeline run-again --plan`; stages in templates
  give `dependencySource: "unknown"` and no stage list.
- `run --project P --pipeline ID (--branch B | --tag T) [--commit SHA] [--changes-file F]`: F as for `run-again`; only changed values are
  sent. `{id,number,pipeline,branch,tag,commit,skipped,changed,webUrl}`; a wrong value or skip is `badInput` and queues nothing.
- `artifacts --project P --run N`: `{run, artifacts[] {name,type,bytes,files:null}}`. `artifact-files ... --artifact A`: `{files[] {path,bytes}, tooLarge}`
  (the artifact's zip is downloaded once to a temporary folder; over 100 MB `files` is null). `artifact-open ... --artifact A [--path p] [--max-bytes 2097152]`:
  `{file,bytes,kind: text|html|log|binary|zip,content}`; `content` for text, log and HTML up to `--max-bytes`, the file is in a temporary
  folder (without `--path`: the whole zip). Nothing is written in a work folder.
- `draft-create --project P --repo R --name N --branch feature/x (--from-pipeline ID | --empty)`: a new branch from the repository's
  default branch with `pipelines/draft-N.yml` (a copy of that pipeline's YAML, or one stage with one script step), then the pipeline
  `draft-N` in `\Drafts` that runs that file from that branch. main, master, staging, develop, release/* and an existing branch are
  refused; when the pipeline cannot be made the branch is removed again. `{pipeline{id,name,folder},repo,branch,startedFrom,yamlPath,commit,webUrl}`.
- `drafts --project P`: `drafts[] {id,name,repo,branch,yamlPath,runs,latestRun,branchAhead,createdAt,mine,webUrl}` (`createdAt`: when the pipeline's newest revision was saved; for a draft that was not edited, when it was made).
- `draft-delete --project P --pipeline ID [--keep-branch]`: only a `draft-*` pipeline in `\Drafts` that you made (else `badInput` / `noAccess`, nothing
  changes). The runs go first with their own retention lease (a run another lease keeps stays: `runsKept`), then the pipeline; its branch goes when its name holds `draft-` and it is not protected or the default branch
  (else, or with `--keep-branch`, `branchKept` says why). `{deleted{pipeline{id,name},runs,branch,repo},runsKept,branchKept}`.

## Search Everywhere: `aihub search all <text> [--kinds ...] [--top 5] [--project P] [--stream] --json`

One text over everything the user can open in the organisation, every kind at the same time: `repos` (projects and repositories by name),
`files` (file names: Code Search, else the trees of recently opened repositories), `text` (Code Search, else ripgrep in the clones on this
PC), `branches` (refs that contain the text, in the cloned, recently opened and name-matching repositories, at most 12), `workitems` (`#n`
exact, else WIQL `Title CONTAINS`, newest changed first), `prs` (`!n`/`#n` exact, else title or source branch, active first, at most 25
projects), `wiki` (Wiki Search, else page titles) and `pipelines` (name or folder). A kind that fails or takes longer than 30 s is a part with
`status:"failed"` and `error:{kind,message}` (`kind` `timeout`, `searchUnavailable`, `signedOut`, ...); the others still come. Reads go through
the browse cache (lists 4 hours, searches 2 minutes).

`{org, text, kinds:[{kind, status:"ok"|"failed", route, count, more, results:[{kind,title,detail,project?,repo?,path?,branch?,id?,type?,state?,wiki?,line?,url?}], note?, error?, tookMs}]}`
in the asked order. `--stream`: each part as soon as it is ready as one line `{"part":{...}}` on stderr (stdout keeps the one answer).
Without `--json` it prints one group per kind for a chat. The extension's `aihub.bar.searchAll` runs it.

## Wiki browser: `aihub wiki browse ...`

Every project wiki and code wiki of the organisation, read and edited without a clone. Same rules as the repository browser: always JSON,
a failure is `{"error":{"kind","message"}}` with exit 1 (`signedOut`, `noAccess` and `searchUnavailable` remembered 5 minutes), `--org`,
`--refresh`, `readAt`/`cached` on every read, people `{name, email, isMe}`. `--project P --wiki W` (name or id) picks the wiki; page paths
are as Azure DevOps shows them (`/Runbooks/Order export`, no `.md`). A project wiki is edited here (a new wiki version straight away,
only on `publish`); a code wiki is a folder of a repository and is edited with `aihub browse push` (a new feature branch and a pull request).

Cache (`<config>/aihub/cache/browse/`): the wikis 4 hours, a tree level 4 hours, a page 1 hour, history 2 minutes, a page at a version for
good, attachments 4 hours (files in `cache/wiki-attachments/`). Every write moves the wiki on, so the next read is fresh.

| Sub | Answer |
|---|---|
| `wikis` | `{org, wikis:[{id,name,kind:"project"\|"code",project,projectId,repo,repoId,branch,mappedPath,webUrl}], projects:[{name,wikis}]}`; per project: project wiki first |
| `tree [--path /P]` | one level: `{wiki:{id,name,kind,project}, path, pages:[{path,name,order,hasChildren,id,gitItemPath}]}` in the order of Azure DevOps |
| `page --path /P [--version SHA]` | `{wiki, page:{path,name,id,gitItemPath,content,etag,version}, lastChange:{by,at,commit,short,message}\|null, attachments:[{name,ref}], workItems:{"4711":{title,type,state}}, code:null\|{project,repo,branch,filePath,baseCommit}, webUrl}` (`workItems`: the `#1234` in the text, one batch read, `{}` when they cannot be read) |
| `templates` | `{templates:[{key:"empty"\|"runbook"\|"decision",name,description,headings,content}]}` (`{{title}}` in content; no network) |
| `publish --path /P --content-file F --etag E [--comment-file C] [--force]` | `{status:"published",path,etag,version,webUrl,overwrote}`, or with a stale ETag `{status:"conflict",kind:"conflict",path,yourEtag,current:{content,etag,lastChange},base:{content},theirs:{hunks},mine:{hunks}}` (nothing written; `--force` overwrites on top of the newest version) |
| `create [--parent /P] --name N [--template T] [--content-file F] [--comment-file C]` | `{status:"created",path,etag,webUrl}`; a code wiki: `{status:"push",path,content,code:{project,repo,branch,filePath,baseCommit}}` for `aihub browse push`; an existing page is `badInput` |
| `move-plan --path /P --to /Q` | `{from,to,subpages,links:[{page,count,before,after}],linkCount,pageCount,outsideNote}`, from one zip download of the wiki; changes nothing |
| `move --path /P --to /Q [--no-links] [--order N] [--comment-file C]` | `{status:"moved",from,to,linksUpdated:[{page,count}],linkErrors:[{page,message}],webUrl}`; rename = a move within the same parent; links are rewritten in the style they were written in (`/A-b`, `/A%20b`, `.md`, `#anchor`) |
| `history --path /P [--top 50]` | `{wiki,path,versions:[{by,at,commit,short,message,parent}],more}`, newest first |
| `diff --path /P --to SHA [--from SHA]` | `{path,from,to,hunks,added,removed,fromContent,toContent}` (`from` default: the version before) |
| `search --text T [--project P] [--wiki W] [--top 50] [--skip 0]` | `{text,count,results:[{project,wiki:{id,name,kind},path,title,hits:[{line:null,text,highlights:[{start,length}]}]}],facets:{projects,wikis},tookMs}`; no search: `searchUnavailable` |
| `attachment --ref /.attachments/x.png [--page /P]` | `{name,mime,bytes,file,cached}` (a relative ref is read next to the page) |
| `upload --file F [--name N]` | project wiki: `{name,ref,markdown,bytes}`; a code wiki is `badInput` (add the file in the repository) |

The extension's `aihub.bar.wiki*` commands (`vscode/src/bar/types.ts`) run one of these each; `aihub.bar.wikiAskAgent` and
`aihub.bar.wikiUpdateFromBranch` only put a prompt in the chat (drafts go to `.aihub/wiki-drafts/<wiki>/<page>.md`; nothing is published).

## Story browser: `aihub stories ...`

Always JSON. A failure is `{"error":{"kind","message"}}` with exit 1; kinds as in the repository browser plus `needsSetting` (no project chosen). A change someone else saved in between is not an error: `{"status":"conflict","id","yourRev","rev","current":<Item>,"theirChanges":[{"rev","by","date","fields":[]}]}` with exit 0; nothing is written then. A successful write is `{"status":"saved","id","rev","changed":[field]}`. Reads are cached in the config home (lists 2 minutes, one item 1 minute, settings lists 4 hours; `--refresh` skips it); every write makes the project's cached lists and items stale. In the extension each sub is `aihub.bar.story<Sub>` with one object argument (keys = flags in camelCase; text goes in private temporary files).

- `settings [--save --project P --team T [--area A] [--iteration I]]` -> `{ org, project?, team?, areaPath?, iterationPath?, types:[] }` (kept per organisation in `story-browser.json`)
- `projects` -> `{ org, projects:[{id,name}] }`; `teams` -> `{ teams:[{id,name,isDefault}] }`; `areas` -> `{ defaultArea, areas:[{path,includeChildren}], all:[path] }`; `iterations` -> `{ iterations:[{id,name,path,start,finish,timeFrame}], current? }`
- `list --view mine|sprint|backlog [--types a,b] [--search 123|text] [--top 200]` -> `{ view, project, team, types, iterationPath?, items:[ItemRow], total, readAt, cached }` (`total`: every match, `items`: the first `top`). Without a saved area narrower than the project the team's own areas (team field values) count.
- ItemRow: `{ id, rev, type, title, state, stateCategory, assignedTo:{name,email,isMe}|null, areaPath, iterationPath, priority?, severity?, storyPoints?, tags:[], parent?, boardColumn?, boardColumnDone?, changedDate, url, local:{ set?:{folder,name}, branches:[{repo,branch,worktree?}] } }`
- `board [--board B] [--types a,b]` -> `{ board, columnField?, columns:[{ name, states, category, isDone, wipLimit?, count, items:[ItemRow] }] }` (an item sits in its own board column, also in rows of the lists and in show: `boardColumn`; the done column shows two weeks)
- `show --id N` -> ItemRow plus `allowedStates:[{name,category}]`, `severityValues?`, `priorityValues?`, `sections:[{heading,field,markdown,html}]` (the team template; a Bug keeps its text in ReproSteps), `systemInfo?:{markdown,html}`, `tasks:[{id,rev,title,state,done,assignedTo}]`, `parentItem`, `related`, `children`, `development:{branches,prs,builds}`, `comments:[{id,author,date,markdown,html}]`, `template`
- `move --id N (--to <state> | --column C [--board B]) --rev R`; `edit --id N --rev R [--title] [--state] [--assign me|<email>|none] [--priority] [--severity] [--points] [--tags a;b] [--iteration] [--area] [--sections-file f] [--system-info-file f]` (only the sections in the file change); `task --id <task> --done|--undone [--rev R]`; `add-task --parent N --title t`; `comment --id N --text-file f`
- `refine-ask --id N` -> `{ prompt, proposalFile, gaps }`; `refine --id N` -> `{ rev, parts:[{part,heading,current,proposed,changed}], tasks:{current,proposed,new} }` (reads only); `refine-apply --id N --rev R --parts description,criteria,tasks` writes only those parts
- `start --id N [--repos a,b] [--base B] [--set reuse|none] [--no-assign] [--open new|this|none]` -> branches per repository, state to the active state, assigned to me, the story's set
- `form --type T`; `new --type T --title t [--sections-file f] [--system-info-file f] [--severity] [--priority] [--parent N] [--iteration current|path] [--area] [--assign me]` -> `{ id, rev, type, title, url, template }`
- `draft-ask --type T --title t [--notes-file f]` -> `{ prompt, draftFile }`; `draft --draft-file f` -> `{ sections:[{heading,markdown}] }`
- `link --id N (--set <folder> | --repo R --branch B)` -> `{ linked:[{repo,branch,added}], prs:[{repo,id,added}] }`; `fix-branch --id N [--repo R] [--base B]` -> `bugfix/<id>-<slug>` (team.yaml `branches.bugfix` wins), pushed and linked
  (else `branchKept` says why). `{deleted{pipeline{id,name},runs,branch,repo},runsKept,branchKept}`.

## Team settings: `aihub team show|validate|preview|edit|init --json`

The extension's `aihub.bar.team*` commands run these and pass the JSON on; a failure is `{ "error": { kind, message } }` like the repository browser.

- `team show --json --no-detect`: `{ scope: { kind: set|repo, folder, story?, title?, current }, source: { kind: teamRepo|repo|none, team, label, project?, repo?, branch?, path, commit?, short?, date?, schema?, readAt, readError? }, repos: [{ name, path, branch, uses: own|teamRepo|none, teamFile: { exists, path, commit?, date?, sameAsSource? } }], groups: [{ id, title, collapsed? }], views: { "*": KeyRow[], "<repo>": KeyRow[] }, overrides: [{ key, values: [{ repo, display }] }], templates: [{ kind: pr|story|bug|commit, title, key, path, exists? }], looked: [{ what, found, note }] }`; `KeyRow = { key, group, value, display, explain, repo? }` (`repo`: the value holds for that repository only). Without `--no-detect` also `values` and `questions` of the detection.
- `team validate --json [--file f]`: `{ file, ok, errors, warnings, problems: [{ severity, code: yaml|unknownKey|type|missingFile|missingKey, line, col, key?, message, fix?: { label, replace?: { line, from, to }, createFromPack? }, known?, closest? }] }`. `--schema`: `{ keys: [{ key, explain, required, kind }], examples: { <top-level key>: yaml } }`.
- `team preview --json --template k`: `{ kind, repo, branch, story?, template: { path?, source }, title?: { pattern?, text, target?, source?, createTitle? }, markdown, emptyText, sources: [{ what, value, from, how: filled|empty|agent }], note? }`.
- `team edit --json`: `{ what, kind: teamRepo|repo, org?, project?, repo?, localPath?, branch?, path, suggestedBranch, prTitle }`; with `--content-file`: `{ validation?, target, push }` where `push` is the `browse push` answer.
- `team init --json`: `--team-repo`: `{ teamRepo, scope, commit, branch }`; `--from-pack`: the `aihub init` result (`created`, `pr`, `questions`).


## Run End to End: `aihub prompt`, `aihub criteria`, `aihub story progress|yolo`

Text for the agent by default; `--json` for the bar (a failure then is `{"error":{"kind","message"}}`, exit 1).

- Actions (one team prompt and one slash command each): story-start, story-run, story-criteria, story-refine, story-test-fabric, story-tests, story-pr, story-pr-review, story-fix-pipeline, story-explain, bug-reproduce, bug-run. The default prompts ship in `prompts/<action>.md`; the team's version in `.agents/skills/_shared/prompts/<action>.md` of its repository wins; a prompt edited for one story (`prompt save`) wins until `prompt reset`. Placeholders: `{{story.id}}`, `{{story.title}}`, `{{story.type}}`, `{{story.state}}`, `{{story.iteration}}`, `{{story.assignedTo}}`, `{{story.url}}`, `{{story.project}}`, `{{criteria}}`, `{{criteria.count}}`, `{{criteria.kinds}}`, `{{tasks}}`, `{{branch}}`, `{{target}}`, `{{repos}}`, `{{set}}`, `{{workspace}}`, `{{language}}`, `{{limits}}`.
- `prompt render <action> --id N --json` -> `{ action, slash, title, source: story|team|default, file, summary:{goal,reads,produces,limits}, filled:[{name,value}], unknown:[], text }`; `prompt list --json` -> `{ prompts:[{action,title,slash,goal,reads,produces,source,file}] }`
- Criteria live in the criteria field of the work item (or the template's criteria section), one numbered criterion with `Hoe getest:` and `Bewijs:` (`How tested:` / `Proof:`) under it.
- `criteria show --id N --json` -> `{ id, rev, type, title, heading, field, markdown, criteria:[{n,text,how?,proof?}] }`; `criteria proposal-file --id N` -> the file /story-criteria writes; `criteria proposal --id N --json` -> `{ id, rev, proposalFile, rows:[{n,current?,proposed,how?,proof?,vague?,isNew,changed}] }`; `criteria apply --id N --rev R --take 1,3` -> saved | conflict (as `stories edit`)
- `criteria status --id N --json` -> `{ id, total, proven, criteria:[{n,text,how,proof,result:pass|fail|notrun,evidence?,reason?,at?}], stateFile }`; `criteria record --id N --criterion K --result pass|fail|notrun [--evidence link] [--reason text]` (pass needs evidence, fail a reason). The status belongs to the criterion's text and is kept in the story's set folder (`.aihub-criteria-<id>.json`), else the repository's `.git/aihub/`.
- Bugs have no acceptance criteria: `criteria` refuses a Bug, its PR gets no criteria section; Bugs use bug-reproduce, Create fix branch (`stories fix-branch`) and bug-run.
- The options of Run End to End (`planFirst`, `fabric`, `setActive`) and the choice of Create Pull Request (`draft`, `anyway`) are kept in the run state (`story progress --action A --options planFirst=true,fabric=false`) and fill the prompt's `{{#if name}}...{{/if}}` blocks (also `noFabric`, `askChoice`); `prompt render --option draft=true` overrides one. `render --json` also answers `workspace` and `options`. `stories activate --id N`: Active when still new, assigned to me.
- `story progress --id N [--step k --total n --label t] [--steps a|b|c] [--done] [--stop] [--waiting plan|input|approval [--plan-file f]] [--resume] --json` -> `{ id, running, step, total, label, steps, stepsView:[{label,state:done|running|queued}], updatedAt, stateFile }`. `waiting` (true only when the agent said so), `waitingFor` (`plan` at a plan stop, `input` before a question, `approval` before an action it needs approved) and `planFile` (the plan, from `story plan-file --id N`, a folder opencode may write to); any next progress call (a step, done, stop, `--resume`, a new action) clears the three
- `story yolo --on|--off [--folder <set>]`: `opencode.json` in the set folder allows edits and commands except the limits (push or merge to main/staging, force push, completing a PR, ACC/PRD and deployments).
- `pr create`: with a story that has criteria, the section Acceptatiecriteria (criterion, how tested, outcome, link or "Nog niet uitgevoerd") and "N/M bewezen" on top; not all proven: exit 5, nothing written, unless `--draft` or `--anyway`.

## Fabric since green: `aihub fabric deployed`, `aihub fabric failures --since-green`

Read only. Like every `aihub fabric` command the JSON is `{ "identity"?: {...}, "result": ... }`. See [since-green.md](since-green.md).

- `fabric deployed --workspace W | --env ENV --json` -> `{ environment:{name,branch,workspace,pipeline,stage}, pipeline:{id,name}, looked, run:{id,number,finished,reason,requestedFor}|null, commit:{sha,title}|null, pullRequests:[{pr,title,stories:[{id,title}]}], otherRepositories:[{alias,version}], note? }`. `run: null` with `note` when none of the newest `looked` runs deployed the stage. A workspace without an environment, or an environment without `deployedBy`, is an error (exit 1) that names the team.yaml lines.
- `fabric failures --since-green --json` -> the usual `{ workspace, failed, active, chain }` plus `sinceGreen` (`null` when there is no failed run):

```json
{"window":{"failed":{"item":"pl_main","job":"<job id>","start":"2026-03-04T02:00:00Z"},"green":{"job":"<job id>","end":"2026-03-03T02:10:00Z"}},
 "environment":{"name":"TST","branch":"staging","workspace":"Fabric test-repo test","pipeline":"cd_pipeline","stage":"DeployTestEnvironment"},
 "deployments":[{"run":104,"number":"2026.104","finished":"2026-03-03T16:45:00Z","commit":"<sha>"}],
 "before":{"run":101,"finished":"2026-03-02T11:20:00Z","commit":"<sha>"},"after":{"run":104,"finished":"2026-03-03T16:45:00Z","commit":"<sha>"},
 "commits":[{"commit":"<sha>","title":"...","pr":412,"paths":["fabric/nb_standardize.Notebook/notebook-content.py"]}],
 "otherRepositoriesAvailable":true,"otherRepositories":[{"alias":"central","before":"<sha>","after":"<sha>","changed":false}],
 "suspects":[{"pr":412,"title":"...","stories":[{"id":9981,"title":"..."}],"reason":"touches nb_standardize (the failing item in the root-cause chain)","paths":["..."]}],
 "unrelated":[{"pr":409,"title":"...","stories":[],"paths":["governance/roles.yaml"]}],
 "outcome":"suspects","notes":[]}
```

`outcome`: `suspects` | `deployedUnrelated` | `nothingDeployed` | `noGreenRun` | `notConfigured` | `unavailable` (a read failed; the reason is in `notes`). Newest first in `deployments`, `commits`, `suspects` (by rank: the failed item or the failing leaf, then an item it calls, then a configuration file named like it) and `unrelated`; a change without a pull request has `commit` instead of `pr`. Fields that could not be determined are `null` or `[]`, with the reason in `notes`.

## Preflight: `aihub preflight [--plan | --apply] --json` and `aihub preflight steps --json`

One object; exit code 1 when a step failed or was blocked, or apply was held back (the object is printed first). Secrets and tokens are `***` everywhere.

```json
{"source":{"repository":"shared-templates","ref":"main","commit":"<sha>","fetched":"2026-11-28T08:40:00.000Z"},
 "job":"cicd/deploy.yaml","workspace":{"name":"DEV-test-project 12-export","id":"<guid>","environment":"feature"},
 "level":"plan","dryRun":false,
 "steps":[{"name":"Validate configs","level":"local","kind":"script","status":"passed","reason":null,"seconds":0.4,"issues":[],"afterFailure":false,"uncertain":false},
          {"name":"Get workspace ids","level":"read","kind":"PythonScript@0","status":"failed","reason":"exit code 1","seconds":2.1,"issues":["error: workspace not found"],"afterFailure":false,"uncertain":false}],
 "drift":{"unknown":[],"missing":[],"renamed":[{"from":"Validate configs","to":"Validate all configs"}],"changed":[]},
 "ok":false,"notes":[]}
```

- `workspace` is `null` at the local level. `level`: `local` | `plan` | `apply`. `fetched`: when the source repository was fetched (`null` when unknown).
- `steps[].level`: `local` | `read` | `apply` | `skip` | `unknown` (in no list). `kind`: the task (`PythonScript@0`) or `script` | `bash` | `pwsh` | `powershell` | `other`.
- `steps[].status`: `passed` | `failed` | `blocked` (a variable nobody can fill, or a local step that asks for a token) | `notRun` (condition false or not evaluable, held back, dry run) | `unknown` | `skipped` (other level, `skip`, after `--step`, a kind that does not run here) | `cannotRun` (listed, but a kind or program this PC cannot run). `--dry-run` adds `command` (the expanded command).
- `afterFailure`: ran after an earlier step failed. `uncertain`: comes after an unknown step.
- A failed step also has `excerpt` (the lines of its output that say why, at most 10, secrets masked) and `log` (the file with all of its output).
- `preflight steps --json`: `{ source, job, steps:[{ index, name, kind, level, script, condition, runnable, note }], drift, notes }`.

## Wiki update: `aihub wiki update ...` (Update Wiki with Context from…)

An agent updates chosen wiki pages (or a whole project wiki) from chosen source files; nothing reaches the wiki until `apply`. Always
JSON, failures as the wiki browser. The workspace is `<config>/aihub/wiki-updates/<id>/`: `pages/` (one markdown file per page:
`pages/Runbooks/Order export.md` is `/Runbooks/Order export`), `.base/` (the text each page was read at), `update.json` (pages with their
ETag, sources, language) and `TASK.md` for the agent. The team language (`language`) and the template of a new page (`wiki.pageTemplate`)
come from team.yaml. `aihub wiki update --page P --body-file F` (one page, no agent) is unchanged.

| Sub | Answer |
|---|---|
| `start --project P --wiki W [--path /Page]... [--sources-file F] [--prompt-file F]` | `{id,dir,pagesDir,project,wiki,chosen,allowNew,pages:[{path,file,exists}],sources,language,template,taskFile,agentPrompt}`; sources file `[{project,repo,path?,ref?,local?}]`; no `--path`: the whole wiki, new pages allowed; a code wiki is `badInput` (use Change with Agent) |
| `read --id ID --path /Page` | fetch another page into `pages/` (`{id,path,file,content}`) |
| `write --id ID --path /Page --content-file F` | set a proposal without file tools (`{id,path,file,pages,problems}`) |
| `diff --id ID` | `{id,status,project,wiki,chosen,allowNew,dir,pagesDir,pages:[{path,status:"modified"\|"added",additions,deletions,hunks,applied}],totals,problems:[{path,kind:"notChosen"\|"newNotAllowed"\|"secret"\|"empty",message}],applied}` |
| `apply --id ID [--path /Page]... [--comment-file C]` | `{id,results:[{path,status:"published"\|"created"\|"conflict"\|"refused"\|"failed",message?,etag?,webUrl?,current?}],left}`; If-Match on the ETag each page was read at: a page changed meanwhile is a `conflict` and is never overwritten; a page with a problem is `refused` |
| `discard --id ID [--path /Page]` | one page back to what was read (a new page goes), or the whole update |
| `list` | `{updates:[{id,project,wiki,chosen,status,createdAt,dir,updatedAt}]}` |

Extension: `aihub.bar.wikiUpdateStart|State|Apply|Discard` (`vscode/src/bar/types.ts`); the agent window is chosen like Change with Agent
(`where`: panel = This window, newWindow, terminal = Terminal only) and stopped with `aihub.bar.changeStop {id}`.