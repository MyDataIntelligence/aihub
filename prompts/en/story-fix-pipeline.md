---
title: Fix Red Pipeline
slash: /story-fix-pipeline
goal: A green pipeline for the story's PR.
reads: The log of the red run.
produces: A fix, pushed, followed until green.
---
# Fix Red Pipeline
Make the pipeline of story #{{story.id}} ({{branch}}) green.

## Do
1. `aihub pipeline status` and `aihub pipeline logs --failed`: read the first real error.
2. Fix the cause in the code (never weaken the pipeline definition or a test), run the targeted test, commit and push
   with aihub.
3. Follow the new run: `aihub watch --pr <n> --notify`.
4. The same error three rounds in a row: stop and ask how to go on.

## Limits
{{limits}}
