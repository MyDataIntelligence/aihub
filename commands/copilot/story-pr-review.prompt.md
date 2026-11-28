---
mode: agent
description: "Review Pull Request Comments (story id)"
---
Run `aihub prompt render story-pr-review --id ${input:args:story id}` and carry out the prompt it prints as your task, exactly as written (it is the team's prompt for this action, filled in with the story).
If the command fails, show its error and stop.
