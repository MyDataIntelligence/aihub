---
name: pr-explain
description: "Use when the user wants a pull request explained: 'leg PR 42 uit', 'explain this PR', 'waar gaat deze PR over', 'samenvatting van de PR', '/explain'."
---
# Explain a pull request

## When
The user gives a PR id or link and wants to understand it, not to review or change it.

## Steps
1. Get the facts:

```sh
aihub pr explain --pr 42
```

2. Explain in plain language, at most 8 lines: why (the story), what changed (group the files by purpose), the state of the pipelines and open threads, what is still needed to merge.
3. Need more detail on one file: `aihub review show --pr 42 --max-files 3`.

Example: the link `.../pullrequest/42` gives `aihub pr explain --pr 42`.

## What the CLI fills
Title, story, description, file list with change types, pipeline results, thread counts, reviewers and the merge state. Do not ask the user for any of them.

## If it fails
Not signed in or not found: run `aihub doctor`. If a fact is missing, say it is unknown; never guess a pipeline result.

Rules: direct command, 0 questions. Read-only: do not comment, vote or complete.
