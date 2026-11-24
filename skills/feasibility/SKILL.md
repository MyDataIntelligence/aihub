---
name: feasibility
description: "Use when the user asks whether something is possible or how it could work in Fabric, Azure DevOps, dbt or CI/CD, even without the word 'kan-dit': 'kan ik in Fabric ...', 'kan een pipeline een notebook starten', 'is het mogelijk om', 'werkt X samen met Y', 'zoek uit of', 'hoe zou dat kunnen', 'can I ... from a pipeline', 'is it possible to', '/kan-dit', '/can-it'. Research with aihub probes and keep a report; never answer from memory."
---
# Is this possible? Research it, then answer

## When
A question about what Fabric or Azure DevOps can do. Research it with the CLI, never answer from memory, and always end with a saved report. Do not read `team.yaml`: the CLI applies it.

## Steps
1. Probe, read-only, one or two commands: `aihub probe api --get <docs url>` (prints the page's main text), `aihub probe fabric capacity --feature <name>`, `aihub probe fabric endpoint workspaces/{workspace}/<path>`, `aihub probe devops feature pipelines`. Add what you know from Microsoft Learn and the REST reference, each with a link.
2. Write `report.md` in the team language with exactly these headings (no template call needed): `# <question>`, `## Verdict` (Ja/Nee/Deels), `## Hoe`, `## Bewijs` (probe command and YES/NO/UNKNOWN), `## Waar hoort het: Fabric, DevOps/CI-CD of beide?` (`### Fabric`, `### Azure DevOps`, `### Samen`, ending "Advies: ..."; see `references/where.md`), `## Bronnen` (link and date), `## Grenzen en risico's`, `## Inschatting inspanning`, `## Open vragen`. Mark what has no source `niet geverifieerd`.
3. `aihub research save --file report.md` checks the headings and keeps it. `--wiki <page>` only after a yes.
4. Answer in the chat with the verdict and the "how" in a few lines. A proof of concept only after a yes, in an `aihub-test-dev-*` workspace.

## What the CLI fills
Probes use the user's sign-in and print YES, NO or UNKNOWN with the raw status, never item contents. A docs page gives its main content, without menus.

## If it fails
Not signed in: `aihub doctor`. UNKNOWN is not NO: report a 403 as open. A missing heading: save names it, add it and save again.

## Example
"Kan een DevOps-pipeline een Fabric-notebook starten?"
```sh
aihub probe api --get https://learn.microsoft.com/fabric/data-engineering/notebook-public-api
aihub research save --file report.md
```
Two calls; the verdict and the how come from the probe text.
