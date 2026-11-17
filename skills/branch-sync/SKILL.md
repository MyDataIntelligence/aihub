---
name: branch-sync
description: "Use when a change must move between branches: 'cherry-pick to release', 'cherry-pick naar', 'update my branch', 'werk de branch bij met main', '/cherry-pick'."
---
# Cherry-pick and branch update

## When
A merged change must go to other branches, or the own branch is behind its target.

## Steps
Cherry-pick a PR or commits to one or more branches (groups from `team.yaml` `cherryPick.groups` work too):

```sh
aihub cherry-pick --from 42 --to release/1.2 --to release/1.3
```

Bring the own branch up to date with its target:

```sh
aihub branch update
```

Example: "cherry-pick PR 42 naar release/1.2" gives the first command; then show the new PR links.

## What the CLI fills
Merge commits, ordering, one new PR per target and protected-branch checks (`branches.protected`). Do not ask the user about targets that `team.yaml` defines.

## If it fails
Conflict: resolve it with your own git tools, commit, push, rerun. Never invent branch names or links.

Rules: direct command, 0 questions. Local git status, diff, commit and push use your own tools.
