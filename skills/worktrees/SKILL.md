---
name: worktrees
description: "Use when several repositories must be on one branch or one folder needs a worktree per repository: 'maak een worktree set voor story 123', 'open groep X op branch Y', 'open mijn repos op dezelfde branch', 'werk in worktrees', 'ruim de worktrees op', 'welke branches horen bij story 123', 'deze is mijn nieuwste', 'zet repo-b op branch X', 'wissel de branch van repo-b', 'switch repo-b to X' (one repository of the open set: the window stays)."
---
# Worktree sets

## When
One story in more than one repository, or the main checkout must stay untouched.

## Steps
1. A set for a story (repositories cloned next to the current one): `aihub worktree create --story 123 --repos repo-a,repo-b`. Folder `<root>/123-<slug>/<repo>` (second branch: `<repo>--<variant>`); `--root <folder>`.
2. Several repositories on one branch, one VS Code window:

```sh
aihub worktree open --group pipeline --branch feature/4711-search
```

`--repos a,b,c`; one repository on its own branch: `--branch-for b=<branch>`; `--mode switch`; `--window this`. Groups: `aihub worktree groups list|save|remove`.
3. One repository of the open set on another branch ("zet repo-b op X"): `aihub branch switch --repo repo-b --branch X`, never `worktree open` (a new set). Same folder and window; output: `the window stays as it is: 3 repositories, repo-b now on X`. Uncommitted work or branch checked out elsewhere: nothing switches, the output says why; offer commit/stash, or `--mode worktree` (folder `repo-b--<variant>` added to this set).
4. `aihub worktree list`. Inside a set, `commit`, `pr create`, `pr update`, `pipeline follow` and `status` take `--all-repos`.
5. Done and pushed: `aihub worktree remove --story 123` or `--branch <b>`.

## Branches of a story
`aihub story branches --id 123`: repo -> branches, ★ = the one you work on. `link --id 123 [--branch a,b] [--current]`, `mark --branch b --status current|old|parked [--label t]` (one ★ per repository, no network), `unlink`, `remove --branch b [--delete-branch]`, `place --move all` (into the story folder). `aihub story open --id 123` opens the ★ of every repository as one set.

## What the CLI fills
Branches, folders, links and safety: a worktree with uncommitted or unpushed work is kept and reported; the remote branch is never deleted.

## If it fails
"Already checked out": switch the source repository to another branch first. Never remove a worktree folder by hand.

Rules: direct command, 0 questions.
