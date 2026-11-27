# JSON for tools: pr list, pr show, status, watch events, pipelines, repository browser, wiki browser

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
`kind`: `folder`, `file` or `submodule`; `sizeBytes` is `null` (Azure DevOps does not list sizes); `lastCommit` only with `--last-commit`.
`{"ref":{…},"path":"/dbt","readAt":"…","cached":false,"items":[{"name":"models","path":"/dbt/models","kind":"folder","sizeBytes":null,"objectId":"<sha>","lastCommit":null}]}`

`aihub browse file --project P --repo R --path /file [--ref ...] [--max-bytes 1048576]`: `{"ref":{…},"path":"/notebooks/export_orders.py",
"objectId":"<blob sha>","sizeBytes":2310,"lastCommit":{…},"binary":false,"tooLarge":false,"content":"…","webUrl":"…"}`. A binary file or one
larger than `--max-bytes` has `content: null` (the UI offers Open in Browser).

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

`aihub browse search --text T [--project P] [--repo R (needs --project)] [--path /p] [--ext py,sql] [--top 25]` (Code Search): the lines
come from each file at the indexed commit (Code Search gives only offsets), `ranges` are `[start, end)` columns.
`{"count":23,"results":[{"project","repo","path","branch":"main","commit":"<sha>","clone":null,"matches":[{"line":14,"text":"MAX_RETRIES = 3","ranges":[[0,11]]}]}],"notSearched":[{"what":"20 more file(s)","reason":"only the first 3 are shown (--top)"}]}`.
Without Code Search: `{"error":{"kind":"searchUnavailable",…}}`.

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
- `list --view mine|sprint|backlog [--types a,b] [--search 123|text] [--top 200]` -> `{ view, project, team, types, iterationPath?, items:[ItemRow], readAt, cached }`
- ItemRow: `{ id, rev, type, title, state, stateCategory, assignedTo:{name,email,isMe}|null, areaPath, iterationPath, priority?, severity?, storyPoints?, tags:[], parent?, changedDate, url, local:{ set?:{folder,name}, branches:[{repo,branch,worktree?}] } }`
- `board [--board B] [--types a,b]` -> `{ board, columnField?, columns:[{ name, states, category, isDone, wipLimit?, items:[ItemRow] }] }` (an item sits in its own board column; the done column shows two weeks)
- `show --id N` -> ItemRow plus `allowedStates:[{name,category}]`, `severityValues?`, `priorityValues?`, `sections:[{heading,field,markdown,html}]` (the team template; a Bug keeps its text in ReproSteps), `systemInfo?:{markdown,html}`, `tasks:[{id,rev,title,state,done,assignedTo}]`, `parentItem`, `related`, `children`, `development:{branches,prs,builds}`, `comments:[{id,author,date,markdown,html}]`, `template`
- `move --id N (--to <state> | --column C [--board B]) --rev R`; `edit --id N --rev R [--title] [--state] [--assign me|<email>|none] [--priority] [--severity] [--points] [--tags a;b] [--iteration] [--area] [--sections-file f] [--system-info-file f]` (only the sections in the file change); `task --id <task> --done|--undone [--rev R]`; `add-task --parent N --title t`; `comment --id N --text-file f`
- `refine-ask --id N` -> `{ prompt, proposalFile, gaps }`; `refine --id N` -> `{ rev, parts:[{part,heading,current,proposed,changed}], tasks:{current,proposed,new} }` (reads only); `refine-apply --id N --rev R --parts description,criteria,tasks` writes only those parts
- `start --id N [--repos a,b] [--base B] [--set reuse|none] [--no-assign] [--open new|this|none]` -> branches per repository, state to the active state, assigned to me, the story's set
- `form --type T`; `new --type T --title t [--sections-file f] [--system-info-file f] [--severity] [--priority] [--parent N] [--iteration current|path] [--area] [--assign me]` -> `{ id, rev, type, title, url, template }`
- `draft-ask --type T --title t [--notes-file f]` -> `{ prompt, draftFile }`; `draft --draft-file f` -> `{ sections:[{heading,markdown}] }`
- `link --id N (--set <folder> | --repo R --branch B)` -> `{ linked:[{repo,branch,added}], prs:[{repo,id,added}] }`; `fix-branch --id N [--repo R] [--base B]` -> `bugfix/<id>-<slug>` (team.yaml `branches.bugfix` wins), pushed and linked
