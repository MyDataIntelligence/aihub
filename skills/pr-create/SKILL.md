---
name: pr-create
description: "Use when the user wants a pull request: 'maak een PR', 'create a PR', 'open a pull request', '/pr'. The whole task is one command: aihub pr create --summary-text \"<1-2 sentences>\"."
---
# Create a pull request

## When
The user wants a PR for the current branch.

## Steps
First `aihub guidelines check`; fix what it lists (what stays: one open point in plain words). Then:

```sh
aihub pr create --summary-text "<1-2 sentences: what and why, in the team language>"
```

In a worktree set (`Set:` in `aihub status`) add `--all-repos`. Show the PR link. When `team.yaml` has `dataChecks:`, then run `aihub pr data-diff --write` (read-only; never ACC/PRD). When the branch changes a dbt project, run `aihub dbt impact --write` first (skill `dbt`). Use the team template.

Optional, only when the user gave more: `--title "<t>"`, `--draft`, `--target <branch>`, `--work-item <id>`, `--body-file pr.md` (`## <template heading>` sections).

The CLI adds the story's criteria table. Not all proven: exit 5, nothing written; ask the user: test first, `--draft` or `--anyway`.

Write short, for the reviewer, only under the team template's headings (others are left out): what changes, why, what users must do. Tests only if the template has them: functional tests really done with result, else "Not run yet." No unit-test counts, environment problems or coordination: refused (`--as-is` only if the user says so).

## Actions for the platform's users
First run `aihub pr impact`. The section for the platform's users (user actions, migration, breaking changes) says what changes for THEM in THEIR files (the template's own heading). Per action: their files (names or pattern + count, from the impact output), the field old -> new or the new required field with an example, and how to check. Internal changes stay out.
Good: "- jobs/orders_ingest.yaml: rename target_table -> destination.table; check: make validate-jobs"

## What the CLI fills
Pushes the branch; target, title, story link, commits, empty sections and template come from the repo and `team.yaml`.

## If it fails
Read the error. Login or team file problem: run `aihub doctor`. Never invent links or ids.
