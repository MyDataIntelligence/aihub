---
name: branch-sync
description: "Use when a change must move between branches: 'cherry-pick to release', 'cherry-pick naar', 'zet de wijziging ook op', 'update my branch', 'werk de branch bij met main', '/cherry-pick'."
---
# Cherry-pick and branch update

## When
A change must go to other branches, or the own branch is behind its target.

## Steps
Run this ONE command, nothing before it. `--from` takes a PR (number or link), a commit sha or a story id:

```sh
aihub cherry-pick --from <pr|sha|story> --to <branch> --summary-text "<1-2 sentences: what and why, in the team language>"
```

It cherry-picks in a temp worktree, pushes a branch per target and opens the PR per target (team template, story link). Repeat `--to` for more branches, or `--to-group <name>` (`team.yaml` `cherryPick.groups`). Show the PR links it prints. Do not run `git checkout`, `git cherry-pick`, `git log`, or `aihub pr create` yourself; no `--help`.

Bring the own branch up to date with its target: `aihub branch update`.

Example: "cherry-pick PR 42 naar release/1.2" -> `aihub cherry-pick --from 42 --to release/1.2 --summary-text "Zet de fix ook op release 1.2."`

## What the CLI fills
Branch names, merge commits, ordering, protected-branch checks (`branches.protected`), the PR title, description and story link.

## If it fails
Conflict: nothing is pushed; resolve it with your own git tools, then rerun. Never invent branch names or links.
