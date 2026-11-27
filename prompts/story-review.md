---
title: Review Pull Request Comments
slash: /story-review
goal: Elke reviewthread beantwoord of verwerkt.
reads: De open threads van de PR van de story.
produces: Antwoorden en fixes, threads op opgelost.
---
# Review Pull Request Comments
Verwerk de reviewthreads van de pull request van story #{{story.id}} ({{branch}}).

## Doe
1. `aihub comments get` toont de open threads met hun context.
2. Per thread: pas de code aan of leg uit waarom niet. Commit met `aihub commit ... --push`.
3. Beantwoord en sluit in één keer: `aihub comments reply --replies-file replies.yaml` (status fixed, wontFix of closed).
4. Raakt een fix een criterium, test dat criterium opnieuw en leg de uitkomst vast met `aihub criteria record`.

## Grenzen
{{limits}}
