---
name: implement
description: "Use when the user wants a story built: 'implement story 123', 'implementeer deze story', 'werk story 123 uit', 'start met de story'."
---
# Implement a story

## When
A story id is known and code must change.

## Steps
1. Read the story and where to look: `aihub story context --id 123` (story, criteria, linked PRs and branches, the 15 most relevant files). Follow its acceptance criteria; read the listed files with your own tools.
2. Create or switch to a feature branch with your own git tools, named per `team.yaml` (`branches.feature`).
3. Code and test with your own tools. Keep the change minimal. Test only what you changed: `aihub test changed --run` (or the tests of the changed modules with your own runner). Never the whole suite locally; the pipeline runs it. dbt project: skill `dbt`.
4. Commit, one logical change per commit. When `team.yaml` has `commits.format`, use `aihub commit --type <type> --subject "<what changed>"` (it builds the message and takes the story id from the branch). Without `commits.format`, use plain git and the commit template named in `team.yaml` (else `<type>: <summary> (#<story id>)`), story id in the message.
5. Push the own branch (`aihub commit ... --push`, or git). `aihub commit` prints which git hooks run and how long they took: tell the user if slow. A hook stops it: fix what it names and run again; `--no-verify` only when the user says so. In a worktree set (`Set:` in `aihub status`) add `--all-repos` to `aihub commit`. Then follow pr-create.

Example: `aihub story context --id 123`, `git switch -c feature/123-csv-export`, code, `aihub commit --type feat --subject "CSV export"`.

## What the CLI fills
The story text, links and the branch pattern. Do not ask the user for the story content or the commit format.

## If it fails
Unknown id: run `aihub doctor` and report. Requirement unclear: decide, and note the assumption in the PR instead of asking.

Rules: no ceremony. Local git status, diff and branch work use your own tools; commits use `aihub commit` when the team defines `commits.format`. Commit language follows the team template. Never invent ids or links.
