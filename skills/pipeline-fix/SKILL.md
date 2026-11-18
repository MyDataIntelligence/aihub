---
name: pipeline-fix
description: "Use when a build or pipeline failed: '/fix <run url>', 'pipeline is rood', 'fix the build', 'de build faalt', 'tests falen in CI', a failed check on a pull request, a Fabric run that failed on your branch."
---
# Fix a failing run

## When
`/fix <run url or id>` (the Fix button of a watch toast), or the user says a build or Fabric run is red. Works without a story.

## Steps
1. Facts: `aihub pipeline logs --failed --run <url|id>` (no run: the newest failed run of this branch). Line 1 names the branch, whether it is protected and the red rounds in a row. Fabric run: `aihub fabric failures`.
2. The team may know it: `aihub fix known --run <id>`. A match is the fix to try first.
3. STOP and report, no fix, when line 1 says so (protected branch such as main, staging, release/*; or 3 red rounds).
4. Name the root cause in one sentence. Flaky or infrastructure (agent offline, quota, timeout): report it, `aihub pipeline retry --run <id>` once at most, change no code.
5. Otherwise fix the cause on the own branch, never weaken a test; check with `aihub test changed --run`, never the whole suite.
6. `aihub commit --type fix --subject "<what>" --push`, then `aihub watch --run <new run id> --notify` (`aihub pipeline runs --top 1` gives the id). Say "ik volg het op de achtergrond" and end your turn; `aihub pipeline follow` only when the user asks to wait.
7. Red again: back to step 1. After the third red round stop and report what you tried.
8. Green after a non-obvious fix: ask the user once, then `aihub fix remember --error "<error line>" --fix "<1-3 lines>"` (a pull request; never without a yes).

```sh
aihub pipeline logs --failed --run "https://dev.azure.com/org/proj/_build/results?buildId=123"
aihub commit --type fix --subject "handle empty export" --push
aihub watch --run 124 --notify
```

## What the CLI fills
Branch, protected flag, red rounds, failing step and log tail, story id from the branch name.

## If it fails
Not signed in: `aihub doctor`. Never push to main, staging or release, never force-push, never invent links.

Rules: 0 questions. Commit messages follow the team language.
