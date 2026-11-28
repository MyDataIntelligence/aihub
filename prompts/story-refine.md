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
1. `aihub stories refine-ask --id {{story.id}}`: het antwoord heeft `proposalFile`, de gaten en de huidige secties. Lees de
   story niet opnieuw.
2. Schrijf per deel dat je wilt veranderen een `## <kop>` uit het teamtemplate, en `## Tasks` met een regel `- <taak>` per
   nieuwe taak. Houd de feiten van de huidige tekst; laat delen weg die je niet zou veranderen.
3. Acceptatiecriteria krijgen per criterium `Hoe getest:` en `Bewijs:` eronder.
4. Toon per deel het voorstel naast de huidige tekst, in het {{language}}, en stop. Toepassen doet de gebruiker: in de
   story-browser, of hier door de delen te noemen; dan voer je uit
   `aihub stories refine-apply --id {{story.id}} --rev {{story.rev}} --parts <description,criteria,tasks,...>`.

## Grenzen
{{limits}}
