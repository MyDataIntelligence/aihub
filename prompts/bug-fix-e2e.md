---
title: Fix End to End
slash: /bug-fix-e2e
goal: Een groene pull request met de fix en bewezen criteria.
reads: De bug, Repro Steps, de criteria en de set.
produces: Reproductie, fix, test per criterium, PR, eerlijk rapport.
---
# Fix End to End
Los Bug #{{story.id}} {{story.title}} op tot een groene pull request naar {{target}}.

## Context
- Branch: {{branch}}. Repos: {{repos}}. Workspace: {{workspace}}.
- Criteria (wat na de fix aantoonbaar goed moet gaan):
{{criteria}}

## Definition of done
1. Reproduceer eerst (/bug-reproduce {{story.id}}). Niet te reproduceren: stop en meld wat je zag.
2. Ontbreken criteria: stel ze voor met /story-criteria {{story.id}} en wacht op mijn OK.
3. Een test die faalt zonder de fix en slaagt met de fix; alleen gerichte tests.
4. Commits met aihub; per criterium de uitkomst vastleggen met `aihub criteria record`.
5. `aihub pr create`; niet alles bewezen: alleen als concept, en zeg wat ontbreekt.
6. Pipeline groen, reviewthreads verwerkt, rapport met PR-link en x van {{criteria.count}} bewezen.

## Grenzen
{{limits}}
