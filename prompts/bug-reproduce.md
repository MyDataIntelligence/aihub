---
title: Reproduce
slash: /bug-reproduce
goal: De bug reproduceren zoals Repro Steps beschrijft.
reads: Repro Steps, System Info, de feature-workspace.
produces: Wat er gebeurt, met bewijs; er wordt niets gefixt.
---
# Reproduce
Reproduceer Bug #{{story.id}} {{story.title}}. Fix nog niets.

## Lees
- `aihub stories show --id {{story.id}}` (Repro Steps, System Info, Severity).

## Doe
1. Volg de Repro Steps, lokaal of in {{workspace}}.
2. Leg vast wat er gebeurt tegenover wat verwacht wordt, met bewijs (query en uitkomst, runlink, foutmelding).
3. Zet je bevinding als comment op de bug (`aihub stories comment --id {{story.id}} --text-file <bestand>`) en meld of hij
   te reproduceren is.

## Grenzen
{{limits}}
