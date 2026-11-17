---
name: pr-update
description: "Use when an open pull request needs new content: 'update de PR', 'update the PR description', 'werk de PR bij', '/pr-update', new commits were pushed."
---
# Update a pull request

## When
The own branch has new commits or the description is out of date.

## Steps
1. With git (own tools): `git status`, push new commits.
2. See what changed on the PR: `aihub pr changes`.
3. Write only what is new to a file, keeping tested facts honest.
4. Add it to one section, or replace only the sections you changed (the story link, commits and related PRs are kept by the CLI):

```sh
aihub pr update --section Changes --append-file add.md
aihub pr update --body-file pr.md   # pr.md holds only the changed sections
```

Never copy the whole template into the body file. Example: after a fix commit, `git push`, then `aihub pr update --section Changes --append-file add.md`.

## What the CLI fills
PR id from the current branch, title, template sections, links to the story. Do not ask the user for the PR id.

## If it fails
No PR for this branch: follow pr-create. Error unclear: run `aihub doctor`. Never invent ids or links.

Rules: direct command, 0 questions. Language follows the team template. Local git uses your own tools.
