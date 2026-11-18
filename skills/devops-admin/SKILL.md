---
name: devops-admin
description: "Use when Azure DevOps itself must be looked at or changed, not code: 'welke branch policies', 'maak een variable group', 'zoek in de code', 'wiki pagina verplaatsen', 'sprint planning', 'test plan', 'wie mag hier mergen', 'welke feeds'."
---
# Azure DevOps administration

## When
Branch policies, variable groups, branches and tags on the server, wiki, boards and sprints, searches, test plans or package feeds. Pipelines: `pipeline-author` and `pipeline-fix`.

## Steps
Read first, write second. Writes take `--dry-run`, deletes need `--yes`, lists take `--json`.

| Need | Command |
|---|---|
| Branch policies | `aihub policy list [--branch main]`, `create --type min-reviewers\|build\|work-item-linking\|comment-resolution\|required-reviewers\|merge-strategy\|status`, `update`, `delete --id N --yes` |
| Variable groups | `aihub library list\|show\|set\|diff\|usage` (a secret only with `--secret --value-stdin`) |
| Server side git | `aihub repo branch list\|create\|lock`, `tag`, `tree`, `file`, `commits`, `diff` |
| PR admin | `aihub pr reviewers\|vote\|labels\|status\|workitems\|abandon\|publish` |
| Search | `aihub search code\|wiki\|items --text "..."` |
| Wiki | `aihub wiki read\|pages\|create\|move\|history` |
| Boards | `aihub boards query run --mine`, `sprint items`, `workitem get\|update\|link\|comment` |
| Tests, feeds | `aihub testplan plans\|points\|runs`, `aihub artifacts feeds\|packages` |

```sh
aihub policy list --branch main
aihub library set --group vg-dev --name API_URL --value https://x.example --dry-run
```

Example: "wie moet hier goedkeuren" is `aihub policy list --branch main`, then `aihub pr reviewers list`.

## What the CLI fills
Organisation, project, repository, team and the default branch come from the remote and team.yaml. Types and ids are looked up by name.

## If it fails
403: the account lacks the permission or, for Test Plans, the license. ACC and PRD (names with acc, prd) are refused unless `--allow-env` and the developer asked.

Rules: show a dry-run before a write the user did not ask for literally. Never print or log secret values.
