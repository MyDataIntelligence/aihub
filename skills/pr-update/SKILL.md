---
name: pr-update
description: "Use when an open pull request needs new content: 'update de PR', 'werk de PR bij', 'voeg onder <sectie> toe', a dev.azure.com pullrequest link, '/pr-update'."
---
# Update a pull request

## When
Update a PR section or verify existing criteria.

## Steps
For an explicit edit to one named section, apply it directly. For evidence against existing criteria, reviewer feedback or linked results, first read the current description with `aihub pr explain --pr 42` and the referenced source. Preserve numbering, team headings, manual prose and existing evidence links. Check which revision each result covers after a push.

Pair each relevant change with its expected behavior and the observation or artifact that proves it. A sentence is enough for a small change. For several independent points, use one row per point. Distinguish local, component and integration results; mark missing evidence. Keep the current run status in one place.

Compose the edited section in a file, retaining its other entries. Example:

```sh
aihub pr update --pr 42 --section "Verification" --replace-file evidence.md
```

For a short literal addition use `--append-text`; long additions take `--append-file`. Use the actual team heading. For an actual run record, `aihub pr tests add --from-run 123` adds a sourced row; reference existing rows when updating criteria.

For user actions run `aihub pr impact`, then specify affected files, old and new fields and how to check. Check instructions against the current contract. Use `--as-is` only when requested. With configured dataChecks refresh figures after a data-changing push using `aihub pr data-diff --write`. Keep detail in linked artifacts if the description is full.

## What the CLI fills
The PR and its current sections.

## If it fails
On an authentication error run `aihub doctor`.
