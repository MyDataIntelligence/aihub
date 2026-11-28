---
title: Define Acceptance Criteria
slash: /story-criteria
goal: Toetsbare acceptatiecriteria, elk met Hoe getest en Bewijs.
reads: De story, de huidige criteria en het teamtemplate.
produces: Een voorstel in het voorstelbestand; de gebruiker vinkt aan wat wordt opgeslagen.
---
# Define Acceptance Criteria
Stel toetsbare acceptatiecriteria voor voor story #{{story.id}} {{story.title}}. Schrijf niets naar Azure DevOps.

## De story
- Beschrijving: {{story.description}}
- Huidige criteria:
{{criteria}}
- Taken: {{tasks}}
Meer is niet nodig; lees de story niet opnieuw.

## Doe
1. Maak van elk criterium een waarneembaar resultaat. Vage woorden ("snel", "goed", "netjes") worden een getal of een
   concrete uitkomst; kun je dat niet zelf bepalen, schrijf dan de vraag erbij.
2. Geef elk criterium twee regels eronder:
   - `Hoe getest:` Fabric-run, data-check (met query en verwachte uitkomst), unit-test of handmatig (wie bevestigt wat).
   - `Bewijs:` wat als bewijs telt (runlink, query en uitkomst, testnaam, reactie op de story).
3. Schrijf het voorstel naar het bestand dat `aihub criteria proposal-file --id {{story.id}}` noemt, in dit formaat:
   ```
   1. <criterium>
      Hoe getest: <soort>: <hoe>
      Bewijs: <wat>
   ```
4. Toon het voorstel als genummerde lijst (criterium, hoe getest, bewijs), in het {{language}}, en stop. Opslaan doet de
   gebruiker: in de story-browser, of hier door de nummers te noemen; dan voer je uit
   `aihub criteria apply --id {{story.id}} --rev {{story.rev}} --take <nummers>`.

## Grenzen
{{limits}}
