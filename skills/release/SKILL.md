---
name: release
description: "Use when stories or PRs must be released: 'maak een release', 'release story 12 en 13 naar main en staging', 'release train', 'release alle repos', 'batch cherry-pick', '/release'."
---
# Release

## When
Merged work goes to a release branch, to several target branches, or to several repositories together.

## Steps
1. Release train in one repository: plan first.

```sh
aihub release plan --stories 12,13 --target main --also-cherry-pick-to staging --out plan.yaml
```

   `--prs`, `--stories`, `--commits` and `--tags v1,v2` (commits between two tags, or the one tag) can be mixed; `--version 1.2.0` names the branch `release/1.2.0`, cut from the target.
2. Show the plan (PRs in merge order, targets, skipped PRs with the reason). Ask once only when something was skipped.
3. Run it: `aihub release run --plan-file plan.yaml`. It makes a release branch per target, cherry-picks, pushes and opens a PR per target.
4. A few PRs to one existing release branch: `aihub cherry-pick --from 42,43 --to release/1.2 --pr`.
5. Many PRs, branches or repositories: `aihub batch --select "ids:42,43" --run "cherry-pick --from {target} --to release/1.2 --pr"`.
6. Show the resulting PR links; follow them with pr-watch.

Example: "release 12 en 13 naar main en staging" is the plan above, then `aihub release run --plan-file plan.yaml`.

## What the CLI fills
Merge commits of the PRs, release branch names, the PR template, story links and a per-step result. A conflict stops that target only and names the files.

## If it fails
Resolve a conflict by hand (see branch-sync), then rerun with a new `--name`; for batch use `aihub batch --retry-failed <batchId>`. Never force-push, never invent ids or links.

Rules: direct commands, 0 questions beyond skipped PRs. Local git uses your own tools. Content language follows the team template.
