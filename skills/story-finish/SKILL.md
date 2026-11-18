---
name: story-finish
description: "Use when the work is merged and the story must be closed: 'rond story 123 af', 'finish story 123', 'ruim de branches op', 'complete the PR', '/finish'."
---
# Finish a story

## When
The pull request is approved or merged and the user wants the story closed and the leftovers removed.

## Steps
1. PR not merged yet: `aihub pr checks --pr 42` lists what blocks completion. If the user wants it merged: `aihub pr complete --pr 42 --auto --squash`. Policies stay required; auto-complete merges when they pass. Add `--delete-source` when the user asks.
2. Preview the cleanup: `aihub story finish --id 123 --dry-run`.
3. Run it after the PR is merged:

```sh
aihub story finish --id 123
```

4. Report per repository what was removed and what was kept, and the story state.

Example: "rond 123 af" after the merge is `aihub story finish --id 123`. Add `--repos repo-a,repo-b` for several repositories.

## What the CLI fills
It deletes only merged local and remote branches, removes their clean worktrees, and sets the story to the finished state of `team.yaml` (`workItems.states.finished`, default Done) when everything is merged. Another state: `aihub workitem state --id 123 --to Resolved`.

## If it fails
A branch is kept with the reason (not merged, uncommitted changes, extra commits): show it and do not force anything. Never delete by hand what the CLI kept.

Rules: no questions. Never discard local changes.
