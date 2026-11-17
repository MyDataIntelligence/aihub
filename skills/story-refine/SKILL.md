---
name: story-refine
description: "Use when an existing story must be refined or completed: 'refine story 123', 'verfijn deze story', 'vul de acceptatiecriteria aan', a dev.azure.com _workitems link, '/refine'."
---
# Refine a story

## When
A story exists but sections are vague, empty or missing.

## Steps
1. Read it: `aihub story show 123`.
2. Draft a proposal per template section in a file, using only facts from the story, the repo and what the user said. Mark guesses as open points.
3. Show the proposal per section to the user and wait for a yes. This is the one step where you ask.
4. After yes, apply it:

```sh
aihub story refine 123 --body-file refined.md
```

Example: the user says "verfijn 123". Run `aihub story show 123`, show the proposal, and after "ja" run `aihub story refine 123 --body-file refined.md`.

## What the CLI fills
Template headings, field mapping, history comment and links. Do not ask the user which sections exist.

## If it fails
Unknown id or no access: run `aihub doctor`, report the error text. Never invent ids or links.

Rules: write in the template language. Do not change code in this skill. Local git uses your own tools.
