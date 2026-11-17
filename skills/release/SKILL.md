---
name: release
description: "Use when several repositories or branches must be released together: 'maak een release', 'create a release', 'release alle repos', 'batch cherry-pick'."
---
# Release with batch

## When
A release touches more than one pull request or target branch.

## Steps
1. In each repository checkout, one call for all PRs and target branches:

```sh
aihub cherry-pick --from 42,43 --to release/1.2 --pr
```

2. Many separate PRs or branches: one batch call, 4 in parallel, one result table:

```sh
aihub batch --select "ids:42,43" --run "cherry-pick --from {target} --to release/1.2 --pr"
```

3. Show the resulting PR links.

Example: two PRs to one release branch is one `aihub cherry-pick` call.

## What the CLI fills
Branch checks, ordering, one PR per target, summary table. Do not ask the user per target.

## If it fails
One target fails: the CLI reports it per target; fix that one (see branch-sync), or rerun only the failed ones with `aihub batch --retry-failed <batchId>`. Never invent ids or links.

Rules: direct command, 0 questions. Local git uses your own tools. Content language follows the team template.
