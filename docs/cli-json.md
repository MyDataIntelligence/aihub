# JSON for tools: pr list, pr show, status, watch events

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
