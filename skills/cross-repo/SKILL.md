---
name: cross-repo
description: "Use when a change or test resource must reach another repository: 'zet deze wijziging ook in repo X', 'port naar developers', 'maak de testresources in ...', 'port this to the other repo', 'how are the PRs of this story doing across repos', 'koppel de PRs'."
---
# Work across repositories

## When
The same change must also land in a second repository whose paths differ, test resources must be copied into another repository's active branch, or a story spans several repositories.

## Steps
Repositories, path maps and the test target come from `team.yaml` (`repositories[]`, `crossRepo`). When the sentence names the repositories or target, run the command at once; never ask.

1. Port a change (PR, commits or all merged PRs of a story) with path mapping, into a new branch `port/<source>-from-<repo>` of the other repo:

```sh
aihub port --from-repo test-project --from 42 --to-repo test-developers --map dev --pr --body-file pr-body.md
```

2. Test resources into the other repo's active branch, then its pipeline:

```sh
aihub crossrepo test-resources --from-repo test-project --to-repo test-developers --target integration --paths "tests/data/**" --run-pipeline test-developers-robot
```

3. Story spanning repos: `aihub crossrepo status --story 7`, then `aihub crossrepo link-prs --story 7`.

Example: "zet PR 42 ook in test-developers" gives the first command; show the new PR link and the files that were not ported.

## What the CLI fills
Clone location, default target branch, isolated worktree (your checkout is never touched), path rewriting, commit message, push, PR template, work item link, related-PR sections. Defaults for `--map`, `--target`, `--paths` come from `crossRepo`.

## If it fails
Conflict: nothing was pushed; the files are named. Port them by hand in a worktree of the other repo with your own tools. Unmapped files are listed, never dropped silently: add a `--path-map` or tell the user. Protected target: use `--pr` or another branch. Details: [reference](references/cross-repo.md).

Rules: direct command, 0 questions. Prose goes in files (`--body-file`, `--message-file`).
