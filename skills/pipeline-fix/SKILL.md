---
name: pipeline-fix
description: "Use when a build or pipeline failed: '/fix <run url>', 'pipeline is rood', 'fix the build', 'de build faalt', 'tests falen in CI', a failed check on a pull request, a Fabric run that failed on your branch."
---
# Fix a failing run

## When
`/fix <run url or id>` (the Fix button of a watch toast), or the user says a build or Fabric run is red. Works without a story.

## Steps
1. Facts first: `aihub pipeline logs --failed --run <url|id>` (no run: the newest failed run of this branch). The first line names the branch, whether it is protected and how many runs in a row are red. A Fabric run: `aihub fabric failures`.
2. Stop and report, no fix, when the line says STOP (protected branch such as main, staging, release/*; or 3 red rounds).
3. Name the root cause in one sentence. Flaky or infrastructure (agent offline, quota, timeout without code cause): report it, `aihub pipeline retry --run <id>` once at most, change no code.
4. Otherwise fix the cause on the own branch, never weaken a test; check with `aihub test changed --run`, never the whole suite.
5. `aihub commit --type fix --subject "<what>" --push`, then `aihub pipeline follow`.
6. Red again: back to step 1 (a new round). After the third red round stop and report what you tried.

```sh
aihub pipeline logs --failed --run "https://dev.azure.com/org/proj/_build/results?buildId=123"
aihub commit --type fix --subject "handle empty export" --push
aihub pipeline follow
```

## What the CLI fills
Branch, protected flag, red-round count, failing step and log tail, story id from the branch name.

## If it fails
Not signed in: `aihub doctor`. Never push to main, staging or release, never force-push, never invent links.

Rules: 0 questions. Commit messages follow the team language.
