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

Add `--push` only when the user asked to push. One commit takes every changed and new file. Do not run `git status`, `git log` or read the commit template first. Do not ask questions.

Example: "commit mijn wijzigingen en push ze" -> `aihub commit --type feat --subject "toon het totaal van een order" --push`

## What the CLI fills
The message format from `team.yaml` (`commits.format`): scope from the changed folder, the story id from the branch name. It stages everything and refuses protected branches.

## If it fails
Read the error (unknown type, nothing to commit, protected branch). Never invent a story id.
