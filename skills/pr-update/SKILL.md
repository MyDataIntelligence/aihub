---
name: pr-update
description: "Use when an open pull request needs new content: 'update de PR', 'werk de PR bij', 'voeg onder <sectie> toe', a dev.azure.com pullrequest link, '/pr-update'."
---
# Update a pull request

## When
Update a PR section or verify existing criteria.

## Steps
For an explicit edit to one named section, apply it directly. For evidence against existing criteria, reviewer feedback or linked results, first read the current description with `aihub pr explain --pr 42` and the referenced source. Preserve numbering, team headings, manual prose and existing evidence links.

Keep to the headings the PR already has (or the team template): the CLI leaves others out and warns. Write short, for the reviewer. A test section holds only functional tests that were really done, with their result, or one line "Not run yet."; never unit-test counts, pre-push or environment problems, tools that could not run, runs without an outcome or internal coordination (the CLI refuses them). Keep the current run status in one place. Compose the edited section in a file, retaining its other entries. Example:

```sh
aihub pr update --pr 42 --section "Tests" --replace-file evidence.md
```

For a short literal addition use `--append-text`; long additions take `--append-file`. Use the actual team heading. For an actual run record, `aihub pr tests add --from-run 123` adds a sourced row; reference existing rows when updating criteria.

For user actions run `aihub pr impact`, then specify affected files, old and new fields and how to check. Check instructions against the current contract. Use `--as-is` only when requested. With configured dataChecks refresh figures after a data-changing push using `aihub pr data-diff --write`. Keep detail in linked artifacts if the description is full.

## What the CLI fills
The PR and its current sections.

## If it fails
On an authentication error run `aihub doctor`.
