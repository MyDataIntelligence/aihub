---
name: implement
description: "Use when the user wants a story built: 'implement story 123', 'implementeer deze story', 'werk story 123 uit', 'start met de story'."
---
# Implement a story

## When
A story id is known and code must change.

## Steps
1. Read the story and where to look: `aihub story context --id 123` (story, acceptance criteria, linked PRs and branches, the 15 most relevant files, no file bodies). Follow its acceptance criteria; read the listed files with your own tools.
2. Create or switch to a feature branch with your own git tools, named per `team.yaml` (`branches.feature`).
3. Code and test with your own tools. Keep the change minimal.
4. Commit per the commit template ([default](../_shared/assets/commit-template.txt), or the team copy), one logical change per commit, story id in the message.
5. Push the own branch with git. Then follow pr-create.

Example: `aihub story context --id 123`, then `git switch -c feature/123-csv-export`, code, `git commit -m "feat: CSV export (#123)"`.

## What the CLI fills
The story text, links and the branch pattern. Do not ask the user for the story content or the commit format.

## If it fails
Unknown id: run `aihub doctor` and report. Requirement unclear: decide, and note the assumption in the PR instead of asking.

Rules: no ceremony. Local git status, diff, commit and push of the own branch use your own tools, never `aihub`. Commit language follows the team template. Never invent ids or links.
