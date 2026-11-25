---
name: commit
description: "Use when the user wants changes committed: 'commit', 'commit mijn wijzigingen', 'commit en push', 'commit and push', '/commit'. The whole task is one command: aihub commit --type <feat|fix|docs|test|chore|refactor> --subject \"<what changed>\" [--push]."
---
# Commit changes

## When
The user wants the working changes committed, optionally pushed.

## Steps
Run this ONE command, nothing before it:

```sh
aihub commit --type <feat|fix|docs|test|chore|refactor> --subject "<what changed, in the team language>" [--push]
```

Add `--push` only when the user asked to push. One commit takes every changed and new file. In a worktree set (the CLI prints a `note: set story-N` line) or when the user says 'in alle repos': add `--all-repos`, one call commits every repository with changes. Do not run `git status`, `git log` or read the commit template first. Do not ask questions.

Example: "commit mijn wijzigingen en push ze" -> `aihub commit --type feat --subject "toon het totaal van een order" --push`

## What the CLI fills
The message format from `team.yaml` (`commits.format`): scope from the changed folder, the story id from the branch name. It stages everything and refuses protected branches.

## If it fails
Read the error (unknown type, nothing to commit, protected branch). Never invent a story id.

A git hook stopped it (`not committed` or `not pushed: the ... hook stopped it`): the error names the failed check, its lines and the choices. Something you can fix (lint, format, a failing test): fix it and run the same command again, without asking. Otherwise give the user the choices in one line: fix it, `--skip-hooks <id>` or `--no-verify`. Use those two flags only after the user says so ("commit toch", "sla de hook over"). `not pushed`: the commit is there; the same command again only pushes.
