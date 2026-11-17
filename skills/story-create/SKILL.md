---
name: story-create
description: "Use when the user wants a new user story or work item created: 'create a story', 'maak een story', 'nieuwe story', 'schrijf een story voor ...', '/story'."
---
# Create a story

## When
The user describes new work and wants it in Azure DevOps.

## Steps
Write the story file and run the command in ONE shell call. Use the section headings of the team story template (`.agents/skills/_shared/assets/story-template.md` in the repo; the sections are usually Context, user story sentence, Acceptance criteria, Out of scope). Fill EVERY section from what the user said: the user story sentence in the template's form and at least two verifiable acceptance criteria as bullets; write "n.v.t." where nothing applies. Team language.

```sh
cat > story.md <<'EOS'
## Context
<why, for whom>

## Gebruikersverhaal
Als <rol> wil ik <doel>, zodat <reden>.

## Acceptatiecriteria
- <criterion 1>
- <criterion 2>

## Buiten scope
n.v.t.
EOS
aihub story create --title "<short title>" --body-file story.md
```

A bug or task instead: `aihub workitem create --type Bug --title "..." --body-file bug.md [--parent 123]`. Report the id and link the CLI prints. Do not ask questions.

Example: "maak een story voor CSV-export" -> the file above filled in, then `aihub story create --title "CSV-export van het rapport" --body-file story.md`.

## What the CLI fills
Work item type, area and iteration, parent link and tags come from `team.yaml` (`workItems`).

## If it fails
Missing field or template error: run `aihub doctor`, fix the file, retry once. Never invent a work item id or link.
