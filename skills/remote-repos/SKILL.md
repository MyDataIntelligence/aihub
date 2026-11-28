---
name: remote-repos
description: "Use when the user asks about or wants a change in a repository that is not cloned, or about several repositories at once: 'zoek in alle repos', 'waar wordt X gebruikt', 'pas dit bestand aan in repo Y zonder clone', 'vraag over deze repos', 'search across repositories', 'change this in repo Y'."
---
# Repositories without a clone

## When
The work is in an Azure DevOps repository that is not on this PC, or spans several repositories or projects. Everything goes through `aihub browse`; nothing is cloned.

## Steps
1. Find: `aihub browse search --text "<text>" --scope P,P/R` (projects and repositories), `aihub browse find --query <file name>`, `aihub browse items --project P --repo R --path /dir`, `aihub browse file --project P --repo R --path /file`.
2. A question over several repositories (read only): `aihub browse ask start --scope P/R1,P/R2 --prompt-file q.txt`, then follow its TASK.md: `ask read` (counted; past 200 files ask the user, they run `aihub browse ask allow`), `ask propose` for a fix, `ask report`. Per repository the user can then `aihub browse ask apply`.
3. A change in one repository: `aihub browse change start --project P --repo R --paths /file --prompt-file task.txt`, then follow its TASK.md: edit under `files/`, `change read` for more files, `aihub browse change verify --id ID [--tests]` (lint and tests in a temporary copy), `change summary`. Show `change diff --id ID`.
4. Push only after the user says so:

```sh
aihub browse change push --id ID --pr --story 4711
```

Example: "zet in repo orders-ingest de filter op actieve klanten, zonder clone" is `change start` with the file, the edit under `files/`, `change diff`, a yes, then the push above.

## What the CLI fills
Base commit, branch name from team.yaml, the PR template and story link, conflicts when the base branch moved (`--rebase`), and the limits: never main, master, staging or develop, at most 20 files, no secrets, pipelines or variable groups.

## If it fails
`searchUnavailable`: Code Search is off; the CLI searches the clones on this PC and says what it skipped. `conflict`: show both changes and offer `--rebase`. `aihub doctor` for sign-in.

Rules: read only until the user asks for a change; never push without a yes.
