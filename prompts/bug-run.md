---
title: Fix End to End
slash: /bug-run
goal: Een groene pull request met de fix, aantoonbaar zoals Repro Steps verwacht.
reads: De bug, Repro Steps, System Info en de set.
produces: Reproductie, fix, een test die het bewijst, PR, eerlijk rapport.
---
# Fix End to End
Los Bug #{{story.id}} {{story.title}} op tot een groene pull request naar {{target}}.

## Context
- Branch: {{branch}}. Repos: {{repos}}. Workspace: {{workspace}}.
- Lees de bug met `aihub stories show --id {{story.id}}` (Repro Steps, verwacht en werkelijk resultaat, System Info, Severity).

## Definition of done
1. Reproduceer eerst (/bug-reproduce {{story.id}}). Niet te reproduceren: stop en meld wat je zag.
2. Een test die faalt zonder de fix en slaagt met de fix (het geval uit Repro Steps); alleen gerichte tests:
   `aihub test changed --run`.
3. Commits met aihub: `aihub commit --type fix --subject "<wat>" --push`.
4. `aihub pr create` met in de tests het geval uit Repro Steps en de uitkomst; verzin nooit een uitkomst.
5. Pipeline groen (`aihub watch --pr <n> --notify`), reviewthreads verwerkt, rapport met PR-link, wat de fix bewijst en
   wat niet is uitgevoerd.

## Grenzen
{{limits}}
