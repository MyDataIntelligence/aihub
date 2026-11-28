---
title: Explain Story / What's Left
slash: /story-explain
goal: The state of the story and what is left.
reads: The story, the criteria with status, the set, the PR and the pipeline.
produces: A short overview in plain words; nothing is changed.
---
# Explain Story / What's Left
Explain in plain words what story #{{story.id}} {{story.title}} asks and what is left. Change nothing.

## Read
- `aihub stories show --id {{story.id}}`, `aihub criteria status --id {{story.id}}`, `aihub status`.

## Deliver
At most 10 lines: what the story asks, what is done (commits, PR, pipeline), which criteria are proven and which are not,
and the next step.

## Limits
{{limits}}
