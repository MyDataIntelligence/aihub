---
name: team-settings
description: "Use when team settings are missing, unclear or must change: no team.yaml yet, a command stopped with 'missing team setting', 'pas team.yaml aan', 'andere branchnaam-regel', 'welke state bij start', 'change the PR template', 'add a release branch'."
---
# Team settings

## When
There is no `team.yaml` yet, a command stopped with `missing team setting <key>` (exit code 3), or the user wants other defaults: branch pattern, protected branches, story states, release branches, templates.

## Steps
1. No `team.yaml`: run `aihub team setup`. It detects what it can (remote, default branch, branch names, work item states, branch policies, PR template), writes a commented proposal and lists only the open questions, each with its `aihub team set` command.
2. Ask the user those questions in one message, with the choices shown. Do not guess an answer.
3. Run one `aihub team set <key> <value>` per answer. It changes only that key, keeps the comments and refuses a value that breaks the schema. Lists are comma-separated.
4. A new proposal goes to the team with `aihub init` (a pull request, never on the default branch). A change to an existing `team.yaml` goes through a topic branch and `aihub pr create --body-file change.md`.

Do not read or edit `team.yaml` yourself: `aihub team show` prints the values aihub uses with their source (team.yaml, detected, default); `--missing` only the open ones.

Example: `story start` stopped with `missing team setting workItems.states.active (found: Doing, Review)`. Ask "Which state does a started story get: Doing or Review?"; the user says Doing:

```sh
aihub team set workItems.states.active Doing
```

then repeat the `story start` command.

## What the CLI fills
`aihub team setup` fills every value it is sure of; `aihub doctor` reports open keys in the same `aihub team set` form; `aihub init` opens the pull request.

## If it fails
`team set` names the schema problem: fix that value only. Templates (story, commit, PR) are files: edit them on a topic branch and open a pull request.

Rules: secrets never go into `team.yaml`; no names of people or organisations in the generic pack; the team reviews every change through a pull request.
