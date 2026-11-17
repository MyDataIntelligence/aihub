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
3. Rewrite the description file from the template so it matches the current diff, keeping tested facts honest.
4. Run:

```sh
aihub pr update --body-file pr.md
```

Example: after a fix commit, `git push`, then `aihub pr update --body-file pr.md`.

## What the CLI fills
PR id from the current branch, title, template sections, links to the story. Do not ask the user for the PR id.

## If it fails
No PR for this branch: follow pr-create. Error unclear: run `aihub doctor`. Never invent ids or links.

Rules: direct command, 0 questions. Language follows the team template. Local git uses your own tools.
