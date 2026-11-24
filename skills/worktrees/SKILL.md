---
name: worktrees
description: "Use when several repositories must be on one branch or one folder needs a worktree per repository: 'maak een worktree set voor story 123', 'open groep X op branch Y', 'open mijn repos op dezelfde branch', 'werk in worktrees', 'ruim de worktrees op', 'welke branches horen bij story 123', 'deze is mijn nieuwste'."
---
# Worktree sets

## When
One story in more than one repository, or the main checkout must stay untouched.

## Steps
1. A set for a story (repositories cloned next to the current one): `aihub worktree create --story 123 --repos repo-a,repo-b`. Folder `<root>/123-<slug>/<repo>` (a second branch of a repository: `<repo>--<variant>`; an older `story-123` folder is reused); `--root <folder>`.
2. Several repositories on one branch, one VS Code window:

```sh
aihub worktree open --group pipeline --branch feature/4711-search
```

`--repos a,b,c` instead of `--group`; `--mode switch` switches the checkouts (dirty ones skipped); `--window this`; `--json`. Groups: `aihub worktree groups list|save <name> --repos a,b|remove <name>`.
3. `aihub worktree list`. Inside a set, `commit`, `pr create`, `pr update`, `pipeline follow` and `status` take `--all-repos`.
4. Done and pushed: `aihub worktree remove --story 123` or `--branch <b>`.

## Branches of a story
`aihub story branches --id 123`: repo -> branches, ★ = the one you work on, local work, pushed, PR. `link --id 123 [--branch a,b] [--current]` (Azure DevOps Development link), `mark --branch b --status current|old|parked [--label t]` (one ★ per repository, no network), `unlink`, `remove --branch b [--delete-branch]`, `place --move all` (into the story folder). `aihub story open --id 123` opens the ★ of every repository as one set.

## What the CLI fills
The story branch, the folders, the links and the safety checks: a worktree with uncommitted or unpushed work is kept and reported, folder links (a linked node_modules) go first, the remote branch is never deleted.

## If it fails
"Already checked out": switch the source repository to another branch first. Never remove a worktree folder by hand.

Rules: direct command, 0 questions.
