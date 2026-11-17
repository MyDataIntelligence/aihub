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

If the user says "laat het me weten", "hou het in de gaten" or "let me know when it is done", start a background watch instead and carry on; it ends by itself:

```sh
aihub watch --pr 42 --until done --notify
```

`--until comment` or `vote` waits for a new review comment or vote. It shows an OS notification and writes `.git/aihub/events.log`; `aihub watch list` and `aihub watch stop` manage it. Without `--notify` read the log.

While waiting, do not poll by hand and do not start other work on the same branch; `pipeline follow` returns when the run is finished. Report the final state in one short line per check.

Example: the link `.../pullrequest/42` gives `aihub pipeline follow --pr 42`.

## What the CLI fills
Branch, PR id, build id, log excerpt of the failing step. Do not ask the user for them.

## If it fails
Not signed in or no PR found: run `aihub doctor`. Report what the CLI printed; never guess a status.

Rules: direct command, 0 questions. Local git uses your own tools. Never invent ids or links.
