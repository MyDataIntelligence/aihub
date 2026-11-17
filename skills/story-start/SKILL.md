---
name: story-start
description: "Use when the user starts work on a story: 'start story 123', 'begin met story 123', 'werk aan 123', '/start', 'maak een branch voor de story'."
---
# Start a story

## When
A story id is given and no branch for it exists yet, or the branch is not linked to the story.

## Steps
1. Start it in the current repository:

```sh
aihub story start --id 123
```

2. Several repositories: add `--repos repo-a,repo-b` (clones next to this one). Add `--base release/1.2` only when the user names another base.
3. Report the branch, the base and the new story state in one line.
4. Then follow implement, or worktrees when the user wants one folder for all repositories.

To link a branch you already made: `aihub story link --id 123`.

Example: "start 123 in repo-a and repo-b" is `aihub story start --id 123 --repos repo-a,repo-b`.

## What the CLI fills
Branch name from `team.yaml` (`branches.feature`), the base branch, the push, the link between story and branch, and the story state (Active). A branch that already exists is reused.

## If it fails
Run `aihub doctor`. A dirty checkout is not switched: say so and continue on the new branch only after the user commits or stashes. Never invent ids.

Rules: direct command, 0 questions. Local git uses your own tools.
