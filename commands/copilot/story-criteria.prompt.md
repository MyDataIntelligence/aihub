---
mode: agent
description: "Define Acceptance Criteria (story id)"
---
Run `aihub prompt render story-criteria --id ${input:args:story id}` and carry out the prompt it prints as your task, exactly as written (it is the team's prompt for this action, filled in with the story). Load no skill first: the prompt is the whole task.
If the command fails, show its error and stop.
