---
name: pr-create
description: "Use when the user wants a pull request: 'maak een PR', 'create a PR', 'open a pull request', '/pr'. The whole task is one command: aihub pr create --summary-text \"<1-2 sentences>\"."
---
# Create a pull request

## When
The user wants a PR for the current branch.

## Steps
Run this ONE command from the repository, nothing before it:

```sh
aihub pr create --summary-text "<1-2 sentences: what and why, in the team language>"
```

Show the PR link it prints (team.yaml `pullRequest.afterCreate` may also set the story state and auto-complete; the result line says so). When `team.yaml` has `dataChecks:`, then run `aihub pr data-diff --write` (read-only before/after numbers in the PR; never ACC/PRD). When the branch changes a dbt project, run `aihub dbt impact --write` first (affected models, tests, exposures in the PR; skill `dbt`). Do not run `git status`/`diff`/`log` first, do not read the template or `team.yaml`, do not look up the story, do not ask questions.

Optional, only when the user gave more: `--title "<t>"`, `--draft`, `--target <branch>`, `--work-item <id>`, `--body-file pr.md` (markdown with `## <template heading>` sections for long prose).

Example: "maak een PR" -> `aihub pr create --summary-text "Voegt de orderexport toe zodat orders als CSV te delen zijn."`

## What the CLI fills
Pushes the branch; target branch, title, story link (AB#), commits, reviewers, empty sections and the template come from the repo and `team.yaml`. Private notes (`aihub note add "why"`) are woven in.

## If it fails
Read the error. Login or team file problem: run `aihub doctor`. Never invent links or ids.
