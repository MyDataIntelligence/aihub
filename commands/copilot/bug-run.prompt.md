---
mode: agent
description: "Fix End to End (bug id)"
---
Run `aihub prompt render bug-run --id ${input:args:bug id}` and carry out the prompt it prints as your task, exactly as written (it is the team's prompt for this action, filled in with the bug). Load no skill first: the prompt is the whole task.
If the command fails, show its error and stop.
