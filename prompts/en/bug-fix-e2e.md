---
title: Fix End to End
slash: /bug-fix-e2e
goal: A green pull request with the fix and proven criteria.
reads: The bug, Repro Steps, the criteria and the set.
produces: Reproduction, fix, a test per criterion, PR, an honest report.
---
# Fix End to End
Fix Bug #{{story.id}} {{story.title}} up to a green pull request to {{target}}.

## Context
- Branch: {{branch}}. Repos: {{repos}}. Workspace: {{workspace}}.
- Criteria (what must provably work after the fix):
{{criteria}}

## Definition of done
1. Reproduce first (/bug-reproduce {{story.id}}). Cannot reproduce: stop and say what you saw.
2. Criteria missing: propose them with /story-criteria {{story.id}} and wait for my OK.
3. A test that fails without the fix and passes with it; only targeted tests.
4. Commits with aihub; record the outcome per criterion with `aihub criteria record`.
5. `aihub pr create`; not all proven: only as a draft, and say what is missing.
6. Pipeline green, review threads handled, a report with the PR link and x of {{criteria.count}} proven.

## Limits
{{limits}}
