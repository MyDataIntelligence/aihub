---
title: Reproduce
slash: /bug-reproduce
goal: The bug reproduced as Repro Steps describe.
reads: Repro Steps, System Info, the feature workspace.
produces: What happens, with proof; nothing is fixed.
---
# Reproduce
Reproduce Bug #{{story.id}} {{story.title}}. Fix nothing yet.

## Read
- `aihub stories show --id {{story.id}}` (Repro Steps, System Info, Severity).

## Do
1. Follow the Repro Steps, locally or in {{workspace}}.
2. Record what happens against what is expected, with proof (query and outcome, run link, error message).
3. Put your finding as a comment on the bug (`aihub stories comment --id {{story.id}} --text-file <file>`) and say whether
   it can be reproduced.

## Limits
{{limits}}
