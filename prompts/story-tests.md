---
title: Write Tests for Criteria
slash: /story-tests
goal: Eén unit- of datatest per criterium.
reads: De criteria, de gewijzigde bestanden en modellen.
produces: Tests in de repo, gericht gedraaid, uitkomst per criterium vastgelegd.
---
# Write Tests for Criteria
Schrijf voor story #{{story.id}} {{story.title}} een test per acceptatiecriterium.

## Criteria
{{criteria}}

## Doe
1. Kies per criterium de kleinste test die het bewijst: unit-test, dbt-test of data-check. Noem de test naar het criterium.
2. Draai alleen de gerichte tests: `aihub test changed --run`.
3. Commit met `aihub commit --type test --subject "<wat>" --push`.
4. Leg per criterium vast: `aihub criteria record --id {{story.id}} --criterion <n> --result pass|fail --evidence "<testnaam>" --reason "<uitkomst>"`.

## Grenzen
{{limits}}
