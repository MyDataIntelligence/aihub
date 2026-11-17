---
name: pr-create
description: "Use when the user wants a pull request: 'maak een PR', 'create a PR', 'open a pull request', '/pr'."
---
# Create a pull request

## When
Commits are pushed (or ready) on the own branch.

## Steps
1. Check with git (own tools): `git status`, `git diff main...HEAD`. Push the branch if needed.
2. Private branch notes (`aihub note add "why"`, kept in `.git/aihub/notes`, never committed) are woven into the context section by `pr create`; save the user's reasons there when they say them. Write the description to a file following the team PR template ([default](../_shared/assets/pull_request_template.md)). State only what was really done and tested; write "not run" for the rest.
3. Run one command:

```sh
aihub pr create --body-file pr.md
```

4. Show the PR link the CLI prints.

Example: `aihub pr create --body-file pr.md` creates the PR to the right target, linked to the story.

## What the CLI fills
Title, target branch and merge base, story link, reviewers, empty sections (`pullRequest.emptySection`) and the repository. Never ask the user about these.

## If it fails
Read the error text. Missing push: push, retry. Wrong target: run `aihub doctor`. Never invent links or ids.

Rules: a direct command is done at once with 0 questions. Content language follows the template. Local git uses your own tools.
