---
name: worktrees
description: "Use when several repositories must be on one branch or one folder needs a worktree per repository: 'maak een worktree set voor story 123', 'open groep X op branch Y', 'open mijn repos op dezelfde branch', 'werk in worktrees', 'ruim de worktrees op', 'welke branches horen bij story 123', 'deze is mijn nieuwste', 'zet repo-b op branch X', 'wissel de branch van repo-b', 'switch repo-b to X', 'voeg repo-d toe aan deze set', 'haal repo-d uit de set' (the open set changes, the window stays), 'worktree already exists'."
---
# Worktree sets

## When
Several repositories for one story, or the main checkout stays untouched.

## Steps
1. A set for a story: `aihub worktree create --story 123 --repos repo-a,repo-b` (folder `<root>/123-<slug>/<repo>`).
2. Several repositories on one branch, one VS Code window:

```sh
aihub worktree open --group pipeline --branch feature/4711-search
```

`--repos a,b,c`; own branch for one: `--branch-for b=<branch>`; groups: `aihub worktree groups`.
3. Inside the open set (the window stays; never `worktree open`, that makes a new set):
   - "zet repo-b op X": `aihub branch switch --repo repo-b --branch X`. Uncommitted work: nothing switches; offer commit/stash or `--mode worktree`.
   - "voeg repo-d toe aan deze set": `aihub worktree add --repos repo-d [--branch X]`.
   - "haal repo-d uit de set": `aihub worktree drop --repos repo-d` (work in it: kept and reported).
   - Set file edited by hand: `aihub worktree repair`.
4. `aihub worktree list`. Inside a set, `commit`, `pr create|update`, `pipeline follow`, `status` take `--all-repos`.
5. Done and pushed: `aihub worktree remove --story 123` or `--branch <b>`.

## Branches of a story
`aihub story branches --id 123`: repo -> branches, ★ = the one you work on; `link`, `mark --branch b --status current|old|parked`, `unlink`, `remove`, `place --move all` (`--help`). `aihub story open --id 123`: the ★ of every repository as one set.

## What the CLI fills
Branches, folders, links, safety; the remote branch is never deleted.

## If it fails
`worktree for <b> already exists: ... choose: ...` (exit 3, nothing changed): ask ONE question with its three choices, move first; run the chosen ready command. Already said "verplaats hem", "zet hem erbij", "hergebruik" -> `--existing move`; "maak opnieuw aan", "gooi de oude weg" -> `--existing recreate`. Lasting habit: `aihub worktree when-exists move`. Never remove worktree folders by hand.

Rules: direct command; only that one question.
