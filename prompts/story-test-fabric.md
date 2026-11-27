---
title: Test on Fabric
slash: /story-test-fabric
goal: Bewijs per criterium dat de feature werkt, met een link naar het bewijs.
reads: De criteria met Hoe getest en Bewijs; de feature-workspace uit team.yaml.
produces: Een tabel criterium, hoe getest, uitkomst, link; de teststatus op de story.
---
# Test on Fabric
Test story #{{story.id}} per criterium in de workspace van de featurebranch.

## Lees
- de criteria van de story met "Hoe getest" en "Bewijs":
{{criteria}}
- de workspace van de featurebranch: {{workspace}}

## Doe
1. Zoek de workspace {{workspace}}. Bestaat die niet: stop en meld het.
2. Synchroniseer de branch {{branch}} en draai wat "Hoe getest" noemt (`aihub fabric run`, `aihub fabric sql`).
3. Voer per criterium de check uit: query met verwachte uitkomst, of de run.
4. Leg per criterium vast: `aihub criteria record --id {{story.id}} --criterion <n> --result pass|fail --evidence <link> --reason "<uitkomst>"`.

## Lever
Een tabel: criterium, hoe getest, uitkomst, link. Elk criterium krijgt een uitkomst; schrijf "nog niet uitgevoerd" als iets
niet draaide. `aihub criteria status --id {{story.id}}` toont de stand.

## Grenzen
{{limits}}
