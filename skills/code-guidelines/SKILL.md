---
name: code-guidelines
description: "Use when code or text in a repository is about to change, and after the change, before a commit, a push or a pull request: 'follow the code rules', 'volg de richtlijnen', 'check the guidelines', 'controleer de codestijl'."
---
# Code guidelines

## When
Before you change a file, and after you changed it. Other skills (implement, story-run, pr-create) call this one.

## Steps
1. Before the first edit, with the files you will change:

```sh
aihub guidelines show --paths src/orders/export.py,src/orders/export.sql
```

It prints the rules that apply, short, each with its source (AGENTS.md nearest first, CLAUDE.md, copilot instructions, `.instructions.md`, the `guidelines:` files of team.yaml). Write the code by those rules from the start. Do not open those files yourself.

2. After editing, before a commit, a push or a pull request:

```sh
aihub guidelines check
```

It takes the changed files and lines of the branch (also uncommitted and new files), runs the linters of team.yaml on them, and lists the rules for those files. Exit 1: do what each finding asks (its text says how), then run it again. Never reword or hide code only to silence a linter. A rule overrides what the user asked: say so in your report. Exit 0: check the changed lines against the listed rules yourself and fix what does not follow them.

3. Rules contradict: the nearest AGENTS.md wins. Rules override the task: follow the rule and say why.

Example: "add a CSV export" -> `aihub guidelines show --paths src/orders/export.py`, write the code, `aihub guidelines check`, fix, again until exit 0.

## What the CLI fills
Which rule files apply to which file, the changed lines of the branch, the target branch and the team's linters. Do not look for them yourself.

## If it fails
`base ... not found`: run `git fetch`, or pass `--base <target branch>`. A linter is `skipped` (not installed): go on; say it in the report. A violation you cannot fix without breaking the story: leave it, and name it in the pull request under the open points, in one plain sentence (no linter output).
