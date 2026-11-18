---
name: team-settings
description: "Use when team settings or templates must change: 'pas team.yaml aan', 'wijzig het story-sjabloon', 'andere branchnaam-regel', 'change the PR template', 'add a release branch'."
---
# Change team settings

## When
The user wants other defaults: branch pattern, protected branches, story states, release groups, pipelines, or one of the templates (story, commit, pull request).

## Steps
1. Read the current file: `.agents/skills/_shared/references/team.yaml` of the team repository. Templates are the files named there.
2. Create a topic branch such as `chore/team-settings` from the default branch.
3. Edit the file, keeping every unrelated line. Check it with `aihub doctor`.
4. Open a pull request with the usual flow:

```sh
aihub pr create --body-file change.md
```

Example: "protected branch release/* erbij" adds the pattern to `branches.protected`, runs `aihub doctor`, and opens a PR.

## What the CLI fills
`aihub doctor` validates the file against the schema; `aihub pr create` fills the PR template and links.

## If it fails
`doctor` reports the failing key: fix that key only. Never edit the file on the default branch, never push directly, never put names of people or organisations in the generic pack.

Rules: the team repository owns team knowledge; change it through a pull request so the team reviews it.
