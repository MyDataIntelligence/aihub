---
name: remote-repos
description: "Use when the user asks about or wants a change in a repository that is not cloned, or about several repositories at once: 'zoek in alle repos', 'waar wordt X gebruikt', 'pas dit bestand aan in repo Y zonder clone', 'vraag over deze repos', 'search across repositories', 'change this in repo Y', 'zoek overal naar X', 'search everywhere'."
---
# Repositories without a clone

## When
The work is in an Azure DevOps repository not on this PC, or spans several repositories or projects. Nothing is cloned.

## Steps
1. Where is it? `aihub search all "<text>"`: repositories, files, text, branches, stories, PRs, wiki, pipelines at once (`--kinds prs --top 20`: one kind).
2. Narrow down: `aihub browse search --text "<text>" --scope P,P/R`, `aihub browse items|file --project P --repo R --path /p`.
3. A question over several repositories (read only): `aihub browse ask start --scope P/R1,P/R2 --prompt-file q.txt`, then follow its TASK.md: `ask read` (counted; past 200 files ask the user, they run `aihub browse ask allow`), `ask propose` for a fix, `ask report`. Per repository the user can then `aihub browse ask apply`.
4. A change in one repository: `aihub browse change start --project P --repo R --paths /file --prompt-file task.txt`, then follow its TASK.md: edit under `files/`, `change read` for more files, `aihub browse change verify --id ID [--tests]` (`couldNotRun`: not run, no failure), `change summary`. Show `change diff --id ID`.
5. Push only after the user says so:

```sh
aihub browse change push --id ID --pr --draft --story 4711
```

Example: "zet in repo orders-ingest de filter op actieve klanten, zonder clone": `change start`, edit under `files/`, `change diff`, a yes, the push above.

## What the CLI fills
Base commit, branch name, the PR (template, story, criteria), conflicts (`--rebase`), and the limits: never main, master, staging or develop, at most 20 files, no secrets, pipelines or variable groups.

## If it fails
`searchUnavailable`: Code Search is off; the CLI searches the clones on this PC and says what it skipped. `conflict`: offer `--rebase`. Exit 5 (`criteriaNotProven`): ask test first, `--draft` or `--anyway`; `--draft` unless the user says otherwise. `aihub doctor` for sign-in.

Rules: read only until the user asks for a change; never push without a yes.
