---
title: Create / Update Pull Request
slash: /story-pr
goal: Een pull request volgens het teamtemplate, met de criteriatabel.
reads: De commits, het teamtemplate, de criteria en hun teststatus.
produces: Een PR (of concept) naar de doel-branch, zonder technische ruis.
---
# Create / Update Pull Request
Maak of werk de pull request bij voor story #{{story.id}} {{story.title}} van {{branch}} naar {{target}}.

## Doe
1. Schrijf alleen de koppen van het teamtemplate, kort en voor de reviewer, in het {{language}}. Geen unit-testaantallen,
   geen omgevingsproblemen, geen interne afstemming.
2. `aihub pr create --body-file <bestand>` (bestaat de PR al, dan werkt hetzelfde commando hem bij). De sectie
   Acceptatiecriteria en "N/M bewezen" maakt aihub zelf.
3. Zijn niet alle criteria bewezen, dan stopt aihub met de keuzes: eerst testen (/story-test-fabric {{story.id}}), als
   concept (`--draft`) of toch (`--anyway`).{{#if draft}} Ik koos: als concept; gebruik `--draft`.{{/if}}{{#if anyway}} Ik koos: toch maken; gebruik `--anyway`.{{/if}}{{#if askChoice}} Leg de keuze aan mij voor; kies niet zelf `--anyway`.{{/if}}
4. Meld de PR-link en hoeveel criteria bewezen zijn.

## Grenzen
{{limits}}
