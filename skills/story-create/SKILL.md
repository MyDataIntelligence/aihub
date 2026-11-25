---
name: story-create
description: "Use when the user wants a new user story or work item created: 'create a story', 'maak een story', 'nieuwe story', 'schrijf een story voor ...', '/story'."
---
# Create a story

## When
The user describes new work and wants it in Azure DevOps.

## Steps
1. Print the team story template: `aihub story template`. Its `##` headings are the sections to write, in the team's language. That is the only read: do not open `team.yaml`, the asset templates or the PR template yourself. Its first line names the template used (repo file, Azure DevOps or built-in); built-in means the team has none: say so in your report.
2. Write `story.md` with your file-write tool, not a shell heredoc (heredocs differ per shell and are refused by some). Use exactly the template headings, in that order. Fill EVERY section from what the user said: the user-story sentence in the template's own form, at least two verifiable acceptance criteria as bullets, and the team's "nothing to add" word where nothing applies.
3. Create it:

```sh
aihub story create --title "<short title>" --body-file story.md
```

A bug or task instead: `aihub workitem create --type Bug --title "..." --body-file bug.md [--parent 123]`. Report the id and link the CLI prints. Do not ask questions. Then stop: starting or building the story is a separate request.

Example: "maak een story voor CSV-export" -> `aihub story template`, then the file filled in with the template's headings and `aihub story create --title "CSV-export van het rapport" --body-file story.md`.

## What the CLI fills
Work item type, area and iteration, parent link and tags come from `team.yaml` (`workItems`). Sections you leave out become the team's empty text.

## If it fails
Missing field or template error: run `aihub doctor`, fix the file, retry once. Never invent a work item id or link.

Done is done: end with the result and at most one statement about the next step, never with a question.
