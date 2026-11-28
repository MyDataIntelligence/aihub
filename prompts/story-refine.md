---
title: Refine with Agent
slash: /story-refine
goal: Beschrijving, criteria en taken volgens het teamtemplate.
reads: De story, de lege secties van het template.
produces: Een voorstel per deel; de gebruiker kiest wat wordt toegepast.
---
# Refine with Agent
Verfijn {{story.type}} #{{story.id}} {{story.title}}. Schrijf niets naar Azure DevOps.

## Doe
1. Vraag het voorstelbestand op: `aihub stories refine-ask --id {{story.id}}` (het antwoord noemt `proposalFile` en de gaten).
2. Schrijf per deel dat je wilt veranderen een `## <kop>` uit het teamtemplate, en `## Tasks` met een regel `- <taak>` per
   nieuwe taak. Houd de feiten van de huidige tekst; laat delen weg die je niet zou veranderen.
3. Acceptatiecriteria krijgen per criterium `Hoe getest:` en `Bewijs:` eronder.
4. Antwoord daarna alleen "Voorstel klaar" en stop.

## Grenzen
{{limits}}
