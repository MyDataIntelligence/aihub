---
name: pipeline-fix
description: "Use when a build or pipeline failed: 'pipeline is rood', 'fix the build', 'de build faalt', 'tests falen in CI', a failed check on a pull request."
---
# Fix a failing pipeline

## When
`aihub pipeline follow` or the PR reports a failed run.

## Steps
1. Get the failing stage and log excerpt: `aihub pipeline follow`.
   More log: `aihub pipeline logs --run <id> --search "<text>"`; earlier runs: `aihub pipeline runs`.
2. Reproduce locally with your own tools if cheap: the failing test or `aihub test changed --run`, never the whole suite.
3. Fix the cause, not the check. Never weaken a test.
4. Commit per the commit template, push the own branch with git.
5. A flaky or infrastructure failure needs no code change: `aihub pipeline retry --run <id>` re-runs the failed stage; `aihub pr checks --pr 42` shows what blocks the PR and `aihub pr requeue --pr 42 --policy build` re-queues a failed build policy.
6. Follow again until green:

```sh
aihub pipeline follow
```

Example: a red unit test gives a code fix, `git commit`, `git push`, `aihub pipeline follow`.

## What the CLI fills
Run id, failing step, trimmed log. Do not ask the user for run ids.

## If it fails
Log truncated or not signed in: `aihub doctor`. Infrastructure error (agent offline, quota): report it as such, do not change code. Never invent links.

Rules: direct task, 0 questions. Local git uses your own tools. Commit messages follow the team language.
