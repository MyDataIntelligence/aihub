---
title: Run End to End
slash: /story-run
goal: Een groene pull request naar {{target}} met alle acceptatiecriteria bewezen.
reads: De story, de criteria met Hoe getest en Bewijs, de set en team.yaml.
produces: Plan, commits, tests per criterium, een PR met de criteriatabel, een eerlijk eindrapport.
---
# Goal
Maak {{story.type}} #{{story.id}} {{story.title}} af volgens de definition of done hieronder en lever een groene pull request
naar {{target}}. Werk zelfstandig, rapporteer eerlijk en stop bij de stopregels.

## Context
- Story: #{{story.id}} {{story.title}} ({{story.state}}, {{story.iteration}}) in {{story.project}}, toegewezen aan {{story.assignedTo}}.
- Link: {{story.url}}
- Feature-branch: {{branch}}. Doel-branch: {{target}}.
- Repos: {{repos}}
- Fabric-workspace van de feature: {{workspace}}. Alleen daar mag je draaien.
- Acceptatiecriteria uit Azure DevOps, elk met Hoe getest en Bewijs:
{{criteria}}
- Taken: {{tasks}}

## Definition of done
Klaar is pas klaar als alles hieronder waar is. Is iets niet waar, zeg dat; maak het niet mooier.
1. Acceptatiecriteria: elk criterium is toetsbaar en heeft Hoe getest en Bewijs.
   - Is een criterium vaag ("snel", "goed")? Scherp het eerst aan en leg het mij voor. Bouw niet door.
   - Ontbreekt Hoe getest of Bewijs, of zijn er geen criteria: stel ze voor met /story-criteria {{story.id}} en wacht op mijn OK.
2. Per criterium een eigen test: een unit- of integratietest, een Fabric-run in {{workspace}}, of een data-check met query
   en verwachte uitkomst. Geen criterium zonder test.
3. Draai alleen de gerichte tests (de bestanden en modellen die je raakt), niet de hele suite: `aihub test changed --run`.
4. Commits maak je met aihub, klein, met het storynummer in het bericht: `aihub commit --type <type> --subject "<wat>" --push`.
5. Leg per criterium de uitkomst vast: `aihub criteria record --id {{story.id}} --criterion <n> --result pass|fail --evidence <link> --reason "<waarom>"`.
   Een criterium dat niet draaide blijft "nog niet uitgevoerd". Verzin nooit een uitkomst.
6. Een pull request naar {{target}} volgens het teamtemplate, in het {{language}}, zonder technische ruis: `aihub pr create`.
   De sectie Acceptatiecriteria maakt aihub zelf uit de criteria en hun teststatus. Is niet alles bewezen, dan maak je de PR
   alleen als concept (`--draft`) en zeg je wat ontbreekt.
7. De pipeline van de PR is groen. Volg hem met `aihub watch --pr <n> --notify`; rood: lees het log, fix, push, opnieuw.
8. Reviewthreads zijn verwerkt: beantwoord elke thread of pas de code aan, en zet hem op opgelost.
9. Rapportage: PR-link, pipeline, criteria (x van {{criteria.count}} bewezen), wat niet is uitgevoerd en waarom.

## Plan first
Toon eerst een plan: stappen per repo, de criteria per stap en de tests. Wacht op mijn OK.
Wijkt de uitvoering later af van het plan, meld dat voordat je verdergaat.

## Voortgang
Meld elke stap met `aihub story progress --id {{story.id}} --step <k> --total <n> --label "<stap>"` (stappen: plan, bouwen,
gerichte tests, Fabric-test per criterium, pull request, pipeline, reviewthreads, rapport). Aan het eind: `--done`.

## Stopregels
- Dezelfde fout drie rondes achter elkaar: stop, toon de fout en de stand, vraag hoe verder.
- Een aanmeldprobleem (`aihub doctor`) of een conflict dat je niet veilig kunt oplossen: stop en toon de exacte fout.
- Twijfel over wat de story vraagt: vraag het, gok niet.

## Grenzen
{{limits}}
