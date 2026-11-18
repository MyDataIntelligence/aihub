---
name: devops-repos
description: "Use when the code probably lives in another repository of the project: 'look in repo X', 'clone the other repo', 'welke repositories zijn er', 'staat dat in een andere repo'."
---
# Find and clone other repositories

## When
The user names or suspects another repository of the Azure DevOps project, or the story touches code that is not in this one.

## Steps
1. List the project's repositories and see which are already cloned next to this one:

```sh
aihub repos list --filter billing
```

2. Not cloned and needed: `aihub repos clone --name billing-api`. It clones next to this repository and never touches an existing folder.
3. Search and read in that folder with your own tools (`git grep`, file reads). Do not clone repositories nobody asked for.
4. Say which repositories you cloned and where.

Example: "staat dat in de billing repo?" gives `aihub repos list --filter billing`, `aihub repos clone --name billing-api`, then `git grep` in `../billing-api`.

## What the CLI fills
Project, remote URL, default branch and the clone folder. Do not ask the user for URLs.

## If it fails
Not signed in or clone refused: run `aihub doctor` and show the output. Unknown name: show the list and pick the closest match only if it is unambiguous.

Rules: reading is free, cloning only what is needed, 0 questions. Local git uses your own tools.
