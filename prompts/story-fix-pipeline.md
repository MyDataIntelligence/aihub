---
title: Fix Red Pipeline
slash: /story-fix-pipeline
goal: Een groene pipeline voor de PR van de story.
reads: Het log van de rode run.
produces: Een fix, gepusht, gevolgd tot groen.
---
# Fix Red Pipeline
Maak de pipeline van story #{{story.id}} ({{branch}}) groen.

## Doe
1. `aihub pipeline status` en `aihub pipeline logs --failed`: lees de eerste echte fout.
2. Fix de oorzaak in de code (nooit de pipeline-definitie of een test verzwakken), draai de gerichte test, commit en push
   met aihub.
3. Volg de nieuwe run: `aihub watch --pr <n> --notify`.
4. Dezelfde fout drie rondes achter elkaar: stop en vraag hoe verder.

## Grenzen
{{limits}}
