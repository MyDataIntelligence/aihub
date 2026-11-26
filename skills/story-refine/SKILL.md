---
name: story-refine
description: "Use when an existing story, bug or task must be refined or completed: 'refine story 123', 'verfijn deze bug', 'werk story 123 uit', 'vul de acceptatiecriteria aan', a dev.azure.com _workitems link, '/refine'."
---
# Refine a story, bug or task

## When
A work item exists but sections are vague, empty or missing.

## Steps
1. Read it: `aihub story show --id 123`. It prints the template headings and, under "Current text (not in template form)", any text written outside them: those are the facts to keep. You need nothing else: no `--help`, no `team.yaml`, no template file.
2. Write `refined.md` with one `## ` section per template heading shown, using only facts from the story, the repo and what the user said. Mark guesses as open points.
3. The user said "zet het er meteen in", "direct" or similar: apply at once. Otherwise show the proposal per section and wait for one yes.
4. Apply:

```sh
aihub story refine --id 123 --body-file refined.md
```

5. Report the story link and the changed sections in one line and stop.

Example: "verfijn 123 en zet het er meteen in" is `aihub story show --id 123`, write `refined.md`, `aihub story refine --id 123 --body-file refined.md`: two calls.

## What the CLI fills
Template of the item's type (story, Bug or Task), the field that holds its text (a Bug keeps it in Repro steps, not Description), history comment and links. Sections left out of `refined.md` stay as they are. `--id 123` and a bare `123` both work. The line says when the built-in template was used; if the team just added one in Azure DevOps, run again with `--refresh-template`.

## If it fails
Unknown id or no access: run `aihub doctor`, report the error text. Never invent ids or links.

Rules: write in the template language. Do not change code in this skill. Local git uses your own tools.

Done is done: end with the result and at most one statement about the next step, never with a question.
