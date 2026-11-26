---
name: pipeline-fix
description: "Use when a build or pipeline failed: 'waarom is de pipeline rood', 'waarom faalt de build', '/fix <run url>', 'pipeline is rood', 'fix the build', 'de build faalt', 'tests falen in CI', a failed check on a pull request."
---
# Diagnose or fix a failing run

## When
Explain, repair or monitor a failed run.

## Steps
1. Read the failing step: `aihub pipeline logs --failed --run 123`. Follow a wrapper failure to its child activity, exception or artifact. For an explanation, report the observed error and location and stop.
2. For a repair, inspect an existing working implementation. Choose the smallest check that answers the open question: an existing test, a temporary probe using the real helper, or one scenario. Match the failing input, runtime, dependency features and identity where relevant. Reproduce the failure and rerun that check after the fix when feasible. Keep tests meaningful. Use a topic branch and PR for protected branches.
3. Commit the fix with `aihub commit --type fix --subject "handle empty input"`. Add `--push` when ready. Check whether the push already triggered the intended run. Before queuing an expensive run inspect `aihub pipeline run-again --run 123 --plan`: verify repositories, branch, revision, parameters and scope against the request. Record actual checked-out revisions from the run where available. Broaden validation when the remaining question involves several components.
4. For example, after verifying the latest commit and the original parameters, run `aihub pipeline run-again --run 123 --commit latest`. For a requested replay of the same revision use `--commit same`. Retry transient infrastructure once without code changes.
5. For "monitor until finished", use `aihub pipeline follow --run 124` with the returned ID. Report changed state, evidence and remaining uncertainty. Resume authorized repairs after side requests.

## What the CLI fills
Run context, log tail, queue result.

## If it fails
After a timeout or stopped watcher, check run status and resume.
