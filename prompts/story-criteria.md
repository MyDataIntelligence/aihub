---
title: Define Acceptance Criteria
slash: /story-criteria
goal: Toetsbare acceptatiecriteria, elk met Hoe getest en Bewijs.
reads: De story, de huidige criteria en het teamtemplate.
produces: Een voorstel in het voorstelbestand; de gebruiker vinkt aan wat wordt opgeslagen.
---
# Define Acceptance Criteria
Stel toetsbare acceptatiecriteria voor voor {{story.type}} #{{story.id}} {{story.title}}. Schrijf niets naar Azure DevOps.

## Lees
- De story: `aihub stories show --id {{story.id}}` (beschrijving, huidige criteria, taken).
- Huidige criteria:
{{criteria}}

## Doe
1. Maak van elk criterium een waarneembaar resultaat. Vage woorden ("snel", "goed", "netjes") worden een getal of een
   concrete uitkomst; kun je dat niet zelf bepalen, schrijf dan de vraag erbij.
2. Geef elk criterium twee regels eronder:
   - `Hoe getest:` Fabric-run, data-check (met query en verwachte uitkomst), unit-test of handmatig (wie bevestigt wat).
   - `Bewijs:` wat als bewijs telt (runlink, query en uitkomst, testnaam, reactie op de story).
3. Bij een Bug: criteria voor wat na de fix aantoonbaar goed moet gaan, inclusief het geval uit Repro Steps.
4. Schrijf het voorstel naar het bestand dat `aihub criteria proposal-file --id {{story.id}}` noemt, in dit formaat:
   ```
   1. <criterium>
      Hoe getest: <soort>: <hoe>
      Bewijs: <wat>
   ```
5. Antwoord daarna alleen "Voorstel klaar" en stop. De gebruiker vinkt in de story-browser aan wat wordt opgeslagen.

## Grenzen
{{limits}}
