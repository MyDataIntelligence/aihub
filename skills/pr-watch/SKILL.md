---
name: pr-watch
description: "Use when a PR or build must be followed: 'watch the PR', 'volg de build', 'is de pipeline groen', '/watch', a dev.azure.com pullrequest link."
---
# Watch a PR or pipeline

## When
After creating or updating a PR, or when the user gives a PR link or id.

## Steps
1. Follow the checks until they finish:

```sh
aihub pipeline follow
```

2. Show state, failed stage and open review threads: `aihub work` (all my PRs) and `aihub comments get`.
3. Green and no open threads: say so. Red: follow pipeline-fix. New comments: follow review-process.

While waiting, do not poll by hand and do not start other work on the same branch; `pipeline follow` returns when the run is finished. Report the final state in one short line per check.

Example: the link `.../pullrequest/42` gives `aihub pipeline follow --pr 42`.

## What the CLI fills
Branch, PR id, build id, log excerpt of the failing step. Do not ask the user for them.

## If it fails
Not signed in or no PR found: run `aihub doctor`. Report what the CLI printed; never guess a status.

Rules: direct command, 0 questions. Local git uses your own tools. Never invent ids or links.
