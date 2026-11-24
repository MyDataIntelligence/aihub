---
name: story-start
description: "Use when the user starts work on a story: 'start story 123', 'begin met story 123', 'pak story 123 op', 'werk aan 123', '/start', 'maak een branch voor de story'."
---
# Start a story

## When
A story id is given and no branch for it exists yet, or the branch is not linked to the story. "Start" means only this: branch, link, state. It does not mean implement.

## Steps
1. Run one command in the current repository:

```sh
aihub story start --id 123
```

2. Several repositories: add `--repos repo-a,repo-b` (clones next to this one). Add `--base release/1.2` only when the user names another base.
3. Report the branch, the base and the new story state in one line, offer the next step in one line ("Zal ik hem nu bouwen?") and STOP. Do not read the story, the code or the templates, do not implement, commit, push or open a PR in the same turn: that is a separate request (implement, story-run).

Do not read `team.yaml` or the templates yourself: the CLI applies them.

To link a branch you already made: `aihub story link --id 123`.

Example: "start 123 in repo-a and repo-b" is `aihub story start --id 123 --repos repo-a,repo-b`, then one line of result and stop.

## What the CLI fills
Branch name from `team.yaml` (`branches.feature`), the base branch, the push, the link between story and branch, and the story state. Without `workItems.states` in `team.yaml` the state comes from the process (first "in progress" state). A wrong state name fails before anything is created. A branch that already exists is reused.

## If it fails
Report the error text in one line. Not signed in: `aihub doctor`. A dirty checkout is not switched: say so. Never invent ids.

Rules: one command, 0 questions. Local git uses your own tools.
