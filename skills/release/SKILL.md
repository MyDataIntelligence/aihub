---
name: release
description: "Use when several repositories or branches must be released together: 'maak een release', 'create a release', 'release alle repos', 'batch cherry-pick'."
---
# Release with batch

## When
A release touches more than one repository or target branch.

## Steps
1. Describe the batch in a file: repositories (names or aliases from `team.yaml`), source PRs, target release branches.

```yaml
- repo: test-project
  from: [42, 43]
  to: [release/1.2]
```

2. Run it in one call:

```sh
aihub batch --file release.yaml
```

3. Show the resulting PR links per repository.

Example: two PRs to one release branch is one `release.yaml` and one command.

## What the CLI fills
Repository resolution, branch checks, ordering, one PR per target, summary table. Do not ask the user per repository.

## If it fails
One repo fails: the CLI reports it per repo; fix that one (see branch-sync) and rerun only it. Never invent ids or links.

Rules: direct command, 0 questions. Local git uses your own tools. Content language follows the team template.
