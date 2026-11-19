---
name: worktrees
description: "Use when several repositories must be on one branch or one folder needs a worktree per repository: 'maak een worktree set voor story 123', 'open groep X op branch Y', 'open mijn repos op dezelfde branch', 'werk in worktrees', 'ruim de worktrees op'."
---
# Worktree sets

## When
One story is built in more than one repository, or the user wants to keep the main checkout untouched.

## Steps
1. Make the set (repositories are cloned next to the current one):

```sh
aihub worktree create --story 123 --repos repo-a,repo-b
```

2. Work inside the printed folders; each is on the story branch. Use `--root <folder>` to choose where sets live.
3. See all sets and their state: `aihub worktree list`. Inside a set, `aihub commit`, `pr create`, `pr update`, `pipeline follow` and `status` take `--all-repos`: every repository at once, one table, unchanged ones skipped.
4. When done and pushed: `aihub worktree remove --story 123`.

## Several repositories on the same branch
"Open groep X op branch Y" is one command: the branch in every repository of the group (existing, else created from `--from` or its `defaultTarget`), a worktree each, one VS Code window:

```sh
aihub worktree open --group pipeline --branch feature/4711-search
```

`--repos a,b,c` instead of `--group`; `--mode switch` switches the checkouts (dirty ones are skipped, the rest continues); `--window this`; `--json`. Groups are personal: `aihub worktree groups list|save <name> --repos a,b|remove <name>`. Remove: `aihub worktree remove --branch <b>`.

Example: "zet story 123 klaar in repo-a en repo-b" is `aihub worktree create --story 123 --repos repo-a,repo-b`.

## What the CLI fills
The story branch (existing one, else the name from `team.yaml` and the base), the folder `story-123`, and the safety checks on removal. A worktree with uncommitted or unpushed work is kept and reported; the branch itself is never deleted here (use story-finish).

## If it fails
"Already checked out": the source repository sits on that branch; switch it to another branch first. Run `aihub doctor` for sign-in problems. Never remove a worktree folder by hand.

Rules: direct command, 0 questions. Local git inside a worktree uses your own tools.
