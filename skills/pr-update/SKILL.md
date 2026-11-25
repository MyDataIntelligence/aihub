---
name: pr-update
description: "Use when an open pull request needs new content: 'update de PR', 'werk de PR bij', 'voeg onder <sectie> toe', a dev.azure.com pullrequest link, '/pr-update'. The whole task is one command: aihub pr update --pr <url|N> --section \"<heading>\" --append-text \"<text>\"."
---
# Update a pull request

## When
Something must be added to or changed in an open PR description.

## Steps
To add or change ONE section run this single command. Never resend or rewrite the whole description:

```sh
aihub pr update --pr <url|N> --section "<heading>" --append-text "<short text>"
```

`--pr` takes the dev.azure.com link or the number (omit it for the PR of the current branch). Use `--replace-text` to replace the section, `--append-file f.md` / `--replace-file f.md` for long prose.

After a data-changing push and when `team.yaml` has `dataChecks:`, refresh the numbers with `aihub pr data-diff --write`.

Test evidence: `aihub pr tests add --from-run <build id>` (or `--from-robot`, `--from-fabric-job <ws>/<item>/<job>`) adds an honest row from the real run. 
Do not run `git status`, `aihub pr changes`, `--help` or read the template first. Do not ask questions.

Example: "voeg onder Testen toe: handmatig getest" with a link -> `aihub pr update --pr https://dev.azure.com/org/proj/_git/repo/pullrequest/42 --section "Testen" --append-text "Handmatig getest."`

## Actions for the platform's users
First run `aihub pr impact`. The section for the platform's users (user actions, migration, breaking changes) says what changes for THEM in THEIR files (the template's own heading). Start with one line "Who is affected" unless everyone is. Per action: their files (names or pattern + count, from the impact output), the field old -> new or the new required field with an example, and how to check. Internal changes stay out; contract untouched: the empty text only. Never "compare", "review", "migrate" or "ensure" without saying what. The CLI refuses vague text; `--as-is` only when the user says so.
Good: "- jobs/orders_ingest.yaml: rename target_table -> destination.table; check: make validate-jobs"

## What the CLI fills
Edits only that section; the rest stays byte for byte. New commits: `git push` first.

## If it fails
Run `aihub doctor`. Never invent ids or links.
