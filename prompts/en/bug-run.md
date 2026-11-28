---
title: Fix End to End
slash: /bug-run
goal: A green pull request with the fix, provably as Repro Steps expect.
reads: The bug, Repro Steps, System Info and the set.
produces: Reproduction, fix, a test that proves it, PR, an honest report.
---
# Fix End to End
Fix Bug #{{story.id}} {{story.title}} up to a green pull request to {{target}}.

## Context
- Branch: {{branch}}. Repos: {{repos}}. Workspace: {{workspace}}.
- Read the bug with `aihub stories show --id {{story.id}}` (Repro Steps, expected and actual result, System Info, Severity).

## Definition of done
1. Reproduce first (/bug-reproduce {{story.id}}). Cannot reproduce: stop and say what you saw.
2. A test that fails without the fix and passes with it (the case from Repro Steps); only targeted tests:
   `aihub test changed --run`.
3. Guidelines: before your first edit `aihub guidelines show --paths <files>`, before every commit and the PR `aihub guidelines check`; fix what it lists. Commits with aihub: `aihub commit --type fix --subject "<what>" --push`.
4. `aihub pr create` with the case from Repro Steps and its outcome in the tests; never invent an outcome.
5. Pipeline green (`aihub watch --pr <n> --notify`), review threads handled, a report with the PR link, what the fix proves
   and what did not run.

## Limits
{{limits}}
