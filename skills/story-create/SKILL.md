---
name: story-create
description: "Use when the user wants a new user story or work item created: 'create a story', 'maak een story', 'nieuwe story', 'schrijf een story voor ...', '/story'."
---
# Create a story

## When
The user describes new work and wants it in Azure DevOps.

## Steps
1. Write the story text into a file following the team story template ([default](../_shared/assets/story-template.md), or the team's own copy). Fill only what the user said; leave unknown sections empty.
2. Run one command:

```sh
aihub story create --title "Export report as CSV" --body-file story.md
```

A bug or task instead: `aihub workitem create --type Bug --title "..." --body-file bug.md [--parent 123]` (templates [bug](../_shared/assets/bug-template.md), [task](../_shared/assets/task-template.md); `workItems.templates` in `team.yaml`).

3. Report the id and link the CLI prints. Do not guess them.

Example: "maak een story voor CSV-export" gives `aihub story create --title "CSV-export van het rapport" --body-file story.md` and then the printed id.

## What the CLI fills
Work item type, area and iteration, parent link, tags and the template skeleton come from `team.yaml` (`workItems`). Do not ask the user about template sections.

## If it fails
Missing field or template error: run `aihub doctor`, fix the file, retry once. Never invent a work item id or link.

Rules: a direct command is done at once with 0 questions. Write in the template language (for example Dutch). Local git uses your own tools.
