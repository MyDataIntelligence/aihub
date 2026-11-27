---
title: Explain Story / What's Left
slash: /story-explain
goal: De stand van de story en wat er nog moet.
reads: De story, de criteria met teststatus, de set, de PR en de pipeline.
produces: Een kort overzicht in gewone woorden; er wordt niets veranderd.
---
# Explain Story / What's Left
Leg in gewone woorden uit wat story #{{story.id}} {{story.title}} vraagt en wat er nog moet. Verander niets.

## Lees
- `aihub stories show --id {{story.id}}`, `aihub criteria status --id {{story.id}}`, `aihub status`.

## Lever
Maximaal 10 regels: wat de story vraagt, wat al gedaan is (commits, PR, pipeline), welke criteria bewezen zijn en welke
niet, en de eerstvolgende stap.

## Grenzen
{{limits}}
